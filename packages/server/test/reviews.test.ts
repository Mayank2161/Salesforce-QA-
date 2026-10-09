import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import type { FastifyInstance } from "fastify";
import type { Org, StartReviewRequest } from "@sfqa/shared";
import { AgentBridge } from "../src/agent/bridge.ts";
import type { ClaudeRunResult, runClaude } from "../src/agent/claude.ts";
import { buildApp } from "../src/app.ts";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { QaWorkspace, type ReviewRecord } from "../src/reports/workspace.ts";
import { MAX_REQUIREMENTS_CHARS, RequirementsFileError, extractRequirements } from "../src/reviews/extract.ts";
import { ReviewService } from "../src/reviews/service.ts";
import { makeXlsx } from "./helpers/xlsx.ts";

const BRD = "BR-01 Five Below Flag defaults to False on new Accounts.\nBR-02 Sales users can edit Account Status.\nBR-03 Geography picklist: East, West.";

// --- Extracting text from requirements documents ----------------------------------------------

function docx(bodyXml: string): Buffer {
  const xml = `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${bodyXml}</w:body></w:document>`;
  return Buffer.from(zipSync({ "word/document.xml": strToU8(xml), "[Content_Types].xml": strToU8("<Types/>") }));
}
const p = (text: string, props = "") => `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ""}<w:r><w:t>${text}</w:t></w:r></w:p>`;

// A one-page PDF with real text objects, offsets computed so the xref table is valid.
function pdf(lines: string[]): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l}) Tj`).join(" ")} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => { offsets.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("extracting requirements", () => {
  test("plain text and markdown are read as is", async () => {
    assert.equal((await extractRequirements("brd.md", Buffer.from(`# BRD\r\n\r\n\r\n\r\n${BRD}`))).text, `# BRD\n\n${BRD}`);
  });

  test("CSV and Excel requirement sheets become one line per row", async () => {
    const csv = await extractRequirements("reqs.csv", Buffer.from("ID,Requirement\nBR-01,Five Below Flag defaults to False\nBR-02,Sales users can edit Account Status\n"));
    assert.match(csv.text, /^ID \| Requirement\nBR-01 \| Five Below Flag defaults to False\nBR-02/);
    const xlsx = await extractRequirements("reqs.xlsx", makeXlsx([["ID", "Requirement"], ["BR-01", "Five Below Flag defaults to False on new Accounts"]]));
    assert.match(xlsx.text, /## Sheet: .+\nID \| Requirement\nBR-01 \| Five Below Flag defaults to False on new Accounts/);
  });

  test("Word .docx keeps headings, list items and table rows", async () => {
    const { text } = await extractRequirements("brd.docx", docx(
      p("Account fields", '<w:pStyle w:val="Heading1"/>') +
      p("Five Below Flag defaults to False &amp; is hidden", "<w:numPr/>") +
      "<w:tbl><w:tr><w:tc>" + p("BR-03") + "</w:tc><w:tc>" + p("Geography picklist") + p("East, West") + "</w:tc></w:tr></w:tbl>" +
      p("Sales users can edit Account Status."),
    ));
    assert.equal(text, "# Account fields\n- Five Below Flag defaults to False & is hidden\nBR-03 | Geography picklist / East, West\nSales users can edit Account Status.");
  });

  test("PDF text is read page by page", async () => {
    const r = await extractRequirements("brd.pdf", pdf(["BR-01 Five Below Flag defaults to False.", "BR-02 Sales users can edit Account Status."]));
    assert.equal(r.pages, 1);
    assert.match(r.text, /--- Page 1 ---\nBR-01 Five Below Flag defaults to False\.\s*BR-02 Sales users can edit Account Status\./);
  });

  test("unsupported, unreadable, empty and oversized documents are refused with a clear reason", async () => {
    await assert.rejects(extractRequirements("brd.doc", Buffer.from("x")), /Old Word \.doc files are not supported/);
    await assert.rejects(extractRequirements("brd.pptx", Buffer.from("x")), /Unsupported file type "\.pptx"/);
    await assert.rejects(extractRequirements("brd.docx", Buffer.from("not a zip")), /not a readable Word \.docx/);
    await assert.rejects(extractRequirements("brd.pdf", Buffer.from("not a pdf")), RequirementsFileError);
    await assert.rejects(extractRequirements("blank.pdf", pdf([""])), /No readable text was found in this PDF/);
    await assert.rejects(extractRequirements("brd.txt", Buffer.from("  \n ")), /No readable text/);
    await assert.rejects(extractRequirements("brd.txt", Buffer.from("x".repeat(MAX_REQUIREMENTS_CHARS + 1))), /too long to review in one go/);
  });
});

