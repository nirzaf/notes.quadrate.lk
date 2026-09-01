import { useEffect, useRef, useState } from 'react';
import type { EditorView } from 'codemirror';

interface NoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function NoteEditor({ value, onChange, readOnly = false }: NoteEditorProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  valueRef.current = value;
  onChangeRef.current = onChange;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    if (!mountRef.current) return undefined;
    let active = true;
    let view: EditorView | null = null;
    void Promise.all([import('@codemirror/state'), import('codemirror'), import('@codemirror/lang-markdown')]).then(([stateModule, codemirrorModule, markdownModule]) => {
      if (!active || !mountRef.current) return;
      const state = stateModule.EditorState.create({
        doc: valueRef.current,
        extensions: [
          codemirrorModule.basicSetup,
          markdownModule.markdown(),
          ...(window.matchMedia('(max-width: 860px)').matches ? [codemirrorModule.EditorView.lineWrapping] : []),
          codemirrorModule.EditorView.editable.of(!readOnlyRef.current),
          codemirrorModule.EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      });
      view = new codemirrorModule.EditorView({ state, parent: mountRef.current });
      viewRef.current = view;
      setEditorReady(true);
    });
    return () => {
      active = false;
      view?.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={mountRef} className="q-editor-mount" aria-busy={!editorReady} aria-label="Markdown editor" />;
}
