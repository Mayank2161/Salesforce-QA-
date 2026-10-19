import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.ts";
import { QA_TEMPLATES_DIR } from "../src/paths.ts";
import { ProjectError, ProjectStore, checkFolderName, orgFolderName } from "../src/projects/store.ts";
import { workspaceRoot } from "../src/projects/workspace-root.ts";
import { QaWorkspace } from "../src/reports/workspace.ts";
import { RunStore } from "../src/runs/store.ts";

const TMCDEV = { id: "drive-energy-4828-tmcdev", name: "DRIVE-ENERGY-4828 - TMCDEV" };
const UAT = { id: "drive-energy-4828-uat", name: "DRIVE-ENERGY-4828 - UAT" };
const TOKEN = "test-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let projects: ProjectStore;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "sfqa-projects-"));
  projects = new ProjectStore(join(dir, "QA-Workspace"), QA_TEMPLATES_DIR);
  await projects.ensure();
});
after(() => rm(dir, { recursive: true, force: true }));

const code = (err: unknown) => (err as ProjectError).code;

describe("folder names", () => {
  test("project and org names become safe folder names", () => {
    assert.equal(checkFolderName("  Big   Top ", "Project"), "Big Top");
    assert.equal(checkFolderName("RMS", "Project"), "RMS");
    for (const bad of ["", "   ", "../x", "a/b", "a\\b", "CON", "nul.txt", "x.", ".hidden", "a:b", "x".repeat(61), "a*b"]) {
      assert.throws(() => checkFolderName(bad, "Project"), (e) => code(e) === "invalid_name", JSON.stringify(bad));
    }
  });

  test("an org's folder is the environment part of its name", () => {
    assert.equal(orgFolderName("DRIVE-ENERGY-4828 - TMCDEV"), "TMCDEV");
    assert.equal(orgFolderName("RMS - UAT"), "UAT");
    assert.equal(orgFolderName("Acme Production"), "Acme Production");
    assert.equal(orgFolderName("x - a/b:c"), "a-b-c");
  });

  test("the workspace root is configurable but never a drive root", () => {
    assert.equal(workspaceRoot(undefined, dir), join(dir, "QA-Workspace"));
    assert.equal(workspaceRoot("D:\\QA", dir), "D:\\QA");
    assert.throws(() => workspaceRoot("C:\\", dir), /drive root/);
  });
});

