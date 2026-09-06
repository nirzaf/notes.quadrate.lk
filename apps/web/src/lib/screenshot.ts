export type ScreenshotMode = 'visible' | 'full-page' | 'crop';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export const MIN_CROP_SIZE = 16;
export const MAX_CAPTURE_PIXELS = 48_000_000;
export const MAX_CAPTURE_SCALE = 2;
export const MIN_CAPTURE_SCALE = 0.5;

type ScreenshotCaptureErrorCode = 'unsupported' | 'too-large' | 'invalid-crop';

export class ScreenshotCaptureError extends Error {
  readonly code: ScreenshotCaptureErrorCode;

  constructor(message: string, code: ScreenshotCaptureErrorCode) {
    super(message);
    this.name = 'ScreenshotCaptureError';
    this.code = code;
  }
}

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function minimumSize(bounds: ImageSize, requested = MIN_CROP_SIZE): ImageSize {
  return { width: Math.min(requested, Math.max(0, bounds.width)), height: Math.min(requested, Math.max(0, bounds.height)) };
}

export function clampCropRect(rect: CropRect, bounds: ImageSize, minimum = MIN_CROP_SIZE): CropRect {
  const widthLimit = Math.max(0, finite(bounds.width, 0));
  const heightLimit = Math.max(0, finite(bounds.height, 0));
  const min = minimumSize({ width: widthLimit, height: heightLimit }, Math.max(0, minimum));
  const width = clamp(finite(rect.width, min.width), min.width, widthLimit);
  const height = clamp(finite(rect.height, min.height), min.height, heightLimit);
  return {
    x: clamp(finite(rect.x, 0), 0, Math.max(0, widthLimit - width)),
    y: clamp(finite(rect.y, 0), 0, Math.max(0, heightLimit - height)),
    width,
    height,
  };
}

export function normalizeCropRect(start: { x: number; y: number }, end: { x: number; y: number }, bounds: ImageSize, minimum = MIN_CROP_SIZE): CropRect {
  return clampCropRect({ x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }, bounds, minimum);
}

export function moveCropRect(rect: CropRect, delta: { x: number; y: number }, bounds: ImageSize, minimum = MIN_CROP_SIZE): CropRect {
  const safe = clampCropRect(rect, bounds, minimum);
  return { ...safe, x: clamp(safe.x + finite(delta.x, 0), 0, Math.max(0, bounds.width - safe.width)), y: clamp(safe.y + finite(delta.y, 0), 0, Math.max(0, bounds.height - safe.height)) };
}

export type CropHandle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export function resizeCropRect(rect: CropRect, handle: CropHandle, delta: { x: number; y: number }, bounds: ImageSize, minimum = MIN_CROP_SIZE): CropRect {
  const safe = clampCropRect(rect, bounds, minimum);
  const minWidth = Math.min(Math.max(0, minimum), bounds.width);
  const minHeight = Math.min(Math.max(0, minimum), bounds.height);
  let left = safe.x;
  let top = safe.y;
  let right = safe.x + safe.width;
  let bottom = safe.y + safe.height;
  const dx = finite(delta.x, 0);
  const dy = finite(delta.y, 0);
  if (handle.includes('w')) left = clamp(left + dx, 0, right - minWidth);
  if (handle.includes('e')) right = clamp(right + dx, left + minWidth, bounds.width);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - minHeight);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + minHeight, bounds.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function previewPointToSource(point: { x: number; y: number }, preview: ImageSize, source: ImageSize): { x: number; y: number } {
  return { x: clamp(finite(point.x, 0) * source.width / Math.max(preview.width, 1), 0, source.width), y: clamp(finite(point.y, 0) * source.height / Math.max(preview.height, 1), 0, source.height) };
}

export function previewRectToSourceRect(rect: CropRect, preview: ImageSize, source: ImageSize, minimum = MIN_CROP_SIZE): CropRect {
  return clampCropRect({ x: rect.x * source.width / Math.max(preview.width, 1), y: rect.y * source.height / Math.max(preview.height, 1), width: rect.width * source.width / Math.max(preview.width, 1), height: rect.height * source.height / Math.max(preview.height, 1) }, source, minimum);
}

export function sourceRectToPreviewRect(rect: CropRect, source: ImageSize, preview: ImageSize): CropRect {
  return { x: rect.x * preview.width / Math.max(source.width, 1), y: rect.y * preview.height / Math.max(source.height, 1), width: rect.width * preview.width / Math.max(source.width, 1), height: rect.height * preview.height / Math.max(source.height, 1) };
}

export function captureScaleForDimensions(width: number, height: number): number {
  const pixels = Math.max(0, finite(width, 0)) * Math.max(0, finite(height, 0));
  if (!pixels) throw new ScreenshotCaptureError('This page has no capturable content.', 'too-large');
  const scale = Math.min(MAX_CAPTURE_SCALE, Math.sqrt(MAX_CAPTURE_PIXELS / pixels));
  if (scale < MIN_CAPTURE_SCALE) throw new ScreenshotCaptureError('This page is too large to capture as one image. Use Visible Area or Cropped Zone instead.', 'too-large');
  return scale;
}

