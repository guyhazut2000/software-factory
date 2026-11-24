// Local, offline Monaco: core editor + syntax highlighting for ~80 languages (no language-service workers).
// Loaded lazily with the IDE tab, so the rest of the app stays light.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

export const themeName = () => (document.documentElement.classList.contains("dark") ? "vs-dark" : "vs");
export { monaco };
