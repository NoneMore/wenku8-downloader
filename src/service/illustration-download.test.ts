import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { load } from 'cheerio';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IllustrationMap } from '../domain/illustration-layout.js';
import { EpubBuilder } from '../epub/builder.js';
import { parseBookDetails, parseCatalogue, parseChapter } from '../site/parser.js';
import { Wenku8Client } from '../site/client.js';
import { Downloader } from './downloader.js';
import { inspectIllustrations } from './illustration-inspection.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-layout-download-'));
  directories.push(root);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#88aacc' } })
    .png()
    .toBuffer();
  const imageUrl = 'https://example.test/gallery.png';
  const urlMarkerImage = 'https://example.test/inline.png?size=large&v=%2f#page';
  const client = new Wenku8Client({ retries: 0 });
  const details =
    '<div id="content"><span><b>合成定位测试</b></span><div>小说作者：测试作者</div><a href="https://example.test/novel/42/index.htm">目录</a><div id="contentmain">合成简介</div></div>';
  const book = parseBookDetails(details, 42, 'https://www.wenku8.net/book/42.htm');
  vi.spyOn(client, 'getBookDetails').mockResolvedValue({ raw: details, book });
  const catalogue =
    '<table><tr><td colspan="2">第一卷</td></tr><tr><td><a href="1.htm">第一章</a></td><td><a href="2.htm">插图</a></td></tr></table>';
  vi.spyOn(client, 'getCatalogue').mockResolvedValue({
    raw: catalogue,
    volumes: parseCatalogue(catalogue, book.catalogueUrl),
  });
  const chapters = vi.spyOn(client, 'getChapter').mockImplementation((chapter) => {
    const raw =
      chapter.title === '插图'
        ? `<div id="content"><img src="${imageUrl}"></div>`
        : `<div id="content"><p>前文</p><p>（插图001）</p><p>后文</p><p>[IMG]${urlMarkerImage.replaceAll('&', '&amp;')}[/IMG]</p><p>（插图002）</p></div>`;
    return Promise.resolve({ raw, chapter: parseChapter(raw, chapter) });
  });
  const bytes = vi.spyOn(client.http, 'bytes').mockImplementation((url) => {
    if (url !== imageUrl && url !== urlMarkerImage) throw new Error('Unexpected URL');
    return Promise.resolve({
      data: image,
      response: new Response(image, { headers: { 'content-type': 'image/png' } }),
    });
  });
  const builder = new EpubBuilder();
  const build = vi.spyOn(builder, 'build');
  const downloader = new Downloader(client, builder);
  const options = { workDirectory: root, outputDirectory: root };
  const first = await downloader.download(42, options);
  const report = await inspectIllustrations(42, root);
  const target = report.markers.find((item) => item.kind === 'symbol')!;
  const source = report.images[0]!;
  const map: IllustrationMap = {
    version: 1,
    bookId: 42,
    entries: [
      {
        target: {
          chapterUrl: target.chapterUrl,
          chapterSha256: target.chapterSha256,
          blockIndex: target.blockIndex,
          marker: target.marker,
        },
        image: {
          chapterUrl: source.chapterUrl,
          chapterSha256: source.chapterSha256,
          blockIndex: source.blockIndex,
          sourceUrl: source.sourceUrl!,
          assetSha256: source.assetSha256!,
        },
        evidence: { reference: '合成排版参考' },
      },
    ],
  };
  return { root, first, options, downloader, map, bytes, chapters, build, urlMarkerImage };
}

