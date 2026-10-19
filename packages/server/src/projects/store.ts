import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../fs-utils.ts";
import { PROJECT_LAYOUT, QaWorkspace } from "../reports/workspace.ts";

// Project folders for reports and notes, under a configurable workspace root:
//   <root>/Projects/<Project>/project.json
//   <root>/Projects/<Project>/<Org folder>/Test Execution Reports/  (report page, data, one folder per run)
//   <root>/Projects/<Project>/<Org folder>/Bug Reports/             (report page, data, one folder per bug)
//   <root>/Projects/<Project>/<Org folder>/Notes/                   (one .md file per note)
//   <root>/assets/                                                  (shared report styles and scripts)
// Folders are only ever created or added to; nothing here moves or deletes reports.

export const PROJECT_SECTIONS = ["Test Execution Reports", "Bug Reports", "Notes"] as const;

export interface ProjectOrg {
  orgId: string;
  // Folder name inside the project, e.g. TMCDEV or UAT.
  folder: string;
  orgName: string;
  addedOn: string;
}

export interface Project {
  name: string;
  createdOn: string;
  orgs: ProjectOrg[];
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedOn: string;
}

export type ProjectErrorCode = "invalid_name" | "project_exists" | "unknown_project" | "unknown_org" | "folder_exists" | "unknown_note" | "invalid_note";

