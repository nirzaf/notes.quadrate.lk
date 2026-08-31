import type { Notebook } from '@qnotes/shared';

interface NotebookPickerProps {
  notebooks: Notebook[];
  value: string | null;
  disabled?: boolean;
  onChange: (notebookId: string | null) => void;
}

export function NotebookPicker({ notebooks, value, disabled = false, onChange }: NotebookPickerProps): JSX.Element {
  return <label className="q-notebook-picker">
    <span className="q-label">Notebook</span>
    <select value={value ?? ''} onChange={(event) => onChange(event.target.value || null)} disabled={disabled} aria-label="Notebook">
      <option value="">Unfiled</option>
      {notebooks.map((notebook) => <option value={notebook.id} key={notebook.id}>{notebook.name}</option>)}
    </select>
  </label>;
}
