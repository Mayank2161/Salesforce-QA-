/// <reference lib="dom" />
// Generic browser actions for Salesforce (and any web app), run as one batch by the run_steps tool.
// They only speed up steps Claude has already decided on: no business logic lives here. Anything
// a step cannot do with certainty (element missing or ambiguous, unexpected dialog) stops the batch
// and hands the page state back to Claude, which continues with the normal browser tools.
import { join } from "node:path";
import type { Locator, Page } from "playwright";
import { z } from "zod";

// How a step names an element. Accessible names first; a snapshot ref or CSS selector when needed.
export const Target = z.object({
  ref: z.string().regex(/^[a-z0-9]+$/i).optional().describe("Element ref from the latest browser_snapshot, e.g. e123"),
  role: z.string().optional().describe("ARIA role, e.g. button, link, tab, menuitem, combobox, checkbox"),
  name: z.string().optional().describe("Accessible name for role, e.g. Save"),
  label: z.string().optional().describe("Form field label"),
  text: z.string().optional().describe("Visible text"),
  placeholder: z.string().optional(),
  selector: z.string().optional().describe("CSS selector, only when nothing accessible identifies the element"),
  exact: z.boolean().optional().describe("Exact name/text match (default: exact first, then contains if nothing matched)"),
  index: z.number().int().nonnegative().optional().describe("Pick the Nth visible match (0-based) when several match on purpose"),
  scope: z.string().optional().describe('Search inside the open dialog with this title, or "page" to ignore an open dialog'),
}).refine((t) => Boolean(t.ref || t.role || t.label || t.text || t.placeholder || t.selector), "a target needs ref, role, label, text, placeholder or selector");
export type Target = z.infer<typeof Target>;

const field = z.string().min(1).describe("Field label as shown on the page, e.g. Channel Type");
const timeout = z.number().int().min(500).max(60_000).optional().describe("Milliseconds (default 10000)");
const SCREENSHOT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}\.(png|jpe?g)$/;

export const Step = z.discriminatedUnion("action", [
  z.object({ action: z.literal("navigate"), url: z.string().min(1).describe("Absolute URL or a path on the current org, e.g. /lightning/r/Account/001.../view") }),
  z.object({ action: z.literal("reload") }),
  z.object({ action: z.literal("click"), target: Target, timeout }),
  z.object({ action: z.literal("fill"), field: field.optional(), target: Target.optional(), value: z.string() }),
  z.object({ action: z.literal("clear"), field: field.optional(), target: Target.optional() }),
  z.object({ action: z.literal("select"), field, value: z.string().describe("Option label to choose") }),
  z.object({ action: z.literal("lookup"), field, search: z.string().describe("Text to type"), option: z.string().optional().describe("Result to pick (default: the search text)") }),
  z.object({ action: z.literal("check"), field: field.optional(), target: Target.optional(), checked: z.boolean().default(true) }),
  z.object({ action: z.literal("press"), key: z.string().describe("e.g. Enter, Escape, Tab"), target: Target.optional() }),
  z.object({ action: z.literal("upload"), target: Target, files: z.array(z.string().min(1)).min(1).describe("Absolute file paths") }),
  z.object({ action: z.literal("waitFor"), target: Target, state: z.enum(["visible", "hidden", "enabled"]).default("visible"), timeout }),
  z.object({ action: z.literal("waitForText"), text: z.string().min(1), gone: z.boolean().optional(), timeout }),
  z.object({ action: z.literal("waitForToast"), timeout }),
  z.object({ action: z.literal("waitForLoad") }),
  z.object({ action: z.literal("getText"), target: Target }),
  z.object({ action: z.literal("getField"), field }),
  z.object({ action: z.literal("listOptions"), field }),
  z.object({ action: z.literal("verifyText"), text: z.string().min(1), present: z.boolean().default(true) }),
  z.object({ action: z.literal("verifyField"), field, expected: z.string(), match: z.enum(["equals", "contains"]).default("equals") }),
  z.object({ action: z.literal("verifyVisible"), target: Target, visible: z.boolean().default(true) }),
  z.object({ action: z.literal("screenshot"), filename: z.string().regex(SCREENSHOT, "a bare file name like 03_saved.png"), fullPage: z.boolean().optional() }),
]);
export type Step = z.infer<typeof Step>;