// --- The review itself, with Claude replaced by a script of tool calls ------------------------

const org: Org = { id: "tmcdev", name: "TMCDEV", loginUrl: "https://a.my.salesforce.com", instanceUrl: "https://a.lightning.force.com", personas: [] };
const request: StartReviewRequest = {
  orgId: "tmcdev",
  testCasesFileName: "cases.xlsx",
  requirements: { fileName: "brd.txt", data: Buffer.from(BRD).toString("base64") },
  cases: [
    { tcId: "TC_010", title: "Five Below Flag default", module: "Account", body: "Steps: Create Account\nExpected Result: Five Below Flag is True" },
    { tcId: "TC_011", title: "Edit Account Status", module: "Account", body: "Steps: Edit Status\nExpected Result: Saved" },
    { tcId: "TC_099", title: "Delete Account", body: "Steps: Delete\nExpected Result: Deleted" },
  ],
};

type Call = [kind: string, body: unknown];
type Reply = { status: number; message: string };

// Plays tool calls through the bridge exactly as review-mcp would, using the run key from mcp.json.
function scripted(bridge: AgentBridge, calls: Call[], replies: Reply[], result: ClaudeRunResult = { ok: true, turns: 5 }, seen?: { prompt?: string; tools?: string[] }): typeof runClaude {
  return async (opts) => {
    if (seen) { seen.prompt = opts.prompt; seen.tools = opts.allowedTools; }
    const env = JSON.parse(await readFile(opts.mcpConfigPath, "utf8")).mcpServers.qa.env;
    for (const [kind, body] of calls) replies.push(await bridge.dispatch(env.SFQA_RUN_ID, env.SFQA_RUN_KEY, kind, body));
    return result;
  };
}

const reqs: Call = ["requirements", { requirements: [
  { id: "BR-01", title: "Five Below Flag default", detail: "Defaults to False" },
  { id: "BR-02", title: "Sales can edit Account Status" },
  { id: "BR-03", title: "Geography picklist values" },
] }];
const fix = { issues: [{ type: "Wrong expected result", detail: "BR-01 says False; the test expects True." }], suggestedExpected: "Five Below Flag is False" };