export class ProjectError extends Error {
  readonly code: ProjectErrorCode;
  constructor(code: ProjectErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

// Names that become folder names: letters, digits, spaces and a few safe symbols. No path separators,
// no leading dot, no trailing dot or space, and none of the names Windows reserves for devices.
const FOLDER_NAME = /^[A-Za-z0-9][A-Za-z0-9 _.&()'+-]{0,59}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

export function checkFolderName(name: string, what: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!FOLDER_NAME.test(n) || /[. ]$/.test(n) || RESERVED.test(n)) {
    throw new ProjectError("invalid_name", `${what} "${name}" can use letters, digits, spaces and - _ . & ( ) ' + (up to 60 characters, not ending in a dot).`);
  }
  return n;
}

// The org's folder name inside a project: the environment part of the org name
// ("DRIVE-ENERGY-4828 - TMCDEV" -> "TMCDEV"), or the whole name made safe.
export function orgFolderName(orgName: string): string {
  const part = orgName.includes(" - ") ? orgName.slice(orgName.lastIndexOf(" - ") + 3) : orgName;
  const safe = part.replace(/[^A-Za-z0-9 _.&()'+-]/g, "-").replace(/\s+/g, " ").replace(/^[^A-Za-z0-9]+/, "").replace(/[. ]+$/, "").slice(0, 60);
  return safe && !RESERVED.test(safe) ? safe : "Org";
}

const NOTE_ID = /^\d{8}-\d{6}-[a-z0-9-]{1,40}$/;
const pad = (n: number) => String(n).padStart(2, "0");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export class ProjectStore {
  readonly root: string;
  readonly #templates: string;
  readonly #sharedRunsDir: string | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #workspaces = new Map<string, Promise<QaWorkspace>>();

  // sharedRunsDir: the shared qa/Screenshots folder, whose run ids project runs must not reuse.
  constructor(root: string, templatesDir: string, opts: { sharedRunsDir?: string } = {}) {
    this.root = resolve(root);
    this.#templates = templatesDir;
    this.#sharedRunsDir = opts.sharedRunsDir;
  }

  // Every run id in use: one folder per run in each project's org folders, plus the shared qa/ runs.
  async runIds(): Promise<string[]> {
    const ids: string[] = [];
    const runFolders = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((f) => f.startsWith("RUN-"));
    if (this.#sharedRunsDir) ids.push(...(await runFolders(this.#sharedRunsDir)));
    for (const p of await this.list()) {
      for (const o of p.orgs) ids.push(...(await runFolders(join(this.projectsDir, p.name, o.folder, PROJECT_LAYOUT.runs))));
    }
    return ids;
  }

  get projectsDir(): string {
    return join(this.root, "Projects");
  }

  // Creates the workspace root and the shared report assets (kept up to date with the templates).
  async ensure(): Promise<void> {
    await mkdir(this.projectsDir, { recursive: true });
    await cp(join(this.#templates, "assets"), join(this.root, "assets"), { recursive: true, force: true });
  }

  async list(): Promise<Project[]> {
    const entries = await readdir(this.projectsDir, { withFileTypes: true }).catch(() => []);
    const projects: Project[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || !FOLDER_NAME.test(e.name)) continue;
      projects.push(await this.#read(e.name));
    }
    return projects.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Project> {
    const folder = (await readdir(this.projectsDir).catch(() => [] as string[])).find((f) => same(f, name.trim()));
    if (!folder) throw new ProjectError("unknown_project", `There is no project "${name}".`);
    return this.#read(folder);
  }

  create(name: string): Promise<Project> {
    const clean = checkFolderName(name, "Project name");
    return this.#serial(async () => {
      const existing = (await readdir(this.projectsDir).catch(() => [] as string[])).find((f) => same(f, clean));
      if (existing) throw new ProjectError("project_exists", `A project named "${existing}" already exists.`);
      const project: Project = { name: clean, createdOn: new Date().toISOString(), orgs: [] };
      await mkdir(this.#path(clean), { recursive: true });
      await this.#write(project);
      return project;
    });
  }

  // Adds an org (environment) folder to a project, with its three sections. Adding an org that is
  // already there returns it unchanged, so callers can use this to make sure the folders exist.
  addOrg(projectName: string, org: { id: string; name: string }, folderName?: string): Promise<ProjectOrg> {
    return this.#serial(async () => {
      const project = await this.get(projectName);
      let entry = project.orgs.find((o) => o.orgId === org.id);
      if (!entry) {
        const folder = folderName ? checkFolderName(folderName, "Org folder name") : this.#freeFolder(project, orgFolderName(org.name));
        if (project.orgs.some((o) => same(o.folder, folder))) throw new ProjectError("folder_exists", `Project "${project.name}" already has a folder "${folder}".`);
        entry = { orgId: org.id, folder, orgName: org.name, addedOn: new Date().toISOString() };
        project.orgs.push(entry);
        await this.#write(project);
      }
      const dir = this.#path(project.name, entry.folder);
      for (const section of PROJECT_SECTIONS) await mkdir(join(dir, section), { recursive: true });
      await (await this.workspace(project.name, org.id)).ensure();
      return entry;
    });
  }

  // Folder of a project, or of one of its orgs, or of one section of it.
  async folder(projectName: string, orgId?: string, section?: (typeof PROJECT_SECTIONS)[number]): Promise<string> {
    const project = await this.get(projectName);
    if (!orgId) return this.#path(project.name);
    const org = this.#org(project, orgId);
    return section ? this.#path(project.name, org.folder, section) : this.#path(project.name, org.folder);
  }

  // The report workspace (execution and bug reports) of a project's org, in the project layout.
  async workspace(projectName: string, orgId: string): Promise<QaWorkspace> {
    const project = await this.get(projectName);
    const org = this.#org(project, orgId);
    const dir = this.#path(project.name, org.folder);
    let ws = this.#workspaces.get(dir);
    if (!ws) {
      const created = new QaWorkspace(dir, this.#templates, PROJECT_LAYOUT, { otherRunIds: () => this.runIds() });
      ws = created.ensure().then(() => created);
      ws.catch(() => this.#workspaces.delete(dir));
      this.#workspaces.set(dir, ws);
    }
    return ws;
  }

  // --- Notes: one Markdown file per note in <Org>/Notes/ ---------------------------------------------

  async listNotes(projectName: string, orgId: string): Promise<Note[]> {
    const dir = await this.folder(projectName, orgId, "Notes");
    const files = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".md") && NOTE_ID.test(f.slice(0, -3)));
    const notes = await Promise.all(files.map((f) => this.#readNote(dir, f.slice(0, -3))));
    return notes.sort((a, b) => b.updatedOn.localeCompare(a.updatedOn));
  }

  async createNote(projectName: string, orgId: string, input: { title: string; body: string }): Promise<Note> {
    const dir = await this.folder(projectName, orgId, "Notes");
    await mkdir(dir, { recursive: true });
    const { title, body } = checkNote(input);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "note";
    for (let n = 1; ; n++) {
      const id = `${stamp}-${slug}${n > 1 ? `-${n}` : ""}`;
      // "wx" fails if the file exists, so two notes can never overwrite each other.
      const ok = await writeFile(join(dir, `${id}.md`), noteText(title, body), { flag: "wx" }).then(() => true, (err: NodeJS.ErrnoException) => {
        if (err.code === "EEXIST") return false;
        throw err;
      });
      if (ok) return this.#readNote(dir, id);
    }
  }

  async updateNote(projectName: string, orgId: string, id: string, input: { title: string; body: string }): Promise<Note> {
    const file = await this.#notePath(projectName, orgId, id);
    const { title, body } = checkNote(input);
    await writeFileAtomic(file, noteText(title, body));
    return this.#readNote(join(file, ".."), id);
  }

  async deleteNote(projectName: string, orgId: string, id: string): Promise<void> {
    await rm(await this.#notePath(projectName, orgId, id));
  }

  async #notePath(projectName: string, orgId: string, id: string): Promise<string> {
    if (!NOTE_ID.test(id)) throw new ProjectError("unknown_note", "There is no such note.");
    const file = join(await this.folder(projectName, orgId, "Notes"), `${id}.md`);
    if (!(await stat(file).then((s) => s.isFile(), () => false))) throw new ProjectError("unknown_note", "There is no such note.");
    return file;
  }

  async #readNote(dir: string, id: string): Promise<Note> {
    const file = join(dir, `${id}.md`);
    const [text, info] = await Promise.all([readFile(file, "utf8"), stat(file)]);
    const m = /^# (.*)\r?\n\r?\n?([\s\S]*)$/.exec(text);
    return { id, title: m ? m[1]!.trim() : id, body: (m ? m[2]! : text).replace(/\r?\n$/, ""), updatedOn: info.mtime.toISOString() };
  }

  // --- Internals --------------------------------------------------------------------------------------

  #org(project: Project, orgId: string): ProjectOrg {
    const org = project.orgs.find((o) => o.orgId === orgId);
    if (!org) throw new ProjectError("unknown_org", `Project "${project.name}" has no folder for this org yet.`);
    return org;
  }

  #freeFolder(project: Project, base: string): string {
    let folder = base;
    for (let n = 2; project.orgs.some((o) => same(o.folder, folder)); n++) folder = `${base} (${n})`;
    return folder;
  }

  // Every path is built from checked names and confirmed to stay inside the projects folder.
  #path(...parts: string[]): string {
    const path = resolve(this.projectsDir, ...parts);
    if (!path.startsWith(this.projectsDir + sep)) throw new ProjectError("invalid_name", "Invalid folder name.");
    return path;
  }

  async #read(folder: string): Promise<Project> {
    try {
      const p = JSON.parse(await readFile(join(this.#path(folder), "project.json"), "utf8")) as Partial<Project>;
      return { name: folder, createdOn: p.createdOn ?? "", orgs: Array.isArray(p.orgs) ? p.orgs.filter((o) => o && FOLDER_NAME.test(o.folder)) : [] };
    } catch {
      // A folder made by hand: a project with no orgs yet.
      return { name: folder, createdOn: "", orgs: [] };
    }
  }

  async #write(project: Project): Promise<void> {
    await writeFileAtomic(join(this.#path(project.name), "project.json"), `${JSON.stringify(project, null, 2)}\n`);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

function checkNote(input: { title: string; body: string }): { title: string; body: string } {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
  const body = String(input.body ?? "");
  if (!title || title.length > 120) throw new ProjectError("invalid_note", "A note needs a title of up to 120 characters.");
  if (body.length > 100_000) throw new ProjectError("invalid_note", "A note can be up to 100,000 characters.");
  return { title, body };
}

const noteText = (title: string, body: string) => `# ${title}\n\n${body}${body.endsWith("\n") ? "" : "\n"}`;
