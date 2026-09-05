import { useState, type KeyboardEvent } from 'react';
import { MAX_TAG_COUNT, MAX_TAG_LENGTH, MAX_TITLE_LENGTH, normalizeTags } from '@qnotes/shared';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Input } from './ui/input';

interface NoteMetadataEditorProps {
  title: string;
  tags: string[];
  disabled?: boolean;
  onTitleChange: (title: string) => void;
  onTitleBlur: () => void;
  onTagsChange: (tags: string[]) => void;
}

export function NoteMetadataEditor({ title, tags, disabled = false, onTitleChange, onTitleBlur, onTagsChange }: NoteMetadataEditorProps): JSX.Element {
  const [tagInput, setTagInput] = useState('');
  const [tagError, setTagError] = useState<string | null>(null);

  const addTag = () => {
    const value = tagInput.trim();
    if (!value) return;
    try {
      const next = normalizeTags([...tags, value], false);
      onTagsChange(next);
      setTagInput('');
      setTagError(null);
    } catch (error: unknown) {
      setTagError(error instanceof Error ? error.message : 'This tag cannot be added.');
    }
  };

  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag();
    }
  };

  const removeTag = (tag: string) => {
    onTagsChange(tags.filter((current) => current !== tag));
    setTagError(null);
  };

  return <div className="q-note-metadata">
    <label className="q-field" htmlFor="note-title">
      <span className="q-label">Title</span>
      <Input id="note-title" value={title} onChange={(event) => onTitleChange(event.target.value)} onBlur={onTitleBlur} placeholder="Untitled note" maxLength={MAX_TITLE_LENGTH} disabled={disabled} autoFocus={!disabled} aria-describedby="note-title-help" />
      <span id="note-title-help" className="q-field-help">Leave blank to use “Untitled note”.</span>
    </label>
    <div className="q-field">
      <span className="q-label" id="note-tags-label">Tags</span>
      <div className="q-tag-editor" aria-labelledby="note-tags-label">
        {tags.map((tag) => <span className="q-editable-tag" key={tag}><Badge>{tag}</Badge><Button type="button" variant="ghost" size="icon" className="q-tag-remove" onClick={() => removeTag(tag)} disabled={disabled} aria-label={`Remove tag ${tag}`}>×</Button></span>)}
        <Input aria-label="Add a tag" value={tagInput} onChange={(event) => { setTagInput(event.target.value); setTagError(null); }} onKeyDown={keyDown} onBlur={addTag} placeholder={tags.length < MAX_TAG_COUNT ? 'Add tag and press Enter' : 'Tag limit reached'} maxLength={MAX_TAG_LENGTH} disabled={disabled || tags.length >= MAX_TAG_COUNT} />
      </div>
      {tagError ? <span className="q-field-error" role="alert">{tagError}</span> : <span className="q-field-help">Tags are lowercased and can be added with Enter.</span>}
    </div>
  </div>;
}
