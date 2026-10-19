import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // templates/ holds the browser-side report pages copied from the RMS QA layout.
  { ignores: ["**/node_modules/**", "**/dist/**", "auth/**", "runs/**", "qa/**", "QA-Workspace/**", "packages/server/templates/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Plain-JS build scripts run in Node.
  { files: ["**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
);
