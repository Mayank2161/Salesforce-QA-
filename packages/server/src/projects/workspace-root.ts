import { spawn } from "node:child_process";
import { parse, resolve } from "node:path";

// QA_WORKSPACE_DIR (optional): where the project folders live. Relative paths are taken from the
// repository root. A drive or filesystem root is refused, so projects never spill into C:\ itself.
export function workspaceRoot(value: string | undefined, repoRoot: string): string {
  const root = resolve(repoRoot, value?.trim() || "QA-Workspace");
  if (parse(root).root === root || root.includes("\0")) throw new Error(`QA_WORKSPACE_DIR "${value}" must be a folder, not a drive root.`);
  return root;
}

// Shows a folder in the file manager. Only called with paths the project store built and checked.
export function openFolder(path: string): Promise<void> {
  const [command, args] = process.platform === "win32" ? ["explorer.exe", [path]]
    : process.platform === "darwin" ? ["open", [path]]
    : ["xdg-open", [path]];
  return new Promise((done, fail) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore" });
    child.on("error", fail);
    // Explorer exits with code 1 even when it opened the window, so the exit code is not checked.
    child.on("spawn", () => {
      child.unref();
      done();
    });
  });
}