export const RunStepsInput = z.object({
  steps: z.array(Step).min(1).max(25),
  stopOnMismatch: z.boolean().default(true).describe("Stop at the first verify step that does not match (default true)"),
});
export type RunStepsInput = z.infer<typeof RunStepsInput>;

export interface StepOutcome {
  i: number;
  action: string;
  // ok: done / matched; mismatch: a verify step observed something else; error: could not be performed.
  status: "ok" | "mismatch" | "error" | "skipped";
  detail: string;
  ms: number;
}

export interface PageState {
  url: string;
  title: string;
  dialogs: string[];
  toasts: string[];
  errors: string[];
}

export interface BatchResult {
  outcomes: StepOutcome[];
  state: PageState;
  // Set when a step could not be performed: Claude takes over from here.
  stoppedAt?: number;
  dialog?: string;
}

// Raised for steps the generic layer cannot perform with certainty.
export class StepError extends Error {}

const SPINNERS = ".slds-spinner_container, lightning-spinner, .slds-spinner, .forceListViewManagerGrid .spinnerWrapper";
const TOASTS = ".forceToastMessage, .slds-notify_toast, .slds-notify--toast";
const ERRORS = [
  ".slds-has-error .slds-form-element__help",
  "records-record-edit-error",
  ".pageLevelErrors",
  ".forcePageError",
  "[role=alert]:not(.slds-notify_toast):not(.forceToastMessage)",
].join(", ");
const DIALOGS = "[role=dialog], [role=alertdialog]";
const DEFAULT_TIMEOUT = 10_000;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
// Lightning prefixes required field labels with "*"; tolerate it and surrounding space.
const labelRe = (label: string, exact: boolean) => new RegExp(exact ? `^\\s*\\*?\\s*${esc(label.trim())}\\s*$` : esc(label.trim()), "i");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Waits until Lightning has nothing loading: document ready and no visible spinner for two polls
// in a row (spinners often hand over to each other). Never fails: a slow page is judged by Claude.
export async function waitForSalesforceLoad(page: Page, timeoutMs = 30_000): Promise<number> {
  const start = Date.now();
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  let quiet = 0;
  while (Date.now() - start < timeoutMs && quiet < 2) {
    const busy = await page.locator(SPINNERS).filter({ visible: true }).count().catch(() => 0);
    quiet = busy ? 0 : quiet + 1;
    if (quiet < 2) await sleep(150);
  }
  return Date.now() - start;
}

// The dialog to search in: the named one, the top open one, or none.
async function scopeFor(page: Page, scope: string | undefined): Promise<Page | Locator> {
  if (scope === "page") return page;
  const open = page.locator(DIALOGS).filter({ visible: true });
  if (scope) {
    const named = open.filter({ has: page.getByRole("heading", { name: scope }) });
    if (await named.count()) return named.last();
    const byName = page.getByRole("dialog", { name: scope });
    if (await byName.count()) return byName.last();
    throw new StepError(`No open dialog titled "${scope}".`);
  }
  return (await open.count()) ? open.last() : page;
}

// Where to look, in order: an open dialog first, then the whole page. Salesforce opens non-modal
// popovers (for example "We hit a snag" over an inline edit) whose fields live on the page behind.
async function scopesFor(page: Page, scope: string | undefined): Promise<(Page | Locator)[]> {
  const root = await scopeFor(page, scope);
  return root === page || scope ? [root] : [root, page];
}

function candidates(root: Page | Locator, page: Page, t: Target, exact: boolean): Locator {
  if (t.ref) return page.locator(`aria-ref=${t.ref}`);
  if (t.selector) return root.locator(t.selector);
  if (t.role) return root.getByRole(t.role as Parameters<Page["getByRole"]>[0], t.name ? { name: exact ? labelRe(t.name, true) : t.name } : {});
  if (t.label) return root.getByLabel(labelRe(t.label, exact));
  if (t.placeholder) return root.getByPlaceholder(t.placeholder, { exact });
  return root.getByText(t.text!, { exact });
}

export function describeTarget(t: Target): string {
  if (t.ref) return `ref ${t.ref}`;
  if (t.selector) return `selector ${t.selector}`;
  if (t.role) return `${t.role}${t.name ? ` "${t.name}"` : ""}`;
  if (t.label) return `field "${t.label}"`;
  if (t.placeholder) return `placeholder "${t.placeholder}"`;
  return `text "${t.text}"`;
}

