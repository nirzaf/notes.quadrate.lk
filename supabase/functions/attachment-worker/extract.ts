import { extractText } from 'unpdf';

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
    const pages = result.text.map((page) => page.trim());
    const text = pages.join('\n').replace(/\s+/g, ' ').trim();
    return text ? { status: 'ready', text, pages, error: null } : { status: 'ready', text: '', pages: [], error: 'NO_EXTRACTABLE_TEXT' };
  }
  return { status: 'unsupported', text: '', pages: [], error: 'UNSUPPORTED_ATTACHMENT_TYPE' };
}

export function attachmentParagraphs(text: string): string[] {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    for (let index = 0; index < words.length; index += 350) chunks.push(words.slice(index, index + 350).join(' '));
  }
  return chunks;
}