describe('illustration download integration', () => {
  it('reuses old source caches, moves images into XHTML, removes empty gallery navigation and reverses by rebuilding from sources', async () => {
    const { first, downloader, options, map, bytes, chapters, urlMarkerImage } = await fixture();
    const sourcePaths = first.book.volumes[0]!.chapters.flatMap((chapter) => [
      path.join(first.workspaceDirectory, 'chapters', `${chapter.id}.json`),
      path.join(first.workspaceDirectory, 'raw', 'chapters', `${chapter.id}.html`),
    ]);
    const sourceBytes = await Promise.all(
      sourcePaths.map((filename) => readFile(filename, 'utf8')),
    );
    expect(bytes).toHaveBeenCalledTimes(1);
    expect(first.book.volumes[0]!.chapters).toHaveLength(2);
    expect(first.book.volumes[0]!.chapters[0]!.blocks[1]).toMatchObject({
      type: 'paragraph',
      text: '（插图001）',
    });
    chapters.mockClear();
    const result = await downloader.download(42, { ...options, illustrationMap: map });
    expect(chapters).not.toHaveBeenCalled();
    expect(bytes).toHaveBeenCalledTimes(2);
    expect(bytes.mock.calls[1]![0]).toBe(urlMarkerImage);
    expect(result.book.volumes[0]!.chapters).toHaveLength(1);
    expect(result.book.volumes[0]!.chapters[0]!.blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'image',
      'paragraph',
      'image',
      'paragraph',
    ]);
    const packageRoot = path.join(result.workspaceDirectory, 'epub', 'package', 'EPUB');
    const chapterXml = load(await readFile(path.join(packageRoot, 'text', '0001.xhtml'), 'utf8'), {
      xmlMode: true,
    });
    expect(
      chapterXml('section > p, section > figure')
        .map((_index, element) => element.tagName)
        .get(),
    ).toEqual(['p', 'figure', 'p', 'figure', 'p']);
    expect(chapterXml('figure img')).toHaveLength(2);
    expect(
      chapterXml('section > p')
        .map((_index, element) => chapterXml(element).text())
        .get(),
    ).toEqual(['前文', '后文', '（插图002）']);
    const nav = load(await readFile(path.join(packageRoot, 'nav.xhtml'), 'utf8'), {
      xmlMode: true,
    });
    expect(
      nav('nav a')
        .map((_index, element) => nav(element).text())
        .get(),
    ).toEqual(['第一卷', '第一章']);
    const layoutPath = path.join(result.workspaceDirectory, 'illustration-layout.json');
    const layoutText = await readFile(layoutPath, 'utf8');
    const layout = JSON.parse(layoutText) as {
      counts: unknown;
      sourceSnapshotSha256: string;
      mapSha256: string;
    };
    expect(layout.counts).toEqual({
      recoveredUrls: 1,
      appliedMappings: 1,
      unresolvedSymbols: 1,
      legacyUrlFragments: 0,
    });
    expect(layout.sourceSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(layout.mapSha256).toMatch(/^[a-f0-9]{64}$/);
    if (process.env.CI_EPUBCHECK === '1') {
      const run = promisify(execFile);
      if (process.env.EPUBCHECK_JAR)
        await run('java', ['-jar', process.env.EPUBCHECK_JAR, result.epubPath]);
      else await run('epubcheck', [result.epubPath]);
    }
    const repeated = await downloader.download(42, { ...options, illustrationMap: map });
    expect(repeated.book.volumes).toEqual(result.book.volumes);
    expect(repeated.book.assets).toHaveLength(result.book.assets.length);
    expect(repeated.book.assets).toEqual(expect.arrayContaining(result.book.assets));
    expect(await readFile(layoutPath, 'utf8')).toBe(layoutText);
    expect((await downloader.download(42, options)).book).toEqual(first.book);
    expect(await Promise.all(sourcePaths.map((filename) => readFile(filename, 'utf8')))).toEqual(
      sourceBytes,
    );
    expect(bytes).toHaveBeenCalledTimes(2);
  }, 30_000);

  it.each(['changed-image', 'missing-image', 'changed-chapter', 'duplicate-target'])(
    'rejects %s maps even with missing images allowed and preserves previous outputs',
    async (scenario) => {
      const { first, options, downloader, map, build, bytes } = await fixture();
      const bookPath = path.join(first.workspaceDirectory, 'book.json');
      const previousBook = await readFile(bookPath, 'utf8');
      const previousEpub = await readFile(first.epubPath);
      if (scenario === 'changed-image') {
        const changed = await sharp({
          create: { width: 8, height: 8, channels: 3, background: '#ffffff' },
        })
          .png()
          .toBuffer();
        await writeFile(
          path.join(first.workspaceDirectory, first.book.assets[0]!.relativePath),
          changed,
        );
      } else if (scenario === 'missing-image') {
        await rm(path.join(first.workspaceDirectory, first.book.assets[0]!.relativePath));
        bytes.mockRejectedValue(new Error('Unavailable synthetic image'));
      } else if (scenario === 'changed-chapter') {
        const chapter = structuredClone(first.book.volumes[0]!.chapters[0]!);
        chapter.blocks.push({ type: 'paragraph', text: '合成改版' });
        await writeFile(
          path.join(first.workspaceDirectory, 'chapters', `${chapter.id}.json`),
          JSON.stringify(chapter),
        );
      } else map.entries.push(structuredClone(map.entries[0]!));
      build.mockClear();
      await expect(
        downloader.download(42, { ...options, illustrationMap: map, allowMissingImages: true }),
      ).rejects.toThrow(/插图映射校验失败/);
      expect(build).not.toHaveBeenCalled();
      expect(await readFile(bookPath, 'utf8')).toBe(previousBook);
      expect(await readFile(first.epubPath)).toEqual(previousEpub);
      await expect(
        readFile(path.join(first.workspaceDirectory, 'illustration-layout.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('keeps the existing missing-image policy for recovered URLs', async () => {
    const { options, downloader, bytes, urlMarkerImage } = await fixture();
    const original = bytes.getMockImplementation()!;
    bytes.mockImplementation((url, ...args) =>
      url === urlMarkerImage
        ? Promise.reject(new Error('Unavailable inline image'))
        : original(url, ...args),
    );
    await expect(
      downloader.download(42, { ...options, relocateIllustrations: true }),
    ).rejects.toThrow(/缺少图片/);
    const result = await downloader.download(42, {
      ...options,
      relocateIllustrations: true,
      allowMissingImages: true,
    });
    const text = await readFile(
      path.join(result.workspaceDirectory, 'epub', 'package', 'EPUB', 'text', '0001.xhtml'),
      'utf8',
    );
    expect(text).toContain('missing-image');
    expect(result.book.volumes[0]!.chapters).toHaveLength(2);
    expect(result.book.volumes[0]!.chapters[0]!.blocks[1]).toMatchObject({
      type: 'paragraph',
      text: '（插图001）',
    });
  });
});
