import { useEffect, useRef, useState } from 'react';
import type { Compartment } from '@codemirror/state';
import type { EditorView } from 'codemirror';

interface NoteEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
}

export function NoteEditor({ value, onChange, readOnly = false, autoFocus = false }: NoteEditorProps): JSX.Element {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const editableCompartmentRef = useRef<Compartment | null>(null);
  const wrappingCompartmentRef = useRef<Compartment | null>(null);
  const responsiveCleanupRef = useRef<(() => void) | null>(null);
  const externalChangeRef = useRef(false);
  const [editorReady, setEditorReady] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
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
      const editableCompartment = new stateModule.Compartment();
      const wrappingCompartment = new stateModule.Compartment();
      editableCompartmentRef.current = editableCompartment;
      wrappingCompartmentRef.current = wrappingCompartment;
      const state = stateModule.EditorState.create({
        doc: valueRef.current,
        extensions: [
          codemirrorModule.basicSetup,
          markdownModule.markdown(),
          wrappingCompartment.of(window.matchMedia('(max-width: 860px)').matches ? codemirrorModule.EditorView.lineWrapping : []),
          editableCompartment.of(codemirrorModule.EditorView.editable.of(!readOnlyRef.current)),
          codemirrorModule.EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              if (externalChangeRef.current) { externalChangeRef.current = false; return; }
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      });
      view = new codemirrorModule.EditorView({ state, parent: mountRef.current });
      viewRef.current = view;
      setEditorReady(true);
      if (autoFocus && !readOnlyRef.current) window.requestAnimationFrame(() => { if (active) view?.focus(); });
      const media = window.matchMedia('(max-width: 860px)');
      const updateWrapping = () => view?.dispatch({ effects: wrappingCompartment.reconfigure(media.matches ? codemirrorModule.EditorView.lineWrapping : []) });
      media.addEventListener('change', updateWrapping);
      responsiveCleanupRef.current = () => media.removeEventListener('change', updateWrapping);
    }).catch(() => { if (active) setEditorError('The editor could not be loaded. Your draft is still preserved locally.'); });
    return () => {
      active = false;
      responsiveCleanupRef.current?.();
      responsiveCleanupRef.current = null;
      view?.destroy();
      viewRef.current = null;
      editableCompartmentRef.current = null;
      wrappingCompartmentRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;
    externalChangeRef.current = true;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    const compartment = editableCompartmentRef.current;
    if (!view || !compartment) return;
    void import('codemirror').then(({ EditorView }) => {
      view.dispatch({ effects: compartment.reconfigure(EditorView.editable.of(!readOnly)) });
    }).catch(() => setEditorError('The editor settings could not be updated.'));
  }, [readOnly]);

  return <div className="q-editor-mount-wrap">{editorError ? <div className="q-error" role="alert">{editorError}</div> : null}<div ref={mountRef} className="q-editor-mount" aria-busy={!editorReady} aria-label="Markdown editor" data-editor-placeholder="Start writing in Markdown…" /></div>;
}
