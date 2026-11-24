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

/** Read-only code viewer (M1). One editor; one model per open file so tabs keep their scroll and selection. */
export function CodeView({ uri, value, language }: { uri: string; value: string; language: string }) {
  const el = useRef<HTMLDivElement>(null);
  const ed = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const states = useRef(new Map<string, monaco.editor.ICodeEditorViewState | null>());
  useTheme();
  useEffect(() => {
    ed.current = monaco.editor.create(el.current!, { ...opts, theme: themeName() });
    return () => {
      ed.current?.dispose();
      monaco.editor.getModels().forEach((m) => m.uri.scheme === "sf" && m.dispose());
    };
  }, []);
  useEffect(() => {
    const e = ed.current!;
    const prev = e.getModel();
    if (prev) states.current.set(prev.uri.toString(), e.saveViewState());
    const u = monaco.Uri.from({ scheme: "sf", path: "/" + uri });
    let m = monaco.editor.getModel(u);
    if (!m) m = monaco.editor.createModel(value, language, u);
    else if (m.getValue() !== value) m.setValue(value);
    e.setModel(m);
    const st = states.current.get(u.toString());
    if (st) e.restoreViewState(st);
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