export function isDisplayCaptureSupported(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);
}

export function isScreenshotCancellation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const name = 'name' in error && typeof error.name === 'string' ? error.name : '';
  return name === 'NotAllowedError' || name === 'AbortError' || name === 'InvalidStateError' || name === 'NotFoundError';
}

function waitForPaint(): Promise<void> {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return new Promise((resolve) => setTimeout(resolve, 0));
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

export async function waitForScreenshotLayout(): Promise<void> {
  await waitForPaint();
  await waitForPaint();
  if (typeof document !== 'undefined' && 'fonts' in document) await document.fonts.ready;
}

async function waitForVideoDimensions(video: HTMLVideoElement): Promise<void> {
  if (video.videoWidth > 0 && video.videoHeight > 0) return;
  await new Promise<void>((resolve, reject) => {
    let timer: number | undefined;
    const finish = (error?: Error) => {
      if (timer !== undefined) window.clearTimeout(timer);
      video.removeEventListener('loadedmetadata', check);
      video.removeEventListener('loadeddata', check);
      video.removeEventListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const check = () => { if (video.videoWidth > 0 && video.videoHeight > 0) finish(); };
    const onError = () => finish(new Error('The browser did not provide a capturable video frame.'));
    video.addEventListener('loadedmetadata', check);
    video.addEventListener('loadeddata', check);
    video.addEventListener('error', onError);
    timer = window.setTimeout(() => finish(new Error('The browser did not provide a capturable video frame.')), 10_000);
    check();
  });
}

async function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  const videoWithFrameCallback = video as HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };
  if (typeof videoWithFrameCallback.requestVideoFrameCallback === 'function') {
    await new Promise<void>((resolve) => { videoWithFrameCallback.requestVideoFrameCallback?.(() => resolve()); });
    return;
  }
  await waitForPaint();
  await waitForPaint();
}

function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => { if (blob) resolve(blob); else reject(new Error('The browser could not encode the screenshot as PNG.')); }, 'image/png');
  });
}

export async function captureVisibleScreenshot(): Promise<Blob> {
  if (!isDisplayCaptureSupported()) throw new ScreenshotCaptureError('Screen capture is not supported by this browser. You can still upload an image file.', 'unsupported');
  // Keep this call directly in the user-initiated flow; display capture requires transient activation.
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
  const video = document.createElement('video');
  let canvas: HTMLCanvasElement | null = null;
  const stopTracks = () => stream.getTracks().forEach((track) => track.stop());
  try {
    if (!stream.getVideoTracks().length) throw new Error('The browser did not provide a video track.');
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    await waitForVideoDimensions(video);
    await video.play();
    await waitForVideoFrame(video);
    if (!video.videoWidth || !video.videoHeight) throw new Error('The browser did not provide a capturable video frame.');
    if (video.videoWidth * video.videoHeight > MAX_CAPTURE_PIXELS) throw new ScreenshotCaptureError('The selected display is too large to capture safely. Choose a smaller display or window.', 'too-large');
    canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a screenshot canvas.');
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    stopTracks();
    return await canvasToPng(canvas);
  } finally {
    stopTracks();
    video.pause();
    video.srcObject = null;
    if (canvas) { canvas.width = 1; canvas.height = 1; }
  }
}

export async function cropScreenshot(source: Blob, crop: CropRect): Promise<Blob> {
  const image = await createImageBitmap(source);
  try {
    const safe = clampCropRect(crop, { width: image.width, height: image.height });
    if (safe.width < MIN_CROP_SIZE || safe.height < MIN_CROP_SIZE) throw new ScreenshotCaptureError('Select a larger area before attaching the crop.', 'invalid-crop');
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(safe.width));
    canvas.height = Math.max(1, Math.round(safe.height));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The browser could not create a crop canvas.');
    context.drawImage(image, safe.x, safe.y, safe.width, safe.height, 0, 0, canvas.width, canvas.height);
    return await canvasToPng(canvas);
  } finally {
    image.close();
  }
}

export async function captureFullPageScreenshot(target: HTMLElement): Promise<Blob> {
  const width = Math.max(target.clientWidth, target.scrollWidth);
  const height = Math.max(target.clientHeight, target.scrollHeight);
  const scale = captureScaleForDimensions(width, height);
  const loaded = await import('dom-to-image-more');
  const domToImage = 'default' in loaded ? loaded.default : loaded;
  const blob = await domToImage.toBlob(target, {
    width,
    height,
    scale,
    pixelRatio: 1,
    bgcolor: '#fffdf8',
    ignoreCSSRuleErrors: true,
    logger: {},
    preserveScroll: false,
    style: { width: `${width}px`, height: `${height}px`, maxHeight: 'none', overflow: 'visible' },
    filter: (node) => !(node instanceof Element && node.getAttribute('data-screenshot-exclude') === 'true'),
  });
  if (!blob.size) throw new Error('The browser created an empty screenshot.');
  return blob;
}

export function screenshotFile(blob: Blob, mode: ScreenshotMode): File {
  const suffix = mode === 'full-page' ? 'page' : mode;
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  return new File([blob], `screenshot-${suffix}-${timestamp}.png`, { type: 'image/png' });
}
