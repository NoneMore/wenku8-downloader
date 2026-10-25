import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { inflateRawSync } from 'node:zlib';
import { load } from 'cheerio';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { create } from 'xmlbuilder2';
import type { Book } from '../domain/book.js';
import { sha256 } from '../domain/ids.js';
import { EpubBuilder } from './builder.js';

const execFileAsync = promisify(execFile);
const timeout = process.env.CI_EPUBCHECK === '1' ? 30_000 : 5_000;

describe('EpubBuilder', () => {
  it('builds an EPUB with uncompressed mimetype first', { timeout }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-epub-'));
    const image = await sharp({
      create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
    })
      .jpeg()
      .toBuffer();
    await writeFile(path.join(root, 'image.jpg'), image);
    const book: Book = {
      id: 1,
      title: '测试书',
      author: '作者',
      language: 'zh-CN',
      description: '简介',
      sourceUrl: 'https://example/book/1',
      catalogueUrl: 'https://example/book/1/index',
      metadata: {},
      coverAssetId: 'a1',
      assets: [
        {
          id: 'a1',
          sourceUrl: 'https://example/image.jpg',
          relativePath: 'image.jpg',
          mediaType: 'image/jpeg',
          sha256: sha256(image),
          bytes: image.byteLength,
          width: 8,
          height: 8,
          role: 'cover',
        },
      ],
      volumes: [
        {
          id: 'v1',
          index: 0,
          title: '第一卷',
          chapters: [
            {
              id: 'c1',
              index: 0,
              title: '第一章',
              sourceUrl: 'https://example/c1',
              blocks: [
                { type: 'paragraph', text: '正文内容' },
                {
                  type: 'image',
                  sourceUrl: 'https://example/image.jpg',
                  assetId: 'a1',
                  alt: '插图',
                },
              ],
            },
          ],
        },
      ],
    };
    const output = path.join(root, 'book.epub');
    await new EpubBuilder().build(book, root, output);
    const zip = await readFile(output);
    expect(
      await readFile(path.join(root, 'epub', 'package', 'EPUB', 'nav.xhtml'), 'utf8'),
    ).toContain('href="cover.xhtml"');
    const files = readZip(zip);
    const { opf, spine } = inspectPackage(files);
    expect(opf('spine > itemref').first().attr('idref')).toBe('cover-page');
    expect(opf('spine > itemref').first().attr('linear')).toBe('no');
    expect(spine).toEqual([
      'EPUB/cover.xhtml',
      'EPUB/text/volume-0001.xhtml',
      'EPUB/text/0001.xhtml',
    ]);
    const chapter = parseXml(files.get(spine[2]!)!);
    expect(chapter('p').text()).toBe('正文内容');
    expect(
      chapter('section')
        .children()
        .map((_index, element) => element.tagName)
        .get(),
    ).toEqual(['h1', 'p', 'figure']);
    const imagePath = path.posix.join(path.posix.dirname(spine[2]!), chapter('img').attr('src')!);
    expect(files.get(imagePath)).toEqual(image);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(0);
    const filenameLength = zip.readUInt16LE(26);
    expect(zip.subarray(30, 30 + filenameLength).toString()).toBe('mimetype');
    expect(zip.byteLength).toBeGreaterThan(1000);
    await checkEpub(output);
  });

  it(
    'preserves multi-volume navigation and reading order with repeated and XML titles',
    { timeout },
    async () => {
      const book = makeBook();
      book.volumes[0]!.index = 99;
      book.volumes[1]!.index = 0;
      book.volumes[0]!.chapters[0]!.index = 99;
      const { files } = await buildFixture(book);
      const { spine } = inspectPackage(files);
      const nav = parseXml(files.get('EPUB/nav.xhtml')!);
      const volumeNodes = nav('nav > ol > li');
      expect(volumeNodes).toHaveLength(2);
      expect(nav('a[href="cover.xhtml"]')).toHaveLength(0);
      expect(spine).toHaveLength(6);

      const expectedSpine: string[] = [];
      for (const [volumeIndex, volume] of book.volumes.entries()) {
        const node = nav(volumeNodes[volumeIndex]);
        const volumeLink = node.children('a');
        expect(volumeLink.text()).toBe(volume.title);
        const volumePath = `EPUB/${volumeLink.attr('href')!}`;
        expectedSpine.push(volumePath);
        const titlePage = parseXml(files.get(volumePath)!);
        expect(titlePage('title').text()).toBe(volume.title);
        expect(titlePage('h1').text()).toBe(volume.title);
        expect(titlePage('section').attr('epub:type')).toBe('part');
        const chapterNodes = node.children('ol').children('li');
        expect(chapterNodes).toHaveLength(2);
        for (const [chapterIndex, chapter] of volume.chapters.entries()) {
          const chapterLink = nav(chapterNodes[chapterIndex]).children('a');
          expect(chapterLink.text()).toBe(chapter.title);
          const chapterPath = `EPUB/${chapterLink.attr('href')!}`;
          expectedSpine.push(chapterPath);
          const document = parseXml(files.get(chapterPath)!);
          expect(document('h1').text()).toBe(chapter.title);
          expect(
            document('p')
              .map((_index, element) => document(element).text())
              .get(),
          ).toEqual(chapter.blocks.map((block) => ('text' in block ? block.text : '')));
        }
      }
      expect(new Set(expectedSpine).size).toBe(6);
      expect(spine).toEqual(expectedSpine);
    },
  );

  it(
    'keeps distinct navigation targets and manifest IDs when source IDs repeat',
    { timeout },
    async () => {
      const book = makeBook();
      for (const [volumeIndex, volume] of book.volumes.entries()) {
        volume.id = 'same-volume';
        volume.title = `卷 ${volumeIndex}`;
        for (const chapter of volume.chapters) chapter.id = 'same-chapter';
      }
      const { files } = await buildFixture(book);
      const { spine } = inspectPackage(files);
      const nav = parseXml(files.get('EPUB/nav.xhtml')!);
      const targets = nav('nav a')
        .map((_index, link) => `EPUB/${nav(link).attr('href')!}`)
        .get();
      expect(targets).toHaveLength(6);
      expect(new Set(targets).size).toBe(6);
      expect(targets).toEqual(spine);
      for (const [volumeIndex, volume] of book.volumes.entries()) {
        expect(parseXml(files.get(targets[volumeIndex * 3]!)!)('h1').text()).toBe(volume.title);
        for (const [chapterIndex, chapter] of volume.chapters.entries()) {
          const document = parseXml(files.get(targets[volumeIndex * 3 + chapterIndex + 1]!)!);
          expect(
            document('p')
              .map((_index, element) => document(element).text())
              .get(),
          ).toEqual(chapter.blocks.map((block) => ('text' in block ? block.text : '')));
        }
      }
    },
  );

  it.each(['第一卷', '正文'])(
    'keeps a title page and nested navigation for a single %s volume',
    { timeout },
    async (title) => {
      const book = makeBook();
      book.volumes = [book.volumes[0]!];
      book.volumes[0]!.title = title;
      const { files } = await buildFixture(book);
      const { spine } = inspectPackage(files);
      const nav = parseXml(files.get('EPUB/nav.xhtml')!);
      expect(nav('nav > ol > li')).toHaveLength(1);
      expect(nav('nav > ol > li > a').text()).toBe(title);
      expect(nav('nav > ol > li > ol > li')).toHaveLength(2);
      expect(spine).toHaveLength(3);
      expect(parseXml(files.get(spine[0]!)!)('h1').text()).toBe(title);
    },
  );

  it(
    'keeps empty volumes between populated volumes and at the end without empty lists',
    { timeout },
    async () => {
      const book = makeBook();
      book.volumes.splice(1, 0, { id: 'empty-middle', index: 1, title: '空卷', chapters: [] });
      book.volumes.push({ id: 'empty-end', index: 3, title: '空卷', chapters: [] });
      const { files } = await buildFixture(book);
      const { spine } = inspectPackage(files);
      const nav = parseXml(files.get('EPUB/nav.xhtml')!);
      const nodes = nav('nav > ol > li');
      expect(nodes).toHaveLength(4);
      for (const index of [1, 3]) {
        const node = nav(nodes[index]);
        expect(node.children('a').text()).toBe('空卷');
        expect(node.children('ol')).toHaveLength(0);
        const href = `EPUB/${node.children('a').attr('href')!}`;
        expect(spine.indexOf(href)).toBe(index === 1 ? 3 : 7);
        expect(parseXml(files.get(href)!)('h1').text()).toBe('空卷');
      }
      expect(spine).toHaveLength(8);
    },
  );

  it.each(['no volumes', 'no chapters', 'missing image'])(
    'preserves completeness validation for %s',
    { timeout },
    async (scenario) => {
      const book = makeBook();
      if (scenario === 'no volumes') book.volumes = [];
      if (scenario === 'no chapters')
        book.volumes.forEach((volume) => {
          volume.chapters = [];
        });
      if (scenario === 'missing image') {
        book.volumes[0]!.chapters[0]!.blocks.push({ type: 'image', sourceUrl: null, alt: '图片' });
      }
      const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-epub-'));
      const output = path.join(root, 'book.epub');
      const builder = new EpubBuilder();
      await expect(builder.build(book, root, output)).rejects.toThrow(
        scenario === 'missing image' ? /无法定位来源/ : /目录中没有/,
      );
      await expect(builder.build(book, root, output, { allowMissingImages: true })).resolves.toBe(
        output,
      );
      if (scenario === 'missing image') {
        const files = readZip(await readFile(output));
        const { spine } = inspectPackage(files);
        expect(parseXml(files.get(spine[1]!)!)('.missing-image').text()).toBe('【图片】');
        await checkEpub(output);
      }
    },
  );
});

