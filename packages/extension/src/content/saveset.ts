import { TEST_SET_KINDS, type TestSetKind } from "@sfqa/shared";
import { h } from "./dom.ts";

// Inline "Save as test set" form: a name and Sanity / Regression. Used by the Upload file tab and
// by approved Jira test cases. The caller saves; this only collects the two answers.
export function createSaveSetForm(onSave: (name: string, kind: TestSetKind) => Promise<void>): { element: HTMLElement; open(count: number): void } {
  const name = h("input", { placeholder: "Test set name, e.g. Account sanity", maxLength: 80 });
  const kind = h("select", {}, ...TEST_SET_KINDS.map((k) => h("option", { value: k, textContent: k })));
  const error = h("div", { className: "hint warn" });
  const title = h("div", { className: "subform-title" });
  const save = h("button", { className: "btn small", type: "button", textContent: "Save test set" });
  const element = h("div", { className: "subform", hidden: true },
    title,
    h("div", { className: "row" }, name, kind),
    h("div", { className: "hint", textContent: "Sanity: a quick check of the main flows. Regression: the full set, re-run after every change. Saved sets are in the Test sets tab." }),
    error,
    h("div", { className: "row end" }, h("button", { className: "btn secondary", type: "button", textContent: "Cancel", onclick: () => { element.hidden = true; } }), save),
  );
  save.onclick = async () => {
    if (!name.value.trim()) {
      error.textContent = "Give the test set a name.";
      return name.focus();
    }
    save.disabled = true;
    error.textContent = "";
    try {
      await onSave(name.value.trim(), kind.value as TestSetKind);
      element.hidden = true;
    } catch (err) {
      const m = (err as Error).message;
      error.textContent = m === "name_exists" ? "A test set with this name already exists for this org." : m;
    } finally {
      save.disabled = false;
    }
  };
  return {
    element,
    open(count: number) {
      title.textContent = `Save ${count} test case${count === 1 ? "" : "s"} as a test set`;
      error.textContent = "";
      element.hidden = false;
      name.focus();
    },
  };
}
