import { describe, expect, it } from 'vitest';
import { detectIllustrationMarker } from './illustrations.js';
import { parseChapter, parsePackedChapter } from './parser.js';

const chapter = {
  id: 'test',
  index: 0,
  title: '合成章',
  sourceUrl: 'https://example.test/1.htm',
  blocks: [],
};

describe('illustration markers', () => {
  it.each([
    '（插图008）',
    '(插图008)',
    '第一章 插图001',
    '第12章　插图002',
    '插图001_fmt',
    '插图001_scan_fmt',
    '  （插图0008）\u3000',
  ])('recognizes an exact symbol and preserves its original text: %s', (text) => {
    expect(detectIllustrationMarker({ type: 'paragraph', text })).toEqual({
      kind: 'symbol',
      marker: text,
    });
    expect(detectIllustrationMarker({ type: 'heading', text })).toBeUndefined();
    expect(detectIllustrationMarker({ type: 'note', text })).toBeUndefined();
  });
  it.each([
    '插图001',
    '[插图001]',
    '（插圖001）',
    '（插图 001）',
    '（插图001)',
    '插图001_fmt.jpg',
    '插图pic4_0124_fmt',
    '见（插图001）',
    '第一章插图001',
    '第一章 插图001。',
    '第一章\t插图001',
  ])('leaves unsupported text alone: %s', (text) => {
    expect(detectIllustrationMarker({ type: 'paragraph', text })).toBeUndefined();
  });
  it.each(['jpg', 'JPEG', 'png', 'gif', 'webp', 'avif'])(
    'recovers the complete %s URL from an offline HTML paragraph',
    (extension) => {
      const sourceUrl = `https://example.test/p%20x.${extension}?size=large&v=%2f#page`;
      for (const text of [`[IMG]${sourceUrl}[/IMG]`, `  img]${sourceUrl}[/img]  `]) {
        const parsed = parseChapter(
          `<div id="content"><p>${text.replaceAll('&', '&amp;')}</p></div>`,
          chapter,
        );
        expect(detectIllustrationMarker(parsed.blocks[0]!)).toMatchObject({
          kind: 'url',
          sourceUrl,
        });
      }
    },
  );
  it.each([
    'https://example.test/a.jpg',
    '正文 [IMG]https://example.test/a.jpg[/IMG] 继续',
    '[IMG]file:///tmp/a.jpg[/IMG]',
    '[IMG]https://example.test/a.jpg[/IMG][IMG]https://example.test/b.jpg[/IMG]',
    '[IMG]https://example.test/a b.jpg[/IMG]',
    '[IMG]https://example.test/a.htm[/IMG]',
    'IMG]https://example.test/a.htm[/IMG]',
    '正文提到 [/IMG]',
    '[IMG]https://example.test/a.jpg',
  ])('never restores unsupported or mixed URL text: %s', (text) => {
    expect(detectIllustrationMarker({ type: 'paragraph', text })).toBeUndefined();
  });
  it('diagnoses split packed references without inventing their missing URL parameters', () => {
    const packed = parsePackedChapter('[IMG]https://example.test/a.jpg?size=large[/IMG]', chapter);
    expect(packed.blocks).toEqual([
      { type: 'paragraph', text: '[IMG]' },
      { type: 'image', sourceUrl: 'https://example.test/a.jpg', alt: '插图' },
      { type: 'paragraph', text: '?size=large[/IMG]' },
    ]);
    expect(packed.blocks.map(detectIllustrationMarker)).toEqual([
      { kind: 'fragment' },
      undefined,
      { kind: 'fragment' },
    ]);
  });
});
