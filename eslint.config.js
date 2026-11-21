import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "apps/desktop/src-tauri/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["**/*.mjs", "**/*.js"], languageOptions: { globals: { console: "readonly", process: "readonly", fetch: "readonly", Buffer: "readonly" } } },
);