describe("review service", () => {
  let dir: string;
  let qa: QaWorkspace;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-review-"));
    qa = new QaWorkspace(join(dir, "qa"), QA_TEMPLATES_DIR);
    await qa.ensure();
  });
  after(() => rm(dir, { recursive: true, force: true }));

  const service = (bridge: AgentBridge, fake: typeof runClaude) => new ReviewService({
    bridge, qa, claude: { command: "claude", model: "sonnet", maxTurns: 10, timeoutMs: 1000 }, serverUrl: "http://127.0.0.1:1", reviewMcpScript: "review-mcp.ts", workDir: dir, runClaude: fake,
  });

  test("a full review validates each tool call and writes the report record", async () => {
    const bridge = new AgentBridge();
    const replies: Reply[] = [];
    const seen: { prompt?: string; tools?: string[] } = {};
    const svc = service(bridge, scripted(bridge, [
      ["verdict", { tcId: "TC_010", verdict: "Incorrect", requirementIds: ["BR-01"], summary: "Expects True", ...fix }],
      reqs,
      ["verdict", { tcId: "TC_404", verdict: "Correct", requirementIds: ["BR-01"], summary: "x" }],
      ["verdict", { tcId: "TC_010", verdict: "Correct", requirementIds: ["BR-09"], summary: "x" }],
      ["verdict", { tcId: "TC_010", verdict: "Correct", summary: "x" }],
      ["verdict", { tcId: "TC_010", verdict: "Incorrect", requirementIds: ["BR-01"], summary: "x" }],
      ["verdict", { tcId: "TC_099", verdict: "Not traceable", requirementIds: ["BR-01"], summary: "x" }],
      ["verdict", { tcId: "TC_010", verdict: "Incorrect", requirementIds: ["BR-01"], summary: "Expects True but BR-01 says False.", ...fix }],
      ["reviewDone", { summary: "Mostly sound.", gaps: [] }],
      ["verdict", { tcId: "TC_011", verdict: "Correct", requirementIds: ["BR-02"], summary: "Matches BR-02." }],
      ["verdict", { tcId: "TC_099", verdict: "Not traceable", summary: "No requirement covers deleting Accounts." }],
      ["reviewDone", { summary: "Mostly sound.", gaps: [{ requirementIds: ["BR-99"], gap: "x", suggestedTestCase: { title: "x", steps: "1", expected: "2" } }] }],
      ["reviewDone", { summary: "One test case contradicts BR-01; Geography is untested.", risks: ["Is Status editable by Sales Managers too?"], gaps: [
        { requirementIds: ["BR-03"], gap: "Geography values are never checked.", suggestedTestCase: { title: "Verify Geography picklist values", type: "Positive", steps: "1. Open an Account\n2. Open Geography", expected: "East, West" } },
      ] }],
      ["reviewDone", { summary: "again", gaps: [] }],
    ], replies, undefined, seen));

    const started = await svc.start(org, request, { text: BRD });
    assert.match(started.id, /^REV-\d{8}-001$/);
    assert.equal(started.status, "running");
    assert.equal(svc.busy(), true);
    await assert.rejects(svc.start(org, request, { text: BRD }), /already running/);
    await svc.wait(started.id);
    assert.equal(svc.busy(), false);

    assert.deepEqual(seen.tools, ["mcp__qa"]);
    assert.match(seen.prompt!, /<requirements_document name="brd.txt">\nBR-01 Five Below Flag/);
    assert.match(seen.prompt!, /<test_case id="TC_099">\nSteps: Delete/);
    assert.deepEqual(replies.map((r) => r.status), [422, 200, 422, 422, 422, 422, 422, 200, 422, 200, 200, 422, 200, 422]);
    assert.match(replies[0]!.message, /Call record_requirements first/);
    assert.match(replies[2]!.message, /"TC_404" is not one of the test cases/);
    assert.match(replies[3]!.message, /Unknown requirement ID\(s\): BR-09/);
    assert.match(replies[4]!.message, /must list the requirementIds/);
    assert.match(replies[5]!.message, /needs at least one issue and the corrected/);
    assert.match(replies[6]!.message, /leave requirementIds empty/);
    assert.match(replies[7]!.message, /Recorded TC_010 \(1 of 3\)\. Next: TC_011\./);
    assert.match(replies[8]!.message, /no verdict yet: TC_011, TC_099/);
    assert.match(replies[10]!.message, /All test cases are reviewed; call finish_review/);
    assert.match(replies[11]!.message, /Unknown requirement ID\(s\) in gaps: BR-99/);
    assert.match(replies[13]!.message, /already called/);

    const done = svc.get(started.id)!;
    assert.equal(done.status, "completed");
    assert.equal(done.reviewed, 3);
    assert.deepEqual(done.summary, { correct: 1, needsUpdate: 0, incorrect: 1, notTraceable: 1, requirements: 3, requirementsCovered: 1, gaps: 1 });

    const [record] = await qa.listReviews() as ReviewRecord[];
    assert.equal(record!.reviewId, started.id);
    assert.equal(record!.status, "Complete");
    assert.equal(record!.environment, "TMCDEV");
    assert.equal(record!.reviewedBy, "Claude Code (sonnet)");
    assert.deepEqual(record!.cases.map((c) => [c.tcId, c.verdict, c.requirementIds]), [["TC_010", "Incorrect", ["BR-01"]], ["TC_011", "Correct", ["BR-02"]], ["TC_099", "Not traceable", []]]);
    assert.equal((record!.cases[0] as unknown as { suggestedExpected: string }).suggestedExpected, "Five Below Flag is False");
    assert.equal((record!.gaps as { requirementIds: string[] }[])[0]!.requirementIds[0], "BR-03");
    // The per-review tool config is removed afterwards.
    assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith("review-")), []);
  });

  test("a review that stops part-way is saved as Incomplete; duplicate TC IDs keep separate verdicts", async () => {
    const bridge = new AgentBridge();
    const replies: Reply[] = [];
    const svc = service(bridge, scripted(bridge, [
      reqs,
      ["verdict", { tcId: "TC_010 (2)", verdict: "Correct", requirementIds: ["BR-01"], summary: "ok" }],
    ], replies, { ok: false, error: "Claude usage limit reached for your seat" }));
    const dup = { ...request, cases: [request.cases[0]!, request.cases[0]!] };
    const started = await svc.start(org, dup, { text: BRD });
    await svc.wait(started.id);
    assert.deepEqual(replies.map((r) => r.status), [200, 200]);
    const review = svc.get(started.id)!;
    assert.equal(review.status, "completed");
    assert.match(review.log.join("\n"), /usage limit[\s\S]*stopped early: 1 of 2/);
    const record = (await qa.listReviews()).find((r) => r.reviewId === started.id)!;
    assert.equal(record.status, "Incomplete");
    assert.deepEqual(record.cases.map((c) => [c.tcId, c.verdict]), [["TC_010", "Not reviewed"], ["TC_010 (2)", "Correct"]]);
    assert.match(String(record.summary), /stopped before finishing: 1 of 2/);
  });

  test("a review with no verdicts is an error and writes nothing", async () => {
    const bridge = new AgentBridge();
    const before = (await qa.listReviews()).length;
    const svc = service(bridge, scripted(bridge, [], [], { ok: false, error: "Could not start Claude Code" }));
    const started = await svc.start(org, request, { text: BRD });
    await svc.wait(started.id);
    assert.deepEqual([svc.get(started.id)!.status, svc.get(started.id)!.error], ["error", "Could not start Claude Code"]);
    assert.equal((await qa.listReviews()).length, before);
    // Its review ID is not used by a saved review, but it is not handed out twice either.
    assert.notEqual((await qa.nextReviewId()), started.id);
  });
});

