import { extractText } from 'unpdf';
import { chunkText } from '@qnotes/markdown';

export interface ExtractedAttachment {
  status: 'ready' | 'unsupported';
  text: string;
  pages: string[];
  error: string | null;
}

export async function extractAttachment(bytes: Uint8Array, mimeType: string): Promise<ExtractedAttachment> {
  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/webp') return { status: 'unsupported', text: '', pages: [], error: 'IMAGE_OCR_UNSUPPORTED' };
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') {
    const text = new TextDecoder().decode(bytes).trim();
    return text ? { status: 'ready', text, pages: [text], error: null } : { status: 'ready', text: '', pages: [], error: 'NO_EXTRACTABLE_TEXT' };
  }
  if (mimeType === 'application/pdf') {
    const result = await extractText(bytes, { mergePages: false });
    const pages = result.text.map((page) => page.replace(/\r\n?/g, '\n').trim());
    const text = pages.join('\n\n').trim();
    return text ? { status: 'ready', text, pages, error: null } : { status: 'ready', text: '', pages: [], error: 'NO_EXTRACTABLE_TEXT' };
  }
  return { status: 'unsupported', text: '', pages: [], error: 'UNSUPPORTED_ATTACHMENT_TYPE' };
}

export function attachmentParagraphs(text: string): string[] {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  return paragraphs.flatMap((paragraph) => chunkText(paragraph, 350, 40));
}
