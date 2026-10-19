import { send, type Note, type ProjectSection } from "../messages.ts";
import { h } from "./dom.ts";

// Project folders: pick (or create) a project. Runs then save their reports in
// QA-Workspace/Projects/<project>/<org>/, and the buttons open that org's reports, notes and folder.
// All file work happens in the local agent server; the extension only asks it.

export interface ProjectsContext {
  orgId(): string;
  orgName(): string | undefined;
}

const NONE = "";
const LAST_PROJECT_KEY = "lastProject";

export function createProjectsPanel(ctx: ProjectsContext): { element: HTMLElement; project(): string | undefined; refresh(): Promise<void> } {
  let root = "";
  let folder: string | undefined; // the current org's folder in the selected project
  let editing: Note | undefined;

  const select = h("select");
  const newLink = h("button", { className: "btn link", type: "button", textContent: "+ New project" });
  const where = h("div", { className: "hint" });

  // New project form
  const nameInput = h("input", { placeholder: "e.g. RMS, Big Top", maxLength: 60 });
  const createError = h("div", { className: "hint warn" });
  const createButton = h("button", { className: "btn small", type: "button", textContent: "Create project" });
  const newForm = h("div", { className: "subform", hidden: true },
    h("div", { className: "subform-title", textContent: "New project" }),
    nameInput,
    h("div", { className: "hint", textContent: "A folder for this project is created on this computer, with a sub-folder for each Salesforce org you run it against." }),
    createError,
    h("div", { className: "row end" }, h("button", { className: "btn secondary", type: "button", textContent: "Cancel", onclick: () => toggleNew(false) }), createButton),
  );

  // Section buttons
  const execButton = h("button", { className: "btn secondary", type: "button", textContent: "Test Execution Reports" });
  const bugsButton = h("button", { className: "btn secondary", type: "button", textContent: "Bug Reports" });
  const notesButton = h("button", { className: "btn secondary", type: "button", textContent: "Notes" });
  const folderButton = h("button", { className: "btn secondary", type: "button", textContent: "Open folder", title: "Show this project's folder for the org in File Explorer" });
  const message = h("div", { className: "hint warn" });

  // Notes
  const notesTitle = h("div", { className: "subform-title" });
  const notesList = h("div", { className: "notes-list" });
  const noteTitle = h("input", { placeholder: "Title", maxLength: 120 });
  const noteBody = h("textarea", { className: "note-body", placeholder: "Write your note…" });
  const noteError = h("div", { className: "hint warn" });
  const deleteNoteButton = h("button", { className: "btn link danger", type: "button", textContent: "Delete" });
  const saveNoteButton = h("button", { className: "btn small", type: "button", textContent: "Save note" });
  const editor = h("div", { className: "note-editor", hidden: true },
    noteTitle, noteBody, noteError,
    h("div", { className: "row" }, deleteNoteButton, h("button", { className: "btn secondary", type: "button", textContent: "Cancel", onclick: () => showEditor(undefined, false) }), saveNoteButton),
  );
  const newNoteButton = h("button", { className: "btn link", type: "button", textContent: "+ New note", onclick: () => showEditor(undefined, true) });
  const notesBox = h("div", { className: "subform", hidden: true },
    h("div", { className: "row" }, notesTitle, newNoteButton),
    notesList,
    editor,
  );

  const element = h("section", { className: "card" },
    h("div", { className: "card-title", textContent: "Project" }),
    h("label", {}, "Current project", select),
    where,
    h("div", { className: "row" }, newLink),
    newForm,
    h("div", { className: "project-actions" }, execButton, bugsButton, notesButton, folderButton),
    message,
    notesBox,
  );

  const project = (): string | undefined => select.value || undefined;

  // --- Projects -------------------------------------------------------------------------------------

  async function refresh(): Promise<void> {
    message.textContent = "";
    try {
      const list = await send({ type: "getProjects" });
      root = list.root;
      const saved = select.value || ((await chrome.storage.local.get(LAST_PROJECT_KEY))[LAST_PROJECT_KEY] as string | undefined);
      select.replaceChildren(
        h("option", { value: NONE, textContent: "No project (shared reports)" }),
        ...list.projects.map((p) => h("option", { value: p.name, textContent: p.name })),
      );
      if (saved && list.projects.some((p) => p.name === saved)) select.value = saved;
    } catch (err) {
      message.textContent = `Projects are not available: ${(err as Error).message}`;
    }
    await selectOrgFolder();
  }

  // Makes sure the selected project has a folder for the current org (created on first use).
  async function selectOrgFolder(): Promise<void> {
    folder = undefined;
    const p = project();
    const orgId = ctx.orgId();
    if (p && orgId) {
      try {
        folder = (await send({ type: "addProjectOrg", project: p, orgId })).folder;
      } catch (err) {
        message.textContent = (err as Error).message;
      }
    }
    render();
    if (!notesBox.hidden) await loadNotes();
  }

  function render(): void {
    const p = project();
    const orgName = ctx.orgName();
    where.className = "hint";
    if (p && folder) {
      where.replaceChildren("Runs are saved in ", h("strong", { textContent: `${p} › ${folder}` }), root ? ` (${root})` : "");
    } else if (p) {
      where.textContent = "Select an org to use this project.";
    } else {
      where.textContent = orgName
        ? `Runs are saved in the shared reports folder. Reports open filtered to ${orgName}.`
        : "Runs are saved in the shared reports folder.";
    }
    const ready = Boolean(p && folder);
    notesButton.disabled = !ready;
    folderButton.disabled = !ready;
    execButton.disabled = bugsButton.disabled = !ctx.orgId();
    if (!ready) notesBox.hidden = true;
    notesButton.classList.toggle("on", !notesBox.hidden);
  }

  select.onchange = () => {
    void chrome.storage.local.set({ [LAST_PROJECT_KEY]: select.value });
    message.textContent = "";
    void selectOrgFolder();
  };

  function toggleNew(show: boolean): void {
    newForm.hidden = !show;
    createError.textContent = "";
    if (show) {
      nameInput.value = "";
      nameInput.focus();
    }
  }
  newLink.onclick = () => toggleNew(newForm.hidden);

  createButton.onclick = async () => {
    const name = nameInput.value.trim();
    if (!name) return nameInput.focus();
    createButton.disabled = true;
    try {
      const created = await send({ type: "createProject", name });
      toggleNew(false);
      select.value = "";
      await refresh();
      select.value = created.name;
      void chrome.storage.local.set({ [LAST_PROJECT_KEY]: created.name });
      await selectOrgFolder();
    } catch (err) {
      const m = (err as Error).message;
      createError.textContent = m === "project_exists" ? "A project with that name already exists." : m;
    } finally {
      createButton.disabled = false;
    }
  };
  nameInput.onkeydown = (e) => { if (e.key === "Enter") createButton.click(); };

  // --- Reports and folder ---------------------------------------------------------------------------

  async function openReport(kind: "executionReport" | "bugReport"): Promise<void> {
    message.textContent = "";
    try {
      const p = project();
      const links = await send({ type: "getReportLinks", orgId: ctx.orgId(), ...(p && folder && { project: p }) });
      window.open(links[kind], "_blank");
    } catch (err) {
      message.textContent = (err as Error).message;
    }
  }
  execButton.onclick = () => void openReport("executionReport");
  bugsButton.onclick = () => void openReport("bugReport");

  async function openFolder(section?: ProjectSection): Promise<void> {
    const p = project();
    if (!p || !folder) return;
    try {
      await send({ type: "openProjectFolder", project: p, orgId: ctx.orgId(), ...(section && { section }) });
    } catch (err) {
      message.textContent = (err as Error).message;
    }
  }
  folderButton.onclick = () => void openFolder();

  // --- Notes ----------------------------------------------------------------------------------------

  notesButton.onclick = async () => {
    notesBox.hidden = !notesBox.hidden;
    render();
    if (!notesBox.hidden) await loadNotes();
  };

  async function loadNotes(): Promise<void> {
    const p = project();
    if (!p || !folder) return;
    notesTitle.textContent = `Notes · ${p} › ${folder}`;
    notesList.replaceChildren(h("div", { className: "hint", textContent: "Loading…" }));
    try {
      const { notes } = await send({ type: "listNotes", project: p, orgId: ctx.orgId() });
      notesList.replaceChildren(...(notes.length ? notes.map(noteRow) : [h("div", { className: "hint", textContent: "No notes yet." })]));
    } catch (err) {
      notesList.replaceChildren(h("div", { className: "hint warn", textContent: (err as Error).message }));
    }
  }

  function noteRow(note: Note): HTMLElement {
    const preview = note.body.replace(/\s+/g, " ").trim().slice(0, 90);
    const row = h("button", { className: "note-row", type: "button" },
      h("span", { className: "note-title", textContent: note.title }),
      h("span", { className: "note-meta", textContent: `${new Date(note.updatedOn).toLocaleString()}${preview ? ` · ${preview}` : ""}` }),
    );
    row.onclick = () => showEditor(note, true);
    return row;
  }

  function showEditor(note: Note | undefined, show: boolean): void {
    editing = note;
    editor.hidden = !show;
    noteError.textContent = "";
    deleteNoteButton.hidden = !note;
    if (!show) return;
    noteTitle.value = note?.title ?? "";
    noteBody.value = note?.body ?? "";
    (note ? noteBody : noteTitle).focus();
  }

  saveNoteButton.onclick = async () => {
    const p = project();
    if (!p) return;
    const title = noteTitle.value.trim();
    if (!title) {
      noteError.textContent = "Give the note a title.";
      return noteTitle.focus();
    }
    saveNoteButton.disabled = true;
    try {
      const base = { project: p, orgId: ctx.orgId(), title, body: noteBody.value };
      if (editing) await send({ type: "updateNote", ...base, id: editing.id });
      else await send({ type: "createNote", ...base });
      showEditor(undefined, false);
      await loadNotes();
    } catch (err) {
      noteError.textContent = (err as Error).message;
    } finally {
      saveNoteButton.disabled = false;
    }
  };

  deleteNoteButton.onclick = async () => {
    const p = project();
    if (!p || !editing || !confirm(`Delete the note "${editing.title}"? This removes its file from the Notes folder.`)) return;
    try {
      await send({ type: "deleteNote", project: p, orgId: ctx.orgId(), id: editing.id });
      showEditor(undefined, false);
      await loadNotes();
    } catch (err) {
      noteError.textContent = (err as Error).message;
    }
  };

  // Nothing is selected until the panel has loaded the orgs and calls refresh(); the context must not
  // be read yet (the panel creates this section before its own org helpers exist).
  for (const b of [execButton, bugsButton, notesButton, folderButton]) b.disabled = true;
  return { element, project, refresh };
}