function makeBook(): Book {
  return {
    id: 1,
    title: '离线测试书',
    author: '作者',
    language: 'zh-CN',
    description: '测试简介',
    sourceUrl: 'https://example/book/1',
    catalogueUrl: 'https://example/book/1/index',
    metadata: {},
    assets: [],
    volumes: [0, 1].map((volumeIndex) => ({
      id: `v${volumeIndex}`,
      index: volumeIndex,
      title: '卷 & <同名> "标题"',
      chapters: [0, 1].map((chapterIndex) => ({
        id: `c${volumeIndex}-${chapterIndex}`,
        index: chapterIndex,
        title: `章节 ${chapterIndex} & <标题>`,
        sourceUrl: `https://example/c${volumeIndex}-${chapterIndex}`,
        blocks: [
          { type: 'paragraph', text: `正文 ${volumeIndex}-${chapterIndex}` },
          { type: 'paragraph', text: '第二段 & <原文>' },
        ],
      })),
    })),
  };
}

async function buildFixture(book: Book): Promise<{ files: Map<string, Buffer> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-epub-'));
  const output = path.join(root, 'book.epub');
  await new EpubBuilder().build(book, root, output);
  await checkEpub(output);
  return { files: readZip(await readFile(output)) };
}

async function checkEpub(output: string): Promise<void> {
  if (process.env.CI_EPUBCHECK !== '1') return;
  const jar = process.env.EPUBCHECK_JAR;
  if (jar) await execFileAsync('java', ['-jar', jar, output]);
  else await execFileAsync('epubcheck', [output]);
}

