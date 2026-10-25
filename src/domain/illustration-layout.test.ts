import { describe, expect, it } from 'vitest';
import type { Book, Chapter } from './book.js';
import {
  applyIllustrationLayout,
  chapterSha256,
  parseIllustrationMap,
  type IllustrationMap,
} from './illustration-layout.js';
import { prepareIllustrationLayout } from '../service/illustration-layout.js';

const imageUrl = 'https://example.test/image.png';
const digest = 'a'.repeat(64);

function fixture(): Book {
  return {
    id: 42,
    title: '合成书',
    author: '测试作者',
    language: 'zh-CN',
    description: '',
    sourceUrl: 'https://example.test/book/42',
    catalogueUrl: 'https://example.test/index',
    metadata: {},
    assets: [
      {
        id: 'image',
        sourceUrl: imageUrl,
        relativePath: 'image.png',
        mediaType: 'image/png',
        sha256: digest,
        bytes: 12,
        role: 'illustration',
      },
    ],
    volumes: [
      {
        id: 'v',
        index: 0,
        title: '卷',
        chapters: [
          {
            id: 'one',
            index: 0,
            title: '章一',
            sourceUrl: 'https://example.test/one',
            blocks: [
              { type: 'paragraph', text: '前文' },
              { type: 'paragraph', text: '第一章 插图001' },
              { type: 'paragraph', text: '中间' },
              { type: 'paragraph', text: '（插图002）' },
            ],
          },
          {
            id: 'two',
            index: 1,
            title: '章二',
            sourceUrl: 'https://example.test/two',
            blocks: [{ type: 'paragraph', text: '第二章 插图001' }],
          },
          {
            id: 'gallery',
            index: 2,
            title: '插图',
            sourceUrl: 'https://example.test/gallery',
            blocks: [
              { type: 'image', sourceUrl: imageUrl, assetId: 'image', alt: '插图' },
              { type: 'separator' },
              { type: 'image', sourceUrl: imageUrl, assetId: 'image', alt: '保留的另一位置' },
            ],
          },
        ],
      },
    ],
  };
}

function mapping(book: Book): IllustrationMap {
  const [first, second, gallery] = book.volumes[0]!.chapters as [Chapter, Chapter, Chapter];
  return {
    version: 1,
    bookId: 42,
    entries: [first, second].map((chapter, index) => ({
      target: {
        chapterUrl: chapter.sourceUrl,
        chapterSha256: chapterSha256(chapter),
        blockIndex: index === 0 ? 1 : 0,
        marker: index === 0 ? '第一章 插图001' : '第二章 插图001',
      },
      image: {
        chapterUrl: gallery.sourceUrl,
        chapterSha256: chapterSha256(gallery),
        blockIndex: 0,
        sourceUrl: imageUrl,
        assetSha256: digest,
      },
      evidence: { reference: '合成本地排版参考' },
    })),
  };
}