// One visible element for the target, waiting for it to appear. Several matches are an error
// (unless index picks one) so a step never acts on a guess.
export async function resolve(page: Page, t: Target, timeoutMs = DEFAULT_TIMEOUT): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  const tries = t.exact === undefined && !t.ref && !t.selector ? [true, false] : [t.exact ?? true];
  for (;;) {
    for (const root of await scopesFor(page, t.scope)) {
      for (const exact of tries) {
        const all = candidates(root, page, t, exact).filter({ visible: true });
        const n = await all.count();
        if (n === 0) continue;
        if (t.index !== undefined) {
          if (t.index < n) return all.nth(t.index);
          throw new StepError(`${describeTarget(t)}: only ${n} match(es), no index ${t.index}.`);
        }
        if (n === 1) return all.first();
        throw new StepError(`${describeTarget(t)} is ambiguous: ${n} visible matches (${(await summarize(all)).join("; ")}). Use a more specific target, scope or index.`);
      }
    }
    if (Date.now() > deadline) throw new StepError(`${describeTarget(t)} was not found on the page${t.scope && t.scope !== "page" ? ` (searched the dialog "${t.scope}")` : ""}.`);
    await sleep(200);
  }
}

async function summarize(all: Locator): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < Math.min(await all.count(), 5); i++) {
    out.push(await all.nth(i).evaluate((el) => {
      const text = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("title") || "").replace(/\s+/g, " ").trim();
      return `${el.tagName.toLowerCase()}${text ? ` "${text.slice(0, 60)}"` : ""}`;
    }).catch(() => "?"));
  }
  return out;
}

// A form field by its label: label association first, then a textbox/combobox/checkbox named after it.
// Every strategy is tried on each poll, so a field found by its role is not delayed by the label lookup.
export async function resolveField(page: Page, label: string, timeoutMs = DEFAULT_TIMEOUT): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const root of await scopesFor(page, undefined)) {
      const strategies = [
        root.getByLabel(labelRe(label, true)),
        ...(["combobox", "textbox", "spinbutton", "checkbox"] as const).map((role) => root.getByRole(role, { name: labelRe(label, true) })),
        root.getByLabel(labelRe(label, false)),
      ];
      for (const s of strategies) {
        const all = s.filter({ visible: true });
        const n = await all.count();
        if (n === 1) return all.first();
        if (n > 1) throw new StepError(`Field "${label}" is ambiguous: ${n} visible fields match (${(await summarize(all)).join("; ")}).`);
      }
    }
    if (Date.now() > deadline) throw new StepError(`Field "${label}" was not found (no visible input, picklist or checkbox with that label).`);
    await sleep(200);
  }
}

const fieldOrTarget = (page: Page, s: { field?: string; target?: Target }) => {
  if (s.field) return resolveField(page, s.field);
  if (s.target) return resolve(page, s.target);
  throw new StepError("The step needs a field or a target.");
};

// Visible dropdown options (Lightning renders them in a listbox, sometimes outside the field).
async function visibleOptions(page: Page): Promise<string[]> {
  return (await page.getByRole("option").filter({ visible: true }).allInnerTexts()).map(norm).filter(Boolean);
}

async function openPicklist(page: Page, label: string): Promise<{ el: Locator; native: boolean }> {
  const el = await resolveField(page, label);
  const native = await el.evaluate((e) => e.tagName === "SELECT");
  if (!native) {
    await el.click();
    await page.getByRole("option").filter({ visible: true }).first().waitFor({ timeout: DEFAULT_TIMEOUT })
      .catch(() => { throw new StepError(`Clicking "${label}" did not open a list of options.`); });
  }
  return { el, native };
}