function parseXml(content: Buffer) {
  const xml = content.toString('utf8');
  create(xml);
  return load(xml, { xmlMode: true });
}

function inspectPackage(files: Map<string, Buffer>) {
  const opf = parseXml(files.get('EPUB/package.opf')!);
  const manifest = new Map<string, string>();
  opf('manifest > item').each((_index, item) => {
    const id = opf(item).attr('id')!;
    const href = `EPUB/${opf(item).attr('href')!}`;
    expect(manifest.has(id)).toBe(false);
    expect(files.has(href)).toBe(true);
    manifest.set(id, href);
  });
  expect(new Set(manifest.values()).size).toBe(manifest.size);
  const spine = opf('spine > itemref')
    .map((_index, item) => {
      const idref = opf(item).attr('idref')!;
      expect(manifest.has(idref)).toBe(true);
      return manifest.get(idref)!;
    })
    .get();
  expect(new Set(spine).size).toBe(spine.length);
  const nav = parseXml(files.get('EPUB/nav.xhtml')!);
  nav('a').each((_index, link) => {
    const href = `EPUB/${nav(link).attr('href')!}`;
    expect(files.has(href)).toBe(true);
    expect([...manifest.values()]).toContain(href);
  });
  for (const [filename, content] of files) {
    if (filename.endsWith('.xhtml')) {
      const document = parseXml(content);
      document('[href], [src]').each((_index, element) => {
        const target = document(element).attr('href') ?? document(element).attr('src')!;
        expect(files.has(path.posix.join(path.posix.dirname(filename), target))).toBe(true);
      });
    }
  }
  return { opf, spine };
}

// Read the central directory because streamed ZIP entries can use data descriptors.
function readZip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const method = zip.readUInt16LE(offset + 10);
    const size = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const local = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const compressed = zip.subarray(start, start + size);
    expect([0, 8]).toContain(method);
    expect(files.has(name)).toBe(false);
    files.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}
