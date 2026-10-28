import { MAX_REQUIREMENTS_BYTES, REQUIREMENTS_EXTENSIONS, type Review, type SuiteCase } from "@sfqa/shared";
import { panelStorage, send } from "../messages.ts";
import { h } from "./dom.ts";

// Optional step in the upload tab: check the selected test cases against a BRD / requirement sheet.
// Claude reads both and judges each test case (correct, needs update, incorrect, not traceable) and
// lists requirements no test case covers. Nothing runs in Salesforce.

export interface ReviewContext {
  orgId(): string;
  // The valid, selected rows of the uploaded file.
  cases(): SuiteCase[];
  testCasesFileName(): string | undefined;
}

const POLL_MS = 3000;
const LAST_REVIEW_KEY = "lastReviewId";

export function createReviewPanel(ctx: ReviewContext): { element: HTMLElement; update(): void; resume(): Promise<boolean> } {
  let doc: File | undefined;
  let review: Review | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;

  const fileInput = h("input", { type: "file", accept: REQUIREMENTS_EXTENSIONS.join(","), hidden: true });
  const drop = h("div", { className: "drop small", tabIndex: 0 },
    h("div", { className: "drop-title", textContent: "\u{1F4C4} Add BRD / requirement sheet" }),
    h("div", { className: "hint", textContent: "PDF, Word (.docx), Excel (.xlsx), CSV, TXT or MD, up to 10 MB." }),
    fileInput,
  );
  const chosen = h("div", { className: "doc-chip", hidden: true });
  const message = h("div", { className: "suite-msg" });
  const actions = h("div", { className: "row end" });
  const progress = h("div", { className: "review-progress", hidden: true });
  const element = h("div", { className: "review" },
    h("div", { className: "review-head" },
      h("span", { textContent: "Check test cases against requirements" }),
      h("span", { className: "hint", textContent: "optional" }),
    ),
    h("div", { className: "hint", textContent: "Claude reads the requirements and checks that each selected test case is correct and traceable, then lists requirements that no test case covers. Nothing runs in Salesforce." }),
    drop, chosen, message, actions, progress,
  );

  drop.onclick = () => fileInput.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); };
  fileInput.onchange = () => { if (fileInput.files?.[0]) choose(fileInput.files[0]); fileInput.value = ""; };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    const file = e.dataTransfer?.files?.[0];
    if (file) choose(file);
  };

  function choose(file: File): void {
    const ext = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
    if (!(REQUIREMENTS_EXTENSIONS as readonly string[]).includes(ext)) {
      return showMessage("err", ext === ".doc" ? "Old Word .doc files are not supported. Save it as .docx or PDF." : `"${file.name}" is not a supported requirements file.`);
    }
    if (file.size > MAX_REQUIREMENTS_BYTES) return showMessage("err", "The requirements file is larger than 10 MB.");
    doc = file;
    showMessage("", "");
    update();
  }

  function update(): void {
    const running = review?.status === "running";
    drop.hidden = Boolean(doc);
    chosen.hidden = !doc;
    chosen.replaceChildren(...(doc ? [
      h("span", { className: "doc-name", textContent: `\u{1F4C4} ${doc.name}`, title: doc.name }),
      h("span", { className: "hint", textContent: size(doc.size) }),
      h("button", { className: "btn secondary", textContent: "Change", disabled: running, onclick: () => fileInput.click() }),
      h("button", { className: "btn secondary", textContent: "Remove", disabled: running, onclick: () => { doc = undefined; update(); } }),
    ] : []));
    const n = ctx.cases().length;
    actions.replaceChildren(h("button", {
      className: "btn small",
      textContent: running ? "Analysing…" : `Analyse ${n} test case${n === 1 ? "" : "s"}`,
      disabled: running || !doc || n === 0,
      title: !doc ? "Add the requirements document first." : n === 0 ? "Select at least one valid test case above." : "",
      onclick: () => void start(),
    }));
  }

  async function start(): Promise<void> {
    const cases = ctx.cases();
    if (!doc || cases.length === 0) return;
    showMessage("", `Uploading ${doc.name}…`);
    try {
      const fileName = ctx.testCasesFileName();
      review = await send({
        type: "startReview",
        request: {
          orgId: ctx.orgId(),
          ...(fileName && { testCasesFileName: fileName }),
          requirements: { fileName: doc.name, data: toBase64(await doc.arrayBuffer()) },
          cases: cases.map((c) => ({ tcId: c.tcId!, title: c.title, ...(c.module && { module: c.module }), body: c.body })),
        },
      });
    } catch (err) {
      return showMessage("err", (err as Error).message);
    }
    showMessage("", "");
    panelStorage.set({ [LAST_REVIEW_KEY]: review.id });
    render();
    watch();
  }

  function watch(): void {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!review) return clearInterval(poll);
      try {
        review = await send({ type: "getReview", id: review.id });
      } catch {
        return; // keep the last known state; the server may be busy
      }
      render();
      if (review.status !== "running") clearInterval(poll);
    }, POLL_MS);
  }

  function render(): void {
    update();
    if (!review) {
      progress.hidden = true;
      return;
    }
    const r = review;
    progress.hidden = false;
    const pct = r.total ? Math.round((r.reviewed / r.total) * 100) : 0;
    const head = r.status === "running"
      ? `${r.id}: reviewing against ${r.requirementsFileName}… ${r.reviewed} of ${r.total} test cases done.`
      : r.status === "error"
        ? `${r.id} could not finish: ${r.error ?? "unknown error"}`
        : `${r.id} finished: ${r.reviewed} of ${r.total} test cases reviewed against ${r.requirementsFileName}.`;
    const parts: HTMLElement[] = [h("div", { className: `suite-msg ${r.status === "error" ? "err" : r.status === "completed" ? "ok" : ""}`, textContent: head })];
    if (r.status === "running") {
      const fill = h("div", { className: "fill" });
      fill.style.width = `${Math.max(pct, 3)}%`;
      parts.push(h("div", { className: "bar" }, fill));
    }
    if (r.summary) {
      const s = r.summary;
      const stat = (label: string, value: number, cls = "") => h("div", { className: `stat ${cls}` }, h("div", { className: "v", textContent: String(value) }), h("div", { className: "l", textContent: label }));
      parts.push(h("div", { className: "stats" },
        stat("Correct", s.correct, "PASS"), stat("Needs update", s.needsUpdate, "BLOCKED"), stat("Incorrect", s.incorrect, "FAIL"), stat("Not traceable", s.notTraceable),
      ));
      if (r.status === "completed") {
        parts.push(h("div", { className: "hint", textContent: `Requirements with a test case: ${s.requirementsCovered} of ${s.requirements}. Coverage gaps with suggested new test cases: ${s.gaps}.` }));
      }
    }
    if (r.status === "running" && r.log.length) {
      parts.push(h("div", { className: "log" }, ...r.log.slice(-4).map((line) => h("div", { textContent: line }))));
    }
    if (r.status === "completed") {
      parts.push(h("div", { className: "row end" },
        h("button", { className: "btn small", textContent: "Open review report", onclick: () => void openReport(`#${r.id}`) }),
      ));
    }
    progress.replaceChildren(...parts);
  }

  async function openReport(hash: string): Promise<void> {
    try {
      const links = await send({ type: "getReportLinks" });
      window.open(`${links.reviewReport}${hash}`, "_blank");
    } catch (err) {
      showMessage("err", (err as Error).message);
    }
  }

  function showMessage(kind: "" | "ok" | "warn" | "err", text: string): void {
    message.className = `suite-msg ${kind}`;
    message.textContent = text;
  }

  // Picks a review back up after a page reload. Resolves true when there is one to show.
  async function resume(): Promise<boolean> {
    if (review) {
      render();
      return true;
    }
    const saved = await panelStorage.get(LAST_REVIEW_KEY);
    const id = saved[LAST_REVIEW_KEY] as string | undefined;
    if (!id) return false;
    try {
      review = await send({ type: "getReview", id });
    } catch {
      panelStorage.remove(LAST_REVIEW_KEY); // the server restarted and no longer knows it
      return false;
    }
    render();
    if (review.status === "running") watch();
    return true;
  }

  update();
  return { element, update: () => (review ? render() : update()), resume };
}

function size(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