// Reads a field's displayed value by its label, on record pages (view mode) and in edit forms.
// Returns every visible match so the caller can tell when a label is ambiguous.
export async function readField(page: Page, label: string): Promise<string[]> {
  return page.evaluate((wanted) => {
    const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
    const labelText = (s: string) => clean(s).replace(/^\*\s*/, "").replace(/\s*Help\b.*$/, "").toLowerCase();
    const visible = (el: Element) => (el as HTMLElement).getClientRects().length > 0;
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot | Element) => {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        all.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(document);
    const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    const container = (el: Element) => {
      for (let p: Element | null = el; p; p = up(p)) {
        if (p.matches(".slds-form-element, records-record-layout-item, .forcePageBlockItem, lightning-input, lightning-combobox, lightning-textarea, .slds-form__item")) return p;
      }
      return null;
    };
    const deepFind = (root: Element, sel: string): Element[] => {
      const out: Element[] = [];
      const go = (r: Element | ShadowRoot) => {
        for (const el of Array.from(r.querySelectorAll("*"))) {
          if (el.matches(sel)) out.push(el);
          if (el.shadowRoot) go(el.shadowRoot);
        }
      };
      go(root);
      if (root.shadowRoot) go(root.shadowRoot);
      return out;
    };
    const valueOf = (box: Element): string | undefined => {
      const box2 = deepFind(box, "input, textarea, select").filter((e) => (e as HTMLInputElement).type !== "hidden");
      const input = box2[0] as HTMLInputElement | undefined;
      if (input?.type === "checkbox") return String(input.checked);
      const combo = deepFind(box, "button[role=combobox], [role=combobox] button, button.slds-combobox__input")[0] as HTMLElement | undefined;
      if (combo) return clean(combo.getAttribute("data-value") || combo.innerText || combo.getAttribute("aria-label"));
      if (input) return clean(input.value);
      const shown = deepFind(box, ".slds-form-element__static, lightning-formatted-text, lightning-formatted-rich-text, lightning-formatted-name, force-lookup, records-formula-output, dd")[0] as HTMLElement | undefined;
      return shown ? clean(shown.innerText) : undefined;
    };
    const values: string[] = [];
    const seen = new Set<Element>();
    const target = wanted.toLowerCase();
    for (const el of all) {
      if (!el.matches(".slds-form-element__label, label, dt, .test-id__field-label, legend")) continue;
      if (!visible(el) || labelText((el as HTMLElement).innerText) !== target) continue;
      const box = container(el);
      if (!box || seen.has(box)) continue;
      seen.add(box);
      const v = valueOf(box);
      if (v !== undefined) values.push(v);
    }
    return values;
  }, label);
}