describe("projects and org folders", () => {
  test("projects are created on demand; names are unique regardless of case", async () => {
    await projects.create("RMS");
    await projects.create("Big Top");
    await assert.rejects(projects.create("rms"), (e) => code(e) === "project_exists");
    assert.deepEqual((await projects.list()).map((p) => p.name), ["Big Top", "RMS"]);
    assert.ok(existsSync(join(projects.projectsDir, "Big Top", "project.json")));
  });

  test("adding an org creates its three sections with report pages; adding it again changes nothing", async () => {
    const first = await projects.addOrg("RMS", TMCDEV);
    assert.equal(first.folder, "TMCDEV");
    const again = await projects.addOrg("rms", TMCDEV);
    assert.deepEqual(again, first);
    await projects.addOrg("RMS", UAT);
    await projects.addOrg("Big Top", TMCDEV);

    for (const env of ["TMCDEV", "UAT"]) {
      const base = join(projects.projectsDir, "RMS", env);
      assert.deepEqual((await readdir(base)).sort(), ["Bug Reports", "Notes", "Test Execution Reports"]);
      for (const f of ["Test Execution Reports/Test_Execution_Report.html", "Test Execution Reports/execution-data.js", "Bug Reports/Bug_Report.html", "Bug Reports/bug-data.js"]) {
        assert.ok(existsSync(join(base, f)), `${env}/${f}`);
      }
    }
    assert.deepEqual((await projects.get("RMS")).orgs.map((o) => o.folder), ["TMCDEV", "UAT"]);
    await assert.rejects(projects.addOrg("Nope", TMCDEV), (e) => code(e) === "unknown_project");
  });

  test("report pages link to their sibling folders and the shared assets", async () => {
    const page = await readFile(join(projects.projectsDir, "RMS", "TMCDEV", "Test Execution Reports", "Test_Execution_Report.html"), "utf8");
    assert.match(page, /src="\.\.\/Bug Reports\/bug-data\.js"/);
    assert.match(page, /src="\.\.\/\.\.\/\.\.\/\.\.\/assets\/qa-status\.js"/);
    const bugs = await readFile(join(projects.projectsDir, "RMS", "TMCDEV", "Bug Reports", "Bug_Report.html"), "utf8");
    assert.match(bugs, /href="\.\.\/Test Execution Reports\/Test_Execution_Report\.html"/);
    assert.doesNotMatch(bugs, /reviews\//);
    assert.ok(existsSync(join(projects.root, "assets", "qa-status.js")));
  });

  test("each run gets its own folder and record; bugs and evidence go to Bug Reports; orgs stay separate", async () => {
    const tmc = await projects.workspace("RMS", TMCDEV.id);
    const uat = await projects.workspace("RMS", UAT.id);
    const id = await tmc.nextRunId(new Date(2026, 9, 19));
    assert.equal(id, "RUN-20261019-001");
    assert.equal(tmc.screenshotsDir(id), join(projects.projectsDir, "RMS", "TMCDEV", "Test Execution Reports", id));
    assert.equal(tmc.screenshotRef(id, "02_save.png"), `${id}/02_save.png`);
    await writeFile(join(tmc.screenshotsDir(id), "02_save.png"), "png");

    const bug = await tmc.addBug(
      { title: "Save fails", severity: "High", status: "Open", linkedRun: id, linkedTestCase: "TC_016", stepsToReproduce: [], expected: "e", actual: "a", reproducedIn: [], environment: TMCDEV.name },
      { displayId: id, screenshots: [{ file: "02_save.png", caption: "Error" }] },
    );
    assert.equal(bug.id, "BUG-001");
    assert.ok(existsSync(join(projects.projectsDir, "RMS", "TMCDEV", "Bug Reports", "BUG-001", `BUG-001_${id}_02_save.png`)));

    const record = { runId: id, testCaseId: "TC_016", title: "t", status: "FAIL", steps: [], screenshots: [{ file: `${id}/02_save.png`, caption: "c" }], bugs: ["BUG-001"], environment: TMCDEV.name };
    await tmc.appendExecution(record);
    const runFile = join(tmc.screenshotsDir(id), "execution.json");
    assert.equal(JSON.parse(await readFile(runFile, "utf8")).testCaseId, "TC_016");
    // A run's own record is never overwritten.
    await tmc.appendExecution({ ...record, testCaseId: "CHANGED" });
    assert.equal(JSON.parse(await readFile(runFile, "utf8")).testCaseId, "TC_016");

    // The next run gets a new number; UAT keeps its own reports and numbering.
    assert.equal(await tmc.nextRunId(new Date(2026, 9, 19)), "RUN-20261019-002");
    assert.equal((await uat.listBugs()).length, 0);
    const uatData = await readFile(join(projects.projectsDir, "RMS", "UAT", "Test Execution Reports", "execution-data.js"), "utf8");
    assert.match(uatData, /window\.TEST_EXECUTIONS = \[\];/);
  });

  test("notes are created, listed, edited and deleted as files in Notes/", async () => {
    const note = await projects.createNote("RMS", TMCDEV.id, { title: "Login issue", body: "Sales user cannot log in\nafter 5 pm." });
    assert.match(note.id, /^\d{8}-\d{6}-login-issue$/);
    const file = join(projects.projectsDir, "RMS", "TMCDEV", "Notes", `${note.id}.md`);
    assert.equal(await readFile(file, "utf8"), "# Login issue\n\nSales user cannot log in\nafter 5 pm.\n");

    const twin = await projects.createNote("RMS", TMCDEV.id, { title: "Login issue", body: "" });
    assert.notEqual(twin.id, note.id, "two notes with one title in the same second never overwrite each other");

    const edited = await projects.updateNote("RMS", TMCDEV.id, note.id, { title: "Login issue (fixed)", body: "Works now." });
    assert.equal(edited.title, "Login issue (fixed)");
    assert.equal(edited.body, "Works now.");
    assert.deepEqual((await projects.listNotes("RMS", UAT.id)), [], "notes belong to one org folder");

    await projects.deleteNote("RMS", TMCDEV.id, twin.id);
    assert.deepEqual((await projects.listNotes("RMS", TMCDEV.id)).map((n) => n.id), [note.id]);
    await assert.rejects(projects.deleteNote("RMS", TMCDEV.id, "../../project"), (e) => code(e) === "unknown_note");
    await assert.rejects(projects.createNote("RMS", TMCDEV.id, { title: " ", body: "x" }), (e) => code(e) === "invalid_note");
  });
});

describe("run ids", () => {
  test("are unique across the shared qa/ folder and every project's org folders", async () => {
    const base = await mkdtemp(join(tmpdir(), "sfqa-runids-"));
    try {
      const qaDir = join(base, "qa");
      const store = new ProjectStore(join(base, "QA-Workspace"), QA_TEMPLATES_DIR, { sharedRunsDir: join(qaDir, "Screenshots") });
      const qa = new QaWorkspace(qaDir, QA_TEMPLATES_DIR, undefined, { otherRunIds: () => store.runIds() });
      await store.ensure();
      await qa.ensure();
      await store.create("RMS");
      await store.addOrg("RMS", TMCDEV);
      await store.addOrg("RMS", UAT);
      const day = new Date(2026, 9, 19);
      const ids = [
        await (await store.workspace("RMS", TMCDEV.id)).nextRunId(day),
        await (await store.workspace("RMS", UAT.id)).nextRunId(day),
        await qa.nextRunId(day),
        await (await store.workspace("RMS", TMCDEV.id)).nextRunId(day),
      ];
      assert.deepEqual(ids, ["RUN-20261019-001", "RUN-20261019-002", "RUN-20261019-003", "RUN-20261019-004"]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("the shared qa/ folder", () => {
  test("updating report pages keeps an edited page as .bak and never touches data", async () => {
    const qaDir = join(dir, "qa");
    const qa = new QaWorkspace(qaDir, QA_TEMPLATES_DIR);
    await qa.ensure();
    const page = join(qaDir, "reports", "Test_Execution_Report.html");
    const data = join(qaDir, "reports", "execution-data.js");
    await writeFile(page, "<html>my edited page</html>");
    await writeFile(data, "// mine\nwindow.TEST_EXECUTIONS = [{\"runId\":\"RUN-20261001-001\"}];\n");
    await qa.ensure();
    assert.equal(await readFile(`${page}.bak`, "utf8"), "<html>my edited page</html>");
    assert.match(await readFile(page, "utf8"), /pickEnv/);
    assert.match(await readFile(data, "utf8"), /RUN-20261001-001/);
    assert.equal(qa.screenshotRef("RUN-20261001-001", "a.png"), "../Screenshots/RUN-20261001-001/a.png");
  });
});

describe("projects API", () => {
  let app: FastifyInstance;
  let store: RunStore;
  const opened: string[] = [];

  before(async () => {
    await writeFile(join(dir, "orgs.json"), JSON.stringify({ orgs: [TMCDEV, UAT].map((o) => ({ ...o, loginUrl: "https://test.salesforce.com", instanceUrl: "https://x.my.salesforce.com", personas: [] })) }));
    const qa = new QaWorkspace(join(dir, "qa"), QA_TEMPLATES_DIR);
    store = new RunStore();
    app = await buildApp({
      token: TOKEN, orgsConfigPath: join(dir, "orgs.json"), authDir: join(dir, "auth"), runsDir: join(dir, "runs"),
      store, qa, projects, openFolder: async (p) => { opened.push(p); }, logger: false,
    });
    await app.ready();
  });
  after(() => app.close());

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, headers: auth, ...(payload !== undefined && { payload: payload as object }) });

  test("create and list projects; invalid and duplicate names are refused", async () => {
    assert.equal((await call("POST", "/projects", { name: "Zwilling" })).statusCode, 201);
    assert.equal((await call("POST", "/projects", { name: "zwilling" })).statusCode, 409);
    assert.equal((await call("POST", "/projects", { name: "../../evil" })).statusCode, 400);
    const list = (await call("GET", "/projects")).json();
    assert.equal(list.root, projects.root);
    assert.ok(list.projects.some((p: { name: string }) => p.name === "Zwilling"));
  });

  test("add an org folder (unknown orgs and projects are 404)", async () => {
    const res = await call("POST", "/projects/Zwilling/orgs", { orgId: UAT.id });
    assert.equal(res.statusCode, 201);
    assert.equal(res.json().folder, "UAT");
    assert.equal((await call("POST", "/projects/Zwilling/orgs", { orgId: "nope" })).statusCode, 404);
    assert.equal((await call("POST", "/projects/Missing/orgs", { orgId: UAT.id })).statusCode, 404);
  });

  test("notes over HTTP", async () => {
    const base = `/projects/Zwilling/orgs/${UAT.id}/notes`;
    const created = await call("POST", base, { title: "Smoke plan", body: "1. Login" });
    assert.equal(created.statusCode, 201);
    const id = created.json().id;
    assert.equal((await call("PUT", `${base}/${id}`, { title: "Smoke plan v2", body: "1. Login\n2. Quote" })).json().title, "Smoke plan v2");
    assert.equal((await call("GET", base)).json().notes.length, 1);
    assert.equal((await call("DELETE", `${base}/${id}`)).statusCode, 204);
    assert.equal((await call("DELETE", `${base}/${id}`)).statusCode, 404);
    assert.equal((await call("GET", `/projects/Zwilling/orgs/${TMCDEV.id}/notes`)).statusCode, 404, "no folder for that org yet");
  });

  test("report links: a project's org folder, or the shared reports filtered to the org", async () => {
    const project = (await call("GET", `/reports/links?project=Zwilling&orgId=${UAT.id}`)).json();
    assert.match(project.executionReport, /\/ws\/[0-9a-f]{32}\/Projects\/Zwilling\/UAT\/Test%20Execution%20Reports\/Test_Execution_Report\.html$/);
    assert.match(project.bugReport, /\/Projects\/Zwilling\/UAT\/Bug%20Reports\/Bug_Report\.html$/);

    const shared = (await call("GET", `/reports/links?orgId=${UAT.id}`)).json();
    assert.match(shared.executionReport, /\/qa\/[0-9a-f]{32}\/reports\/Test_Execution_Report\.html\?env=DRIVE-ENERGY-4828%20-%20UAT$/);
    assert.match(shared.bugReport, /\?env=DRIVE-ENERGY-4828%20-%20UAT$/);

    // The page itself is served; anything outside the workspace is not.
    const page = await app.inject({ url: new URL(project.executionReport).pathname });
    assert.equal(page.statusCode, 200);
    assert.match(page.body, /Test Execution Report/);
    const key = /\/ws\/([0-9a-f]{32})\//.exec(project.executionReport)![1];
    assert.equal((await app.inject({ url: `/ws/${key}/..%2F..%2Forgs.json` })).statusCode, 404);
    assert.equal((await app.inject({ url: `/ws/${"0".repeat(32)}/assets/qa-status.js` })).statusCode, 404);
  });

  test("open shows only folders inside the workspace", async () => {
    const res = await call("POST", "/projects/Zwilling/open", { orgId: UAT.id, section: "Notes" });
    assert.equal(res.statusCode, 200);
    assert.equal(opened.at(-1), join(projects.projectsDir, "Zwilling", "UAT", "Notes"));
    assert.equal((await call("POST", "/projects/Zwilling/open", { section: "Secrets" })).statusCode, 400);
  });

  test("a run saved in a project serves its screenshots from that project's run folder", async () => {
    const ws = await projects.workspace("Zwilling", UAT.id);
    const run = store.create({ orgId: UAT.id, personaId: "p", testCase: { body: "x" }, project: "Zwilling" });
    const displayId = await ws.nextRunId();
    store.setDisplayId(run.id, displayId);
    store.setReports(run.id, { project: "Zwilling", folder: "UAT" });
    await mkdir(ws.screenshotsDir(displayId), { recursive: true });
    await writeFile(join(ws.screenshotsDir(displayId), "01_open.png"), "png-bytes");
    const res = await call("GET", `/runs/${run.id}/evidence/01_open.png`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, "png-bytes");
  });
});
