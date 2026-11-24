import { useEffect, useRef } from "react";
import { monaco, themeName } from "./monaco";

const opts = { readOnly: true, automaticLayout: true, minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 13, renderWhitespace: "selection" as const };

/** Keep Monaco's theme in sync with the app's dark/light toggle. */
function useTheme() {
  useEffect(() => {
    const apply = () => monaco.editor.setTheme(themeName());
    apply();
    const mo = new MutationObserver(apply);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);
}

const modelUri = (uri: string) => monaco.Uri.from({ scheme: "sf", path: "/" + uri });
/** Last server text per model, so a reload never overwrites unsaved edits. */
const baselines = new Map<string, string>();
export const isDirty = (uri: string) => { const m = monaco.editor.getModel(modelUri(uri)); return !!m && m.getValue() !== (baselines.get(m.uri.toString()) ?? m.getValue()); };
export const modelText = (uri: string) => monaco.editor.getModel(modelUri(uri))?.getValue();
/** Drop one file's model (tab closed) or all of them (workspace switched / IDE closed). */
export function dropModels(uri?: string) {
  for (const m of monaco.editor.getModels()) if (m.uri.scheme === "sf" && (!uri || m.uri.toString() === modelUri(uri).toString())) { baselines.delete(m.uri.toString()); m.dispose(); }
}
/** Replace a model's text and baseline (after a save, or "reload theirs"). */
export function resetModel(uri: string, value: string) {
  const u = modelUri(uri);
  baselines.set(u.toString(), value);
  const m = monaco.editor.getModel(u);
  if (m && m.getValue() !== value) m.setValue(value);
}

/** Code editor: read-only by default, editable (Ctrl/Cmd+S saves) when `onSave` is given. One model per file so tabs keep scroll, selection and unsaved edits. */
export function CodeView({ uri, value, language, onSave, onDirty }: { uri: string; value: string; language: string; onSave?: (content: string) => void; onDirty?: (dirty: boolean) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const states = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  const cb = useRef({ onSave, onDirty, uri });
  cb.current = { onSave, onDirty, uri };
  useTheme();
  useEffect(() => {
    const e = (ed.current = monaco.editor.create(el.current!, { ...opts, theme: themeName() }));
    e.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { const m = e.getModel(); if (m && cb.current.onSave) cb.current.onSave(m.getValue()); });
    const sub = e.onDidChangeModelContent(() => cb.current.onDirty?.(isDirty(cb.current.uri)));
    return () => {
      sub.dispose();
      e.dispose(); // models survive tab switches (unsaved edits); dropModels() frees them
    };
  }, []);
  useEffect(() => { ed.current?.updateOptions({ readOnly: !onSave }); }, [!onSave]);
  useEffect(() => {
    const e = ed.current!;
    const prev = e.getModel();
    if (prev) states.current.set(prev.uri.toString(), e.saveViewState());
    const u = modelUri(uri), k = u.toString();
    let m = monaco.editor.getModel(u);
    if (!m) m = monaco.editor.createModel(value, language, u);
    else if (m.getValue() !== value && !isDirty(uri)) m.setValue(value); // keep unsaved edits
    if (!isDirty(uri)) baselines.set(k, value);
    e.setModel(m);
    const st = states.current.get(k);
    if (st) e.restoreViewState(st);
    cb.current.onDirty?.(isDirty(uri));
  }, [uri, value, language]);
  return <div ref={el} className="h-full w-full" />;
}

/** Read-only side-by-side (or inline) diff. */
export function DiffView({ original, modified, language, inline }: { original: string; modified: string; language: string; inline?: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  useTheme();
  useEffect(() => {
    ed.current = monaco.editor.createDiffEditor(el.current!, { ...opts, originalEditable: false, renderSideBySide: !inline, theme: themeName() });
    return () => {
      const m = ed.current?.getModel();
      ed.current?.dispose();
      m?.original.dispose();
      m?.modified.dispose();
    };
  }, []);
  useEffect(() => {
    ed.current?.updateOptions({ renderSideBySide: !inline });
  }, [inline]);
  useEffect(() => {
    const e = ed.current!;
    const old = e.getModel();
    e.setModel({ original: monaco.editor.createModel(original, language), modified: monaco.editor.createModel(modified, language) });
    old?.original.dispose();
    old?.modified.dispose();
  }, [original, modified, language]);
  return <div ref={el} className="h-full w-full" />;
}
