import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chapterSha256 } from '../domain/illustration-layout.js';
import { sha256 } from '../domain/ids.js';
import { parseCatalogue, parsePackedChapter } from '../site/parser.js';
import { BookWorkspace } from '../storage/workspace.js';
import { inspectIllustrations, inspectionExitCode } from './illustration-inspection.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-illustrations-'));
  directories.push(root);
  const workspace = await BookWorkspace.open(root, 42);
  const catalogueUrl = 'https://example.test/novel/42/index.htm';
  const catalogue =
    '<table><tr><td colspan="2">合成卷</td></tr><tr><td><a href="1.htm">合成正文</a></td><td><a href="2.htm">合成插图</a></td></tr></table>';
  const volumes = parseCatalogue(catalogue, catalogueUrl);
  const [body, gallery] = volumes[0]!.chapters;
  const imageUrl = 'https://example.test/image.png';
  body!.blocks = [
    { type: 'paragraph', text: '绝不能出现在检查日志中的合成正文' },
    { type: 'paragraph', text: ' （插图001） ' },
    { type: 'paragraph', text: '[IMG]https://example.test/url.jpg?x=%2f[/IMG]' },
  ];
  gallery!.blocks = [
    { type: 'image', sourceUrl: imageUrl, alt: '合成插图' },
    { type: 'image', sourceUrl: imageUrl, alt: '重复位置' },
  ];
  await workspace.writeAtomic('raw/catalogue.html', catalogue);
  await workspace.mark('catalogue', {
    kind: 'catalogue',
    state: 'complete',
    sourceUrl: catalogueUrl,
  });
  for (const chapter of volumes[0]!.chapters) {
    await workspace.writeJson(`chapters/${chapter.id}.json`, chapter);
    await workspace.mark(`chapter:${chapter.id}`, {
      kind: 'chapter',
      state: 'complete',
      sourceUrl: chapter.sourceUrl,
    });
  }
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#aaccee' } })
    .png()
    .toBuffer();
  await workspace.writeAtomic('assets/images/test.png', image);
  await workspace.mark('illustration:test', {
    kind: 'image',
    sourceUrl: imageUrl,
    relativePath: 'assets/images/test.png',
    state: 'complete',
    sha256: '0'.repeat(64),
  });
  return { root, workspace, body: body!, gallery: gallery!, image, imageUrl, catalogue };
}

async function snapshot(directory: string, prefix = ''): Promise<unknown[]> {
  const result: unknown[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const filename = path.join(directory, entry.name);
    const key = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push([key, await snapshot(filename, key)]);
    else result.push([key, sha256(await readFile(filename)), (await stat(filename)).mtimeMs]);
  }
  return result;
}

