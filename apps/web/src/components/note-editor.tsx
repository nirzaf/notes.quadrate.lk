import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { basicSetup, EditorView } from 'codemirror';
import { markdown } from '@codemirror/lang-markdown';

interface NoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
}

export function NoteEditor({ value, onChange, readOnly = false }: NoteEditorProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const readOnlyRef = useRef(readOnly);
  valueRef.current = value;
  onChangeRef.current = onChange;
  readOnlyRef.current = readOnly;

  useEffect(() => {
    if (!mountRef.current) return undefined;
    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        basicSetup,
        markdown(),
        EditorView.editable.of(!readOnlyRef.current),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: mountRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  return <div ref={mountRef} className="q-editor-mount" aria-label="Markdown editor" />;
}