// --- API ----------------------------------------------------------------------------------------

describe("review API", () => {
  const TOKEN = "test-token-0123456789";
  const auth = { authorization: `Bearer ${TOKEN}` };
  let dir: string;
  let app: FastifyInstance;
  let release!: () => void;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "sfqa-review-api-"));
    await writeFile(join(dir, "orgs.json"), JSON.stringify({ orgs: [org] }));
    const qa = new QaWorkspace(join(dir, "qa"), QA_TEMPLATES_DIR);
    await qa.ensure();
    const bridge = new AgentBridge();
    const reviews = new ReviewService({
      bridge, qa, claude: { command: "claude", model: "sonnet", maxTurns: 10, timeoutMs: 1000 }, serverUrl: "http://127.0.0.1:1", reviewMcpScript: "x", workDir: dir,
      runClaude: () => new Promise((resolve) => { release = () => resolve({ ok: false, error: "stopped" }); }),
    });
    app = await buildApp({ token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: dir, runsDir: dir, qa, bridge, reviews, logger: false });
    await app.ready();
  });
  after(async () => {
    release?.();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (payload: unknown) => app.inject({ method: "POST", url: "/reviews", headers: auth, payload: payload as object });

  test("needs the agent token", async () => {
    assert.equal((await app.inject({ method: "POST", url: "/reviews", payload: request })).statusCode, 401);
  });

  test("rejects invalid requests, unknown orgs and unreadable documents before starting", async () => {
    assert.equal((await post({ ...request, cases: [] })).statusCode, 400);
    assert.equal((await post({ ...request, orgId: "nope" })).statusCode, 404);
    const bad = await post({ ...request, requirements: { fileName: "brd.doc", data: "eA==" } });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.json().message, /Old Word \.doc/);
  });

  test("starts a review, reports progress, and refuses a second one while it runs", async () => {
    const res = await post(request);
    assert.equal(res.statusCode, 202);
    const review = res.json();
    assert.deepEqual([review.status, review.total, review.reviewed, review.requirementsFileName], ["running", 3, 0, "brd.txt"]);
    const busy = await post(request);
    assert.equal(busy.statusCode, 409);
    assert.equal(busy.json().error, "review_in_progress");
    const got = await app.inject({ url: `/reviews/${review.id}`, headers: auth });
    assert.equal(got.json().id, review.id);
    assert.equal((await app.inject({ url: "/reviews/REV-20260101-999", headers: auth })).statusCode, 404);
  });

  test("report links include the review page, which is served with the other reports", async () => {
    const links = (await app.inject({ url: "/reports/links", headers: auth })).json();
    assert.match(links.reviewReport, /\/reviews\/Test_Case_Review\.html$/);
    const page = await app.inject({ url: new URL(links.reviewReport).pathname });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Salesforce QA · Test Case Review/);
    const data = await app.inject({ url: new URL(links.reviewReport).pathname.replace("Test_Case_Review.html", "review-data.js") });
    assert.match(data.body, /window\.TEST_CASE_REVIEWS = \[\]/);
  });
});