describe('offline illustration inspection', () => {
  it('uses source coordinates and actual bytes without session, network, workspace writes or derived chapter input', async () => {
    const { root, workspace, body, image } = await fixture();
    await workspace.writeJson('book.json', {
      volumes: [{ chapters: [{ blocks: [{ type: 'paragraph', text: '（插图999）' }] }] }],
      assets: [],
    });
    const before = await snapshot(workspace.directory);
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'));
    const open = vi.spyOn(BookWorkspace, 'open').mockRejectedValue(new Error('Writes forbidden'));
    const report = await inspectIllustrations(42, root);
    expect(report.status).toBe('complete');
    expect(inspectionExitCode(report)).toBe(0);
    expect(report.counts).toEqual({
      chaptersExpected: 2,
      chaptersInspected: 2,
      symbolMarkers: 1,
      urlMarkers: 1,
      imageCandidates: 2,
      availableImages: 2,
      legacyUrlFragments: 0,
    });
    expect(report.markers[0]).toEqual({
      kind: 'symbol',
      chapterUrl: body.sourceUrl,
      chapterSha256: chapterSha256(body),
      blockIndex: 1,
      marker: ' （插图001） ',
    });
    expect(report.images.map((item) => item.blockIndex)).toEqual([0, 1]);
    expect(report.images[0]).toMatchObject({
      assetSha256: sha256(image),
      relativePath: 'assets/images/test.png',
      availability: 'available',
    });
    expect(JSON.stringify(report)).not.toContain('绝不能出现在');
    expect(JSON.stringify(report)).not.toContain('999');
    expect(await snapshot(workspace.directory)).toEqual(before);
    expect(network).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    expect(await inspectIllustrations(42, root)).toEqual(report);
  });

  it.each([
    'missing-workspace',
    'missing-manifest',
    'bad-manifest',
    'book-id',
    'missing-catalogue',
    'bad-catalogue',
    'missing-url',
    'ambiguous',
  ])('reports a fatal %s without exporting candidates', async (scenario) => {
    const { root, workspace, catalogue } = await fixture();
    switch (scenario) {
      case 'missing-workspace':
        await rm(workspace.directory, { recursive: true });
        break;
      case 'missing-manifest':
        await rm(workspace.manifestPath);
        break;
      case 'bad-manifest':
        await writeFile(workspace.manifestPath, '{}');
        break;
      case 'book-id': {
        const manifest = workspace.snapshot();
        manifest.bookId = 1;
        await workspace.writeJson('manifest.json', manifest);
        break;
      }
      case 'missing-catalogue':
        await rm(workspace.resolve('raw/catalogue.html'));
        break;
      case 'bad-catalogue':
        await workspace.writeAtomic('raw/catalogue.html', '<html>invalid</html>');
        break;
      case 'missing-url':
        await workspace.mark('catalogue', { kind: 'catalogue', state: 'complete' });
        break;
      case 'ambiguous':
        await workspace.writeAtomic('raw/catalogue.html', catalogue.replace('2.htm', '1.htm'));
        break;
    }
    const report = await inspectIllustrations(42, root);
    expect(report.status).toBe('error');
    expect(inspectionExitCode(report)).toBe(1);
    expect(report.chapters).toEqual([]);
    expect(report.markers).toEqual([]);
    expect(report.images).toEqual([]);
    const expected =
      scenario === 'missing-workspace'
        ? 'WORKSPACE_MISSING'
        : scenario.includes('manifest')
          ? 'MANIFEST_INVALID'
          : scenario === 'book-id'
            ? 'BOOK_ID_MISMATCH'
            : scenario === 'ambiguous'
              ? 'CHAPTER_URL_AMBIGUOUS'
              : 'CATALOGUE_INVALID';
    expect(report.diagnostics).toEqual([{ code: expected }]);
  });

  it.each([
    'incomplete',
    'missing',
    'invalid',
    'identity',
    'image-missing',
    'image-invalid',
    'image-escape',
    'no-source',
    'fragment',
  ])('preserves inspected results in a partial %s report', async (scenario) => {
    const { root, workspace, body, gallery } = await fixture();
    switch (scenario) {
      case 'incomplete':
        await workspace.mark(`chapter:${body.id}`, { kind: 'chapter', state: 'pending' });
        break;
      case 'missing':
        await rm(workspace.resolve(`chapters/${body.id}.json`));
        break;
      case 'invalid':
        await workspace.writeJson(`chapters/${body.id}.json`, {
          ...body,
          blocks: [{ type: 'paragraph', text: 1 }],
        });
        break;
      case 'identity':
        await workspace.writeJson(`chapters/${body.id}.json`, {
          ...body,
          sourceUrl: gallery.sourceUrl,
        });
        break;
      case 'image-missing':
        await rm(workspace.resolve('assets/images/test.png'));
        break;
      case 'image-invalid':
        await workspace.writeAtomic('assets/images/test.png', 'not an image');
        break;
      case 'image-escape':
        await workspace.mark('illustration:test', {
          kind: 'image',
          sourceUrl: 'https://example.test/image.png',
          relativePath: '../outside.png',
          state: 'complete',
        });
        break;
      case 'no-source':
        gallery.blocks.push({ type: 'image', sourceUrl: null, alt: '图片' });
        await workspace.writeJson(`chapters/${gallery.id}.json`, gallery);
        break;
      case 'fragment':
        body.blocks = parsePackedChapter(
          '[IMG]https://example.test/image.png?size=large[/IMG]',
          body,
        ).blocks;
        await workspace.writeJson(`chapters/${body.id}.json`, body);
        break;
    }
    const report = await inspectIllustrations(42, root);
    expect(report.status).toBe('partial');
    expect(inspectionExitCode(report)).toBe(2);
    expect(report.counts.chaptersExpected).toBe(2);
    expect(report.counts.chaptersInspected).toBeGreaterThan(0);
    const code = {
      incomplete: 'CHAPTER_INCOMPLETE',
      missing: 'CHAPTER_MISSING',
      invalid: 'CHAPTER_INVALID',
      identity: 'CHAPTER_INVALID',
      'image-missing': 'IMAGE_FILE_MISSING',
      'image-invalid': 'IMAGE_FILE_INVALID',
      'image-escape': 'IMAGE_FILE_INVALID',
      'no-source': 'IMAGE_SOURCE_MISSING',
      fragment: 'LEGACY_URL_FRAGMENT',
    }[scenario];
    expect(report.diagnostics.map((item) => item.code)).toContain(code);
    if (scenario.startsWith('image-')) {
      expect(report.images.every((item) => item.assetSha256 === null)).toBe(true);
      expect(report.counts.availableImages).toBe(0);
    }
    if (scenario === 'fragment') {
      expect(report.counts.legacyUrlFragments).toBe(2);
      expect(JSON.stringify(report.diagnostics)).not.toContain('?size=large');
    }
  });

  it('distinguishes no markers from chapters that were never inspected', async () => {
    const { root, workspace, body } = await fixture();
    body.blocks = [{ type: 'paragraph', text: '普通合成段落' }];
    await workspace.writeJson(`chapters/${body.id}.json`, body);
    let report = await inspectIllustrations(42, root);
    expect(report.status).toBe('complete');
    expect(report.counts.symbolMarkers).toBe(0);
    expect(report.counts.chaptersInspected).toBe(2);
    for (const resource of Object.values(workspace.snapshot().resources)) {
      if (resource.kind === 'chapter')
        await workspace.mark(resource.key, { ...resource, state: 'failed' });
    }
    report = await inspectIllustrations(42, root);
    expect(report.status).toBe('partial');
    expect(report.counts.chaptersInspected).toBe(0);
    expect(report.counts.chaptersExpected).toBe(2);
  });

  it('can locate an existing image from optional asset hints without using book.json chapters', async () => {
    const { root, workspace, imageUrl, image } = await fixture();
    const manifest = workspace.snapshot();
    delete manifest.resources['illustration:test'];
    await workspace.writeJson('manifest.json', manifest);
    await workspace.writeJson('book.json', {
      assets: [{ sourceUrl: imageUrl, relativePath: 'assets/images/test.png' }],
    });
    const report = await inspectIllustrations(42, root);
    expect(report.status).toBe('complete');
    expect(report.images[0]!.assetSha256).toBe(sha256(image));
  });
});
