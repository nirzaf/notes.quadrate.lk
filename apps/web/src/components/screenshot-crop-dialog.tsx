import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Crop, RotateCcw } from 'lucide-react';
import {
  clampCropRect,
  MIN_CROP_SIZE,
  moveCropRect,
  normalizeCropRect,
  previewPointToSource,
  resizeCropRect,
  sourceRectToPreviewRect,
  type CropHandle,
  type CropRect,
  type ImageSize,
} from '../lib/screenshot';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface ScreenshotCropDialogProps {
  open: boolean;
  source: Blob | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (crop: CropRect) => Promise<void>;
}

type Interaction =
  | { kind: 'draw'; pointerId: number; start: { x: number; y: number }; initial: CropRect }
  | { kind: 'move'; pointerId: number; start: { x: number; y: number }; initial: CropRect }
  | { kind: 'resize'; pointerId: number; handle: CropHandle; start: { x: number; y: number }; initial: CropRect };

const handles: Array<{ name: CropHandle; label: string }> = [
  { name: 'nw', label: 'Resize top left' },
  { name: 'n', label: 'Resize top' },
  { name: 'ne', label: 'Resize top right' },
  { name: 'e', label: 'Resize right' },
  { name: 'se', label: 'Resize bottom right' },
  { name: 's', label: 'Resize bottom' },
  { name: 'sw', label: 'Resize bottom left' },
  { name: 'w', label: 'Resize left' },
];

function readImageSize(image: HTMLImageElement): ImageSize {
  return { width: image.naturalWidth, height: image.naturalHeight };
}

function eventPoint(event: { clientX: number; clientY: number }, element: HTMLElement): { x: number; y: number } {
  const bounds = element.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
}

function cropLabel(crop: CropRect): string {
  return `Selected area: ${Math.round(crop.width)} by ${Math.round(crop.height)} pixels at ${Math.round(crop.x)}, ${Math.round(crop.y)}.`;
}