export async function pageState(page: Page): Promise<PageState> {
  const texts = async (sel: string, max: number) =>
    [...new Set((await page.locator(sel).filter({ visible: true }).allInnerTexts().catch(() => [] as string[])).map(norm).filter(Boolean))]
      .map((t) => t.slice(0, 300)).slice(0, max);
  const dialogs = await page.locator(DIALOGS).filter({ visible: true }).evaluateAll((els) =>
    els.map((d) => (d.getAttribute("aria-label") || d.querySelector("h1, h2, .slds-modal__title")?.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean),
  ).catch(() => [] as string[]);
  return {
    url: page.url(),
    title: await page.title().catch(() => ""),
    dialogs: dialogs.slice(0, 3),
    toasts: await texts(TOASTS, 3),
    errors: await texts(ERRORS, 8),
  };
}

// Runs one step. Returns a detail line; throws StepError when it cannot be performed.
export interface RunContext {
  // Origin for org-relative URLs while the page has none yet (a fresh browser is on about:blank).
  baseUrl?: string;
}

export async function runStep(page: Page, s: Step, cwd: string, ctx: RunContext = {}): Promise<{ status: "ok" | "mismatch"; detail: string }> {
  const ok = (detail: string) => ({ status: "ok" as const, detail });
  switch (s.action) {
    case "navigate": {
      const base = page.url().startsWith("http") ? page.url() : ctx.baseUrl;
      if (!base && !/^https?:\/\//i.test(s.url)) throw new StepError(`"${s.url}" is relative and the browser has no page open yet. Use the full URL.`);
      const url = new URL(s.url, base).toString();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return ok(`Opened ${url}`);
    }
    case "reload":
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      return ok("Reloaded the page");
    case "click": {
      const el = await resolve(page, s.target, s.timeout);
      await el.click({ timeout: s.timeout ?? DEFAULT_TIMEOUT });
      return ok(`Clicked ${describeTarget(s.target)}`);
    }
    case "fill": {
      const el = await fieldOrTarget(page, s);
      await el.fill(s.value);
      const now = await el.inputValue().catch(() => undefined);
      if (now !== undefined && now !== s.value) return { status: "mismatch", detail: `Typed "${s.value}" but the field shows "${now}" (it may limit or format input).` };
      return ok(`Filled ${s.field ? `"${s.field}"` : describeTarget(s.target!)} with "${s.value}"`);
    }
    case "clear": {
      const el = await fieldOrTarget(page, s);
      await el.fill("");
      return ok(`Cleared ${s.field ? `"${s.field}"` : describeTarget(s.target!)}`);
    }
    case "select": {
      const { el, native } = await openPicklist(page, s.field);
      if (native) {
        await el.selectOption({ label: s.value });
      } else {
        const option = page.getByRole("option", { name: labelRe(s.value, true) }).filter({ visible: true });
        if ((await option.count()) !== 1) {
          const seen = await visibleOptions(page);
          await page.keyboard.press("Escape");
          throw new StepError(`"${s.value}" is not an option of "${s.field}". Options shown: ${seen.join(" | ") || "(none)"}.`);
        }
        await option.first().click();
      }
      await waitForSalesforceLoad(page, 5_000);
      const shown = await readField(page, s.field).catch(() => [] as string[]);
      return ok(`Selected "${s.value}" in "${s.field}"${shown.length ? ` (field shows: ${shown.join(" | ")})` : ""}`);
    }
    case "lookup": {
      const el = await resolveField(page, s.field);
      await el.click();
      await el.fill(s.search);
      const want = s.option ?? s.search;
      const option = page.getByRole("option").filter({ visible: true, hasText: new RegExp(esc(want), "i") });
      const appeared = await option.first().waitFor({ timeout: DEFAULT_TIMEOUT }).then(() => true, () => false);
      const n = appeared ? await option.count() : 0;
      if (n !== 1) {
        const seen = await visibleOptions(page);
        throw new StepError(`Lookup "${s.field}": ${n === 0 ? `no result matching "${want}"` : `${n} results match "${want}"`}. Results shown: ${seen.join(" | ") || "(none)"}.`);
      }
      await option.first().click();
      return ok(`Chose "${want}" in lookup "${s.field}"`);
    }
    case "check": {
      const el = await fieldOrTarget(page, s);
      await el.setChecked(s.checked);
      return ok(`${s.checked ? "Checked" : "Unchecked"} ${s.field ? `"${s.field}"` : describeTarget(s.target!)}`);
    }
    case "press":
      if (s.target) await (await resolve(page, s.target)).press(s.key);
      else await page.keyboard.press(s.key);
      return ok(`Pressed ${s.key}`);
    case "upload": {
      const el = await resolve(page, s.target);
      if (await el.evaluate((e) => e.tagName === "INPUT" && (e as HTMLInputElement).type === "file")) {
        await el.setInputFiles(s.files);
      } else {
        const [chooser] = await Promise.all([page.waitForEvent("filechooser", { timeout: DEFAULT_TIMEOUT }), el.click()]);
        await chooser.setFiles(s.files);
      }
      return ok(`Uploaded ${s.files.length} file(s)`);
    }
    case "waitFor": {
      const deadline = Date.now() + (s.timeout ?? DEFAULT_TIMEOUT);
      if (s.state === "hidden") {
        const root = await scopeFor(page, s.target.scope);
        while (await candidates(root, page, s.target, s.target.exact ?? true).filter({ visible: true }).count()) {
          if (Date.now() > deadline) throw new StepError(`${describeTarget(s.target)} is still visible.`);
          await sleep(200);
        }
      } else {
        const el = await resolve(page, s.target, s.timeout);
        while (s.state === "enabled" && !(await el.isEnabled())) {
          if (Date.now() > deadline) throw new StepError(`${describeTarget(s.target)} did not become enabled.`);
          await sleep(200);
        }
      }
      return ok(`${describeTarget(s.target)} is ${s.state}`);
    }
    case "waitForText": {
      const loc = page.getByText(s.text).filter({ visible: true }).first();
      await loc.waitFor({ state: s.gone ? "hidden" : "visible", timeout: s.timeout ?? DEFAULT_TIMEOUT })
        .catch(() => { throw new StepError(`Text "${s.text}" did not ${s.gone ? "disappear" : "appear"} in time.`); });
      return ok(`Text "${s.text}" ${s.gone ? "is gone" : "is shown"}`);
    }
    case "waitForToast": {
      // A toast or an error, whichever comes first: a failed save must not look like a timeout.
      const either = page.locator(`${TOASTS}, ${ERRORS}`).filter({ visible: true }).first();
      await either.waitFor({ timeout: s.timeout ?? 15_000 }).catch(() => { throw new StepError("No toast or error message appeared."); });
      const state = await pageState(page);
      if (state.toasts.length) return ok(`Toast: ${state.toasts.join(" | ")}`);
      return { status: "mismatch", detail: `No toast; error shown instead: ${state.errors.join(" | ")}` };
    }
    case "waitForLoad":
      return ok(`Page settled in ${await waitForSalesforceLoad(page)} ms`);
    case "getText": {
      const el = await resolve(page, s.target);
      return ok(`${describeTarget(s.target)}: "${norm(await el.innerText()).slice(0, 1500)}"`);
    }
    case "getField": {
      const values = await readField(page, s.field);
      if (!values.length) throw new StepError(`Field "${s.field}" was not found on the page.`);
      return ok(`"${s.field}" = ${values.map((v) => `"${v}"`).join(" | ")}${values.length > 1 ? " (several fields have this label)" : ""}`);
    }
    case "listOptions": {
      const { el, native } = await openPicklist(page, s.field);
      const options = native
        ? (await el.locator("option").allInnerTexts()).map(norm)
        : await visibleOptions(page);
      if (!native) await page.keyboard.press("Escape");
      return ok(`"${s.field}" options (${options.length}): ${options.join(" | ")}`);
    }
    case "verifyText": {
      const shown = await page.getByText(s.text).filter({ visible: true }).count();
      const matched = s.present ? shown > 0 : shown === 0;
      return { status: matched ? "ok" : "mismatch", detail: `Text "${s.text}" is ${shown ? "shown" : "not shown"}${matched ? "" : ` (expected ${s.present ? "shown" : "not shown"})`}` };
    }
    case "verifyField": {
      const values = await readField(page, s.field);
      if (!values.length) return { status: "mismatch", detail: `Field "${s.field}" was not found on the page (expected "${s.expected}").` };
      const want = norm(s.expected).toLowerCase();
      const hit = (v: string) => (s.match === "contains" ? v.toLowerCase().includes(want) : v.toLowerCase() === want);
      // Every field with this label must agree; an ambiguous label never passes silently.
      const matched = values.every(hit);
      return { status: matched ? "ok" : "mismatch", detail: `"${s.field}" = ${values.map((v) => `"${v}"`).join(" | ")}; expected ${s.match} "${s.expected}"` };
    }
    case "verifyVisible": {
      const root = await scopeFor(page, s.target.scope);
      const n = await candidates(root, page, s.target, s.target.exact ?? true).filter({ visible: true }).count();
      const matched = s.visible ? n > 0 : n === 0;
      return { status: matched ? "ok" : "mismatch", detail: `${describeTarget(s.target)}: ${n} visible${matched ? "" : ` (expected ${s.visible ? "visible" : "not visible"})`}` };
    }
    case "screenshot":
      await page.screenshot({ path: join(cwd, s.filename), fullPage: s.fullPage ?? false });
      return ok(`Saved screenshot ${s.filename}`);
  }
}

const SETTLES = new Set<Step["action"]>(["navigate", "reload", "click", "select", "lookup", "check", "press", "upload"]);

// Runs the steps in order. Stops at the first step that cannot be performed (and, by default, at the
// first verify mismatch), so later steps never run on an unexpected page.
// Upper bound for one step including its settle wait. Steps have their own shorter timeouts; this
// only catches calls that can never return, such as page queries while a dialog blocks the page.
export const STEP_LIMIT_MS = 90_000;
const RESPONSIVE_MS = 3_000;

// Resolves to "timeout" if the promise has not settled in time (the promise keeps running).
function within<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
  work.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work, new Promise<"timeout">((r) => { timer = setTimeout(() => r("timeout"), ms); })]).finally(() => clearTimeout(timer));
}

