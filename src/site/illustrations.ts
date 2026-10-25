import type { ContentBlock } from '../domain/book.js';

export type IllustrationMarker =
  | { kind: 'symbol'; marker: string }
  | { kind: 'url'; marker: string; sourceUrl: string }
  | { kind: 'fragment' };

export function detectIllustrationMarker(block: ContentBlock): IllustrationMarker | undefined {
  if (block.type !== 'paragraph') return;
  const text = block.text.trim();
  const urlMatch = /^(?:\[IMG\]|IMG\])([^\s]+)\[\/IMG\]$/i.exec(text);
  if (urlMatch) {
    const sourceUrl = urlMatch[1]!;
    try {
      const url = new URL(sourceUrl);
      if (
        /^https?:$/.test(url.protocol) &&
        !/\[\/?IMG\]/i.test(sourceUrl) &&
        /\.(?:jpe?g|png|gif|webp|avif)$/i.test(url.pathname)
      ) {
        return { kind: 'url', marker: block.text, sourceUrl };
      }
    } catch {
      // An invalid URL stays in the source paragraph.
    }
  }
  if (
    /^(?:（插图[0-9]+）|\(插图[0-9]+\)|第[0-9一二三四五六七八九十百千零〇两]+章[ \u3000]+插图[0-9]+|插图[0-9]+(?:_[A-Za-z0-9]+)+)$/.test(
      text,
    )
  ) {
    return { kind: 'symbol', marker: block.text };
  }
  if (/^(?:\[IMG\]|IMG\]|(?:[?#]\S*)?\[\/IMG\])$/i.test(text)) {
    return { kind: 'fragment' };
  }
}