export function ScreenshotCropDialog({ open, source, onOpenChange, onConfirm }: ScreenshotCropDialogProps): JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const interactionRef = useRef<Interaction | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [sourceSize, setSourceSize] = useState<ImageSize | null>(null);
  const [previewSize, setPreviewSize] = useState<ImageSize>({ width: 0, height: 0 });
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!source) {
      setImageUrl(null);
      setSourceSize(null);
      setCrop(null);
      return undefined;
    }
    const url = URL.createObjectURL(source);
    setImageUrl(url);
    setSourceSize(null);
    setCrop(null);
    return () => URL.revokeObjectURL(url);
  }, [source]);

  const refreshPreviewSize = () => {
    const image = imageRef.current;
    if (!image || !image.naturalWidth) return;
    const bounds = image.getBoundingClientRect();
    setPreviewSize({ width: bounds.width, height: bounds.height });
  };

  useEffect(() => {
    if (!open || !imageUrl) return undefined;
    const onResize = () => refreshPreviewSize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [imageUrl, open]);

  useEffect(() => {
    if (!crop || !sourceSize || !previewSize.width) return undefined;
    const frame = window.requestAnimationFrame(() => selectionRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [crop, previewSize.height, previewSize.width, sourceSize]);

  const previewCrop = useMemo(() => {
    if (!crop || !sourceSize || !previewSize.width) return null;
    return sourceRectToPreviewRect(crop, sourceSize, previewSize);
  }, [crop, previewSize, sourceSize]);

  const sourcePoint = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sourceSize || !previewSize.width || !stageRef.current) return null;
    return previewPointToSource(eventPoint(event, stageRef.current), previewSize, sourceSize);
  };

  const updateInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (!interaction || event.pointerId !== interaction.pointerId || !sourceSize) return;
    const point = sourcePoint(event);
    if (!point) return;
    const delta = { x: point.x - interaction.start.x, y: point.y - interaction.start.y };
    if (interaction.kind === 'draw') {
      setCrop(normalizeCropRect(interaction.start, point, sourceSize));
    } else if (interaction.kind === 'move') {
      setCrop(moveCropRect(interaction.initial, delta, sourceSize));
    } else {
      setCrop(resizeCropRect(interaction.initial, interaction.handle, delta, sourceSize));
    }
  };

  const finishInteraction = (event: ReactPointerEvent<HTMLDivElement>) => {
    const interaction = interactionRef.current;
    if (interaction?.pointerId === event.pointerId) {
      if (stageRef.current?.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId);
      interactionRef.current = null;
    }
  };

  const beginDraw = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sourceSize || !previewSize.width || !stageRef.current || event.target !== stageRef.current) return;
    const point = sourcePoint(event);
    if (!point) return;
    event.preventDefault();
    stageRef.current.setPointerCapture(event.pointerId);
    interactionRef.current = { kind: 'draw', pointerId: event.pointerId, start: point, initial: crop ?? clampCropRect({ x: 0, y: 0, width: sourceSize.width, height: sourceSize.height }, sourceSize) };
    setCrop(normalizeCropRect(point, point, sourceSize));
  };

  const beginMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!sourceSize || !crop || !stageRef.current) return;
    const point = sourcePoint(event);
    if (!point) return;
    event.preventDefault();
    stageRef.current.setPointerCapture(event.pointerId);
    interactionRef.current = { kind: 'move', pointerId: event.pointerId, start: point, initial: crop };
  };

  const beginResize = (event: ReactPointerEvent<HTMLButtonElement>, handle: CropHandle) => {
    if (!sourceSize || !crop || !stageRef.current) return;
    const point = previewPointToSource(eventPoint(event, stageRef.current), previewSize, sourceSize);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    stageRef.current.setPointerCapture(event.pointerId);
    interactionRef.current = { kind: 'resize', pointerId: event.pointerId, handle, start: point, initial: crop };
  };

  const reset = () => {
    if (sourceSize) setCrop(clampCropRect({ x: 0, y: 0, width: sourceSize.width, height: sourceSize.height }, sourceSize));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!crop || !sourceSize) return;
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const amount = event.shiftKey ? 10 : 1;
    const resize = event.shiftKey;
    const direction = event.key === 'ArrowLeft' ? 'w' : event.key === 'ArrowRight' ? 'e' : event.key === 'ArrowUp' ? 'n' : event.key === 'ArrowDown' ? 's' : null;
    if (!direction) return;
    event.preventDefault();
    setCrop(resize ? resizeCropRect(crop, direction, { x: direction === 'w' ? -amount : direction === 'e' ? amount : 0, y: direction === 'n' ? -amount : direction === 's' ? amount : 0 }, sourceSize) : moveCropRect(crop, { x: direction === 'w' ? -amount : direction === 'e' ? amount : 0, y: direction === 'n' ? -amount : direction === 's' ? amount : 0 }, sourceSize));
  };

  const submit = async () => {
    if (!crop || saving) return;
    setSaving(true);
    try { await onConfirm(crop); } finally { setSaving(false); }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && saving) return;
    onOpenChange(nextOpen);
  };

  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent className="q-crop-dialog">
      <DialogHeader>
        <DialogTitle>Crop screenshot</DialogTitle>
        <DialogDescription>Drag the selection to move it, drag a corner or edge to resize it, or focus the selection and use the arrow keys. Shift plus an arrow resizes it.</DialogDescription>
      </DialogHeader>
      <div className="q-crop-preview" aria-busy={!sourceSize || saving}>
        {imageUrl ? <div ref={stageRef} className="q-crop-stage" onPointerDown={beginDraw} onPointerMove={updateInteraction} onPointerUp={finishInteraction} onPointerCancel={finishInteraction}>
          <img ref={imageRef} className="q-crop-image" src={imageUrl} alt="Screenshot to crop" draggable={false} onLoad={() => { const image = imageRef.current; if (!image) return; const size = readImageSize(image); setSourceSize(size); const bounds = image.getBoundingClientRect(); setPreviewSize({ width: bounds.width, height: bounds.height }); setCrop(clampCropRect({ x: 0, y: 0, width: size.width, height: size.height }, size)); }} />
          {previewCrop && <>
            <div className="q-crop-dim q-crop-dim-top" style={{ height: previewCrop.y }} aria-hidden="true" />
            <div className="q-crop-dim q-crop-dim-left" style={{ top: previewCrop.y, width: previewCrop.x, height: previewCrop.height }} aria-hidden="true" />
            <div className="q-crop-dim q-crop-dim-right" style={{ top: previewCrop.y, left: previewCrop.x + previewCrop.width, height: previewCrop.height }} aria-hidden="true" />
            <div className="q-crop-dim q-crop-dim-bottom" style={{ top: previewCrop.y + previewCrop.height }} aria-hidden="true" />
            <div ref={selectionRef} className="q-crop-selection" role="region" tabIndex={0} aria-label={sourceSize ? `${cropLabel(crop!)} Use arrow keys to move.` : 'Screenshot crop selection'} style={{ left: previewCrop.x, top: previewCrop.y, width: previewCrop.width, height: previewCrop.height }} onPointerDown={beginMove} onKeyDown={onKeyDown}>
              {handles.map(({ name, label }) => <button key={name} type="button" className={`q-crop-handle q-crop-handle-${name}`} aria-label={label} onPointerDown={(event) => beginResize(event, name)} />)}
            </div>
          </>}
        </div> : <div className="q-empty">Loading screenshot preview…</div>}
      </div>
      <div className="q-crop-instructions" role="status">{crop && sourceSize ? cropLabel(crop) : 'Preparing the original-resolution screenshot…'} Minimum selection: {MIN_CROP_SIZE} × {MIN_CROP_SIZE} pixels.</div>
      <div className="q-dialog-actions q-crop-actions">
        <Button type="button" variant="ghost" className="q-crop-reset" onClick={reset} disabled={!sourceSize || saving}><RotateCcw size={16} aria-hidden="true" />Reset selection</Button>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
        <Button type="button" onClick={() => void submit()} disabled={!crop || !sourceSize || saving}><Crop size={16} aria-hidden="true" />{saving ? 'Attaching…' : 'Attach crop'}</Button>
      </div>
    </DialogContent>
  </Dialog>;
}