const blockedState = (page: Page): PageState => ({ url: page.url(), title: "", dialogs: [], toasts: [], errors: [] });

export async function runSteps(page: Page, input: RunStepsInput, cwd: string, ctx: RunContext = {}, limits = { stepMs: STEP_LIMIT_MS }): Promise<BatchResult> {
  // A dialog left open by an earlier action blocks every page query; never start on a blocked page.
  if ((await within(page.evaluate(() => 1), RESPONSIVE_MS)) === "timeout") {
    return {
      outcomes: input.steps.map((s, i) => ({ i: i + 1, action: s.action, status: i ? "skipped" as const : "error" as const, detail: i ? "not run" : "The page is not responding, most likely because a browser dialog is open.", ms: 0 })),
      state: blockedState(page),
      stoppedAt: 1,
      dialog: "unknown (opened before this batch)",
    };
  }
  const outcomes: StepOutcome[] = [];
  let dialog: string | undefined;
  let timedOut = false;
  // A dialog (confirm, "leave page?") blocks the action that raised it, e.g. a navigation would hang
  // until its timeout. Stop the step as soon as one opens and let Claude answer it.
  let dialogOpened: () => void = () => undefined;
  const onDialog = (d: { type(): string; message(): string }) => {
    dialog = `${d.type()}${d.message() ? `: ${d.message()}` : ""}`;
    dialogOpened();
  };
  page.on("dialog", onDialog);
  let stoppedAt: number | undefined;
  try {
    for (const [i, step] of input.steps.entries()) {
      const start = Date.now();
      if (stoppedAt !== undefined) {
        outcomes.push({ i: i + 1, action: step.action, status: "skipped", detail: "not run", ms: 0 });
        continue;
      }
      try {
        const opened = new Promise<"dialog">((r) => { dialogOpened = () => r("dialog"); });
        const work = (async () => {
          const result = await runStep(page, step, cwd, ctx);
          if (SETTLES.has(step.action)) await waitForSalesforceLoad(page);
          return result;
        })();
        const r = await Promise.race([within(work, limits.stepMs), opened]);
        if (r === "dialog") throw new StepError(`A browser dialog opened (${dialog}) and blocks this action.`);
        if (r === "timeout") {
          timedOut = true;
          throw new StepError(`Did not finish within ${Math.round(limits.stepMs / 1000)}s; the page may be blocked or still loading.`);
        }
        outcomes.push({ i: i + 1, action: step.action, ...r, ms: Date.now() - start });
        if (r.status === "mismatch" && input.stopOnMismatch) stoppedAt = i + 1;
      } catch (err) {
        const message = err instanceof StepError ? err.message : `${(err as Error).message.split("\n")[0]}`.slice(0, 400);
        outcomes.push({ i: i + 1, action: step.action, status: "error", detail: message, ms: Date.now() - start });
        stoppedAt = i + 1;
      }
      // A browser dialog (confirm, beforeunload) blocks the page: Claude decides how to answer it.
      if (dialog && stoppedAt === undefined) stoppedAt = i + 1;
    }
  } finally {
    page.off("dialog", onDialog);
  }
  const state = dialog || timedOut ? "timeout" : await within(pageState(page), 10_000);
  return { outcomes, state: state === "timeout" ? blockedState(page) : state, ...(stoppedAt !== undefined && { stoppedAt }), ...(dialog && { dialog }) };
}