describe('verified illustration layout', () => {
  it('moves one selected occurrence to two chapter-local targets, retaining unselected occurrences and prose', () => {
    const book = fixture();
    const before = structuredClone(book);
    const prepared = prepareIllustrationLayout(book, mapping(book));
    const result = applyIllustrationLayout(prepared.book, prepared.plan);
    const chapters = result.volumes[0]!.chapters;
    expect(chapters[0]!.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'image',
      'paragraph',
      'paragraph',
    ]);
    expect(chapters[1]!.blocks[0]).toMatchObject({ type: 'image', assetId: 'image' });
    expect(chapters[2]!.blocks).toEqual([
      book.volumes[0]!.chapters[2]!.blocks[1],
      book.volumes[0]!.chapters[2]!.blocks[2],
    ]);
    expect(result.assets).toHaveLength(1);
    expect(prepared.report.counts).toEqual({
      recoveredUrls: 0,
      appliedMappings: 2,
      unresolvedSymbols: 1,
      legacyUrlFragments: 0,
    });
    expect(book).toEqual(before);
    const repeat = prepareIllustrationLayout(book, mapping(book));
    expect(applyIllustrationLayout(repeat.book, repeat.plan)).toEqual(result);
  });
  it('drops only exhausted image-only chapters, retaining chapters with prose', () => {
    const book = fixture();
    const gallery = book.volumes[0]!.chapters[2]!;
    gallery.blocks.pop();
    let prepared = prepareIllustrationLayout(book, mapping(book));
    expect(applyIllustrationLayout(prepared.book, prepared.plan).volumes[0]!.chapters).toHaveLength(
      2,
    );
    gallery.blocks.push({ type: 'paragraph', text: '图片说明' });
    prepared = prepareIllustrationLayout(book, mapping(book));
    expect(
      applyIllustrationLayout(prepared.book, prepared.plan).volumes[0]!.chapters[2]!.blocks,
    ).toEqual([{ type: 'separator' }, { type: 'paragraph', text: '图片说明' }]);
  });
  it.each([
    'version',
    'book',
    'target',
    'duplicate',
    'chapter',
    'source',
    'cross-volume',
    'chapter-url',
    'unrecognized',
    'whitespace',
    'negative-index',
  ])('rejects the entire invalid %s map without mutating its input', (scenario) => {
    const book = fixture();
    const map = mapping(book);
    switch (scenario) {
      case 'version':
        Object.assign(map, { version: 2 });
        break;
      case 'book':
        map.bookId++;
        break;
      case 'target':
        map.entries[1]!.target.blockIndex = 9;
        break;
      case 'duplicate':
        map.entries.push(structuredClone(map.entries[0]!));
        break;
      case 'chapter':
        book.volumes[0]!.chapters[0]!.blocks.push({ type: 'paragraph', text: '改版正文' });
        break;
      case 'source':
        map.entries[1]!.image.sourceUrl += '?new';
        break;
      case 'cross-volume':
        book.volumes.push({
          id: 'other',
          index: 1,
          title: '另一卷',
          chapters: [book.volumes[0]!.chapters.pop()!],
        });
        break;
      case 'chapter-url':
        book.volumes[0]!.chapters.push(structuredClone(book.volumes[0]!.chapters[0]!));
        break;
      case 'unrecognized':
        map.entries[1]!.target.blockIndex = 0;
        map.entries[1]!.target.chapterUrl = book.volumes[0]!.chapters[0]!.sourceUrl;
        map.entries[1]!.target.chapterSha256 = chapterSha256(book.volumes[0]!.chapters[0]!);
        map.entries[1]!.target.marker = '前文';
        break;
      case 'whitespace':
        map.entries[0]!.target.marker += ' ';
        break;
      case 'negative-index':
        map.entries[1]!.target.blockIndex = -1;
        break;
    }
    const before = structuredClone(book);
    expect(() => prepareIllustrationLayout(book, map)).toThrow(/插图映射校验失败/);
    expect(book).toEqual(before);
  });
  it.each(['missing', 'changed'])(
    'rejects %s mapped resources before applying any movement',
    (scenario) => {
      const prepared = prepareIllustrationLayout(fixture(), mapping(fixture()));
      if (scenario === 'missing') prepared.book.assets = [];
      else prepared.book.assets[0]!.sha256 = 'b'.repeat(64);
      const before = structuredClone(prepared.book);
      expect(() => applyIllustrationLayout(prepared.book, prepared.plan)).toThrow(
        /IMAGE_RESOURCE_CHANGED_OR_MISSING/,
      );
      expect(prepared.book).toEqual(before);
    },
  );
  it('hashes only canonical source blocks, including image alt and excluding assetId', () => {
    const chapter = fixture().volumes[0]!.chapters[2]!;
    const original = chapterSha256(chapter);
    chapter.title = '重命名';
    chapter.blocks[0] = { alt: '插图', sourceUrl: imageUrl, type: 'image', assetId: 'different' };
    expect(chapterSha256(chapter)).toBe(original);
    chapter.blocks[0].alt = '另一说明';
    expect(chapterSha256(chapter)).not.toBe(original);
  });
  it('validates strict map input and never accepts unknown version or empty provenance', () => {
    const map = mapping(fixture());
    expect(parseIllustrationMap(JSON.parse(JSON.stringify(map)))).toEqual(map);
    expect(() => parseIllustrationMap({ ...map, extra: true })).toThrow(/MAP_INVALID/);
    map.entries[0]!.evidence.reference = '  ';
    expect(() => parseIllustrationMap(map)).toThrow(/MAP_INVALID/);
  });
  it('restores URLs without removing gallery duplicates or creating missing symbol images', () => {
    const book = fixture();
    const first = book.volumes[0]!.chapters[0]!;
    first.blocks.push(
      { type: 'paragraph', text: `[IMG]${imageUrl}?x=%2f[/IMG]` },
      { type: 'image', sourceUrl: null, alt: '图片' },
      { type: 'paragraph', text: '[IMG]' },
    );
    const prepared = prepareIllustrationLayout(book);
    expect(prepared.book.volumes[0]!.chapters[0]!.blocks.at(-3)).toEqual({
      type: 'image',
      sourceUrl: `${imageUrl}?x=%2f`,
      alt: '插图',
    });
    expect(prepared.report.counts).toEqual({
      recoveredUrls: 1,
      appliedMappings: 0,
      unresolvedSymbols: 3,
      legacyUrlFragments: 1,
    });
    expect(
      prepared.report.diagnostics.find((item) => item.code === 'LEGACY_URL_FRAGMENT'),
    ).not.toHaveProperty('marker');
    expect(prepared.book.volumes[0]!.chapters[2]).toEqual(book.volumes[0]!.chapters[2]);
  });
});