// Compact text for Claude: one line per step plus what the page shows now.
export function formatBatch(r: BatchResult): string {
  const lines = r.outcomes.map((o) => `${o.i}. ${o.action}: ${o.status.toUpperCase()} - ${o.detail}${o.ms > 1500 ? ` (${(o.ms / 1000).toFixed(1)}s)` : ""}`);
  const s = r.state;
  lines.push("", `Page: ${s.title ? `${s.title} - ` : ""}${s.url}`);
  if (s.dialogs.length) lines.push(`Open dialog: ${s.dialogs.join(" | ")}`);
  if (s.toasts.length) lines.push(`Toast: ${s.toasts.join(" | ")}`);
  if (s.errors.length) lines.push(`Errors shown: ${s.errors.join(" | ")}`);
  if (r.dialog) lines.push(`A browser dialog is open (${r.dialog}). Answer it with browser_handle_dialog.`);
  const failed = r.outcomes.find((o) => o.status === "error");
  if (failed) {
    lines.push("", `Step ${failed.i} could not be performed, so the batch stopped there. Take over with the normal browser tools: call browser_snapshot to see the page, then continue from step ${failed.i}.`);
  } else if (r.stoppedAt !== undefined) {
    lines.push("", `Stopped after step ${r.stoppedAt} because it did not match. Judge this result yourself before continuing.`);
  }
  lines.push("Element refs from earlier snapshots may be stale now; take a browser_snapshot before using refs.");
  return lines.join("\n");
}
