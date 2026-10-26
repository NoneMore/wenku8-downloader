import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Wenku8Client } from '../site/client.js';
import { parseBookDetails, parseCatalogue, type BookDetails } from '../site/parser.js';
import type { Chapter, Volume } from '../domain/book.js';
import {
  AuthenticationRequiredError,
  CloudflareChallengeError,
  CopyrightUnavailableError,
} from '../domain/errors.js';
import { EpubBuilder } from '../epub/builder.js';
import { manifestSchema } from '../storage/schema.js';
import { Downloader, type ProgressEvent } from './downloader.js';
import { NonRetryableHttpError } from '../domain/errors.js';

describe('Downloader', () => {
  for (const preferCurl of [false, true]) {
    for (const challenge of [true, false]) {
      it(`handles HTTP 200 HTML image responses (${preferCurl ? 'curl' : 'Node'}, ${challenge ? 'challenge' : 'ordinary HTML'})`, async () => {
        let requests = 0;
        const server = createServer((_request, response) => {
          requests += 1;
          response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          response.end(
            challenge
              ? '<html><script src="/cdn-cgi/challenge-platform/test.js"></script></html>'
              : '<html><p>验证码 cf-turnstile /cdn-cgi/challenge-platform/</p></html>',
          );
        });
        servers.push(server);
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('Test server did not bind');
        const imageUrl = `http://127.0.0.1:${address.port}/cover.jpg`;
        const client = new Wenku8Client({ preferCurl, allowCurlFallback: false, retries: 2 });
        const raw =
          '<div id="content"><span><b>图片响应测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>';
        const book = parseBookDetails(raw, 42, 'https://www.wenku8.net/book/42.htm');
        book.coverSourceUrl = imageUrl;
        vi.spyOn(client, 'getBookDetails').mockResolvedValue({ raw, book });
        const catalogue =
          '<table><tr><td>第一卷</td></tr><tr><td><a href="1.htm">第一章</a></td></tr></table>';
        vi.spyOn(client, 'getCatalogue').mockResolvedValue({
          raw: catalogue,
          volumes: parseCatalogue(catalogue, book.catalogueUrl),
        });
        vi.spyOn(client, 'getChapter').mockImplementation((chapter) =>
          Promise.resolve({
            raw: '<div id="content">正文</div>',
            chapter: { ...chapter, blocks: [{ type: 'paragraph', text: '正文' }] },
          }),
        );
        const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-image-html-'));
        const builder = new EpubBuilder();
        const build = vi.spyOn(builder, 'build');
        const result = new Downloader(client, builder).download(42, {
          workDirectory: root,
          outputDirectory: root,
          allowMissingImages: true,
        });
        if (challenge) {
          await expect(result).rejects.toBeInstanceOf(CloudflareChallengeError);
          expect(build).not.toHaveBeenCalled();
        } else {
          const output = await result;
          expect((await readFile(output.epubPath)).byteLength).toBeGreaterThan(0);
          expect(build).toHaveBeenCalledOnce();
        }
        expect(requests).toBe(1);
        const state = manifestSchema.parse(
          JSON.parse(await readFile(path.join(root, '42', 'manifest.json'), 'utf8')),
        );
        expect(
          Object.values(state.resources).find((resource) => resource.kind === 'cover')?.state,
        ).toBe('failed');
        expect(state.resources.epub?.state).toBe(challenge ? undefined : 'complete');
      });
    }
  }

  it.each([
    new CloudflareChallengeError('https://www.wenku8.net/cover.jpg'),
    new NonRetryableHttpError('HTTP 请求无法恢复'),
    'unreachable curl proxy',
  ])('propagates image authentication and proxy blocks even when missing images are allowed: %s', async (blocked) => {
    const client = new Wenku8Client(
      typeof blocked === 'string'
        ? { preferCurl: true, proxy: 'http://127.0.0.1:1', retries: 0 }
        : {},
    );
    const raw =
      '<div id="content"><span><b>封面认证测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>';
    const book = parseBookDetails(raw, 42, 'https://www.wenku8.net/book/42.htm');
    book.coverSourceUrl = 'https://www.wenku8.net/cover.jpg';
    vi.spyOn(client, 'getBookDetails').mockResolvedValue({ raw, book });
    vi.spyOn(client, 'getCatalogue').mockResolvedValue({ raw: '<table></table>', volumes: [] });
    if (typeof blocked !== 'string') vi.spyOn(client.http, 'bytes').mockRejectedValue(blocked);
    const builder = new EpubBuilder();
    const build = vi.spyOn(builder, 'build');
    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-image-auth-'));
    const download = new Downloader(client, builder).download(42, {
      workDirectory: root,
      outputDirectory: root,
      allowMissingImages: true,
    });
    if (typeof blocked === 'string')
      await expect(download).rejects.toBeInstanceOf(NonRetryableHttpError);
    else await expect(download).rejects.toBe(blocked);
    expect(build).not.toHaveBeenCalled();
  });

  for (const blocked of [
    new AuthenticationRequiredError(),
    new CloudflareChallengeError('https://www.wenku8.net/novel/42/2.htm'),
    new NonRetryableHttpError('HTTP 请求无法恢复'),
  ]) {
    it('stops on authentication or proxy failure and reuses completed chapters after recovery', async () => {
      const client = new Wenku8Client();
      const catalogueUrl = 'https://www.wenku8.net/novel/42/index.htm';
      const raw =
        '<div id="content"><span><b>认证恢复测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>';
      vi.spyOn(client, 'getBookDetails').mockResolvedValue({
        raw,
        book: parseBookDetails(raw, 42, 'https://www.wenku8.net/book/42.htm'),
      });
      const catalogue =
        '<table><tr><td colspan="4">第一卷</td></tr><tr><td><a href="1.htm">第一章</a></td><td><a href="2.htm">第二章</a></td><td><a href="3.htm">第三章</a></td></tr></table>';
      vi.spyOn(client, 'getCatalogue').mockResolvedValue({
        raw: catalogue,
        volumes: parseCatalogue(catalogue, catalogueUrl),
      });
      let signedIn = false;
      const chapter = vi.spyOn(client, 'getChapter').mockImplementation((item) => {
        if (!signedIn && item.title === '第二章') return Promise.reject(blocked);
        return Promise.resolve({
          raw: '<div id="content">正文</div>',
          chapter: { ...item, blocks: [{ type: 'paragraph', text: '正文' }] },
        });
      });
      const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-auth-resume-'));
      const builder = new EpubBuilder();
      const build = vi.spyOn(builder, 'build');
      const downloader = new Downloader(client, builder);
      await expect(
        downloader.download(42, {
          workDirectory: root,
          outputDirectory: root,
          chapterConcurrency: 1,
        }),
      ).rejects.toBe(blocked);
      expect(chapter.mock.calls.map(([item]) => item.title)).toEqual(['第一章', '第二章']);
      expect(build).not.toHaveBeenCalled();
      const state = manifestSchema.parse(
        JSON.parse(await readFile(path.join(root, '42', 'manifest.json'), 'utf8')),
      );
      expect(
        Object.values(state.resources).filter(
          (resource) => resource.kind === 'chapter' && resource.state === 'complete',
        ),
      ).toHaveLength(1);
      signedIn = true;
      chapter.mockClear();
      await downloader.download(42, {
        workDirectory: root,
        outputDirectory: root,
        chapterConcurrency: 1,
      });
      expect(chapter.mock.calls.map(([item]) => item.title)).toEqual(['第二章', '第三章']);
      expect(build).toHaveBeenCalledOnce();
    });
  }
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
  });

  it('downloads assets, builds an EPUB and reuses the completed workspace', async () => {
    const image = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#336699' },
    })
      .png()
      .toBuffer();
    let imageRequests = 0;
    const server = createServer((_request, response) => {
      imageRequests += 1;
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(image);
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const imageUrl = `http://127.0.0.1:${address.port}/image.png`;

    class FixtureClient extends Wenku8Client {
      constructor() {
        super({ concurrency: 2, retries: 0, timeoutMs: 2_000, requestsPerSecond: 20 });
      }

      override getBookDetails(bookId: number): Promise<{ book: BookDetails; raw: string }> {
        const raw = `<div id="content"><span><b>端到端测试</b></span><div>小说作者：测试作者</div><img src="${imageUrl}"><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>`;
        return Promise.resolve({
          raw,
          book: parseBookDetails(raw, bookId, `https://www.wenku8.net/book/${bookId}.htm`),
        });
      }

      override getCatalogue(): Promise<{ volumes: Volume[]; raw: string }> {
        const raw =
          '<table><tr><td colspan="4">第一卷</td></tr><tr><td><a href="1.htm">第一章</a></td></tr></table>';
        return Promise.resolve({
          raw,
          volumes: parseCatalogue(raw, 'https://www.wenku8.net/novel/42/index.htm'),
        });
      }

      override getChapter(chapter: Chapter): Promise<{ chapter: Chapter; raw: string }> {
        return Promise.resolve({
          raw: '<div id="content">正文</div>',
          chapter: {
            ...chapter,
            blocks: [
              { type: 'paragraph', text: '正文' },
              { type: 'image', sourceUrl: imageUrl, alt: '插图' },
            ],
          },
        });
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-download-'));
    const downloader = new Downloader(new FixtureClient());
    const first = await downloader.download(42, { workDirectory: root, outputDirectory: root });
    expect((await readFile(first.epubPath)).byteLength).toBeGreaterThan(1000);
    expect(imageRequests).toBe(1);

    const second = await downloader.download(42, { workDirectory: root, outputDirectory: root });
    expect(second.epubPath).toBe(first.epubPath);
    expect(imageRequests).toBe(1);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(path.join(root, '42', 'manifest.json'), 'utf8')),
    );
    expect(manifest.resources.epub?.state).toBe('complete');
    expect(
      Object.values(manifest.resources).every((resource) => resource.state === 'complete'),
    ).toBe(true);
  });

  it('stops immediately when a chapter is unavailable for copyright reasons', async () => {
    let chapterRequests = 0;

    class CopyrightClient extends Wenku8Client {
      constructor() {
        super({ concurrency: 2, retries: 0, timeoutMs: 2_000, requestsPerSecond: 20 });
      }

      override getBookDetails(bookId: number): Promise<{ book: BookDetails; raw: string }> {
        const raw = `<div id="content"><span><b>版权测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>`;
        return Promise.resolve({
          raw,
          book: parseBookDetails(raw, bookId, `https://www.wenku8.net/book/${bookId}.htm`),
        });
      }

      override getCatalogue(): Promise<{ volumes: Volume[]; raw: string }> {
        const raw = `<table>
          <tr><td colspan="4">第一卷</td></tr>
          <tr>
            <td><a href="1.htm">第一章</a></td>
            <td><a href="2.htm">第二章</a></td>
            <td><a href="3.htm">第三章</a></td>
            <td><a href="4.htm">第四章</a></td>
            <td><a href="5.htm">第五章</a></td>
          </tr>
        </table>`;
        return Promise.resolve({
          raw,
          volumes: parseCatalogue(raw, 'https://www.wenku8.net/novel/42/index.htm'),
        });
      }

      override async getChapter(
        chapter: Chapter,
        signal?: AbortSignal,
      ): Promise<{ chapter: Chapter; raw: string }> {
        chapterRequests += 1;
        if (chapter.title !== '第一章') {
          await new Promise<void>((resolve) => {
            if (signal?.aborted) {
              resolve();
              return;
            }
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        throw new CopyrightUnavailableError(chapter.title, chapter.sourceUrl);
      }
    }

    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-copyright-'));
    await expect(
      new Downloader(new CopyrightClient()).download(42, {
        workDirectory: root,
        chapterConcurrency: 2,
      }),
    ).rejects.toThrow(/因版权问题/);
    expect(chapterRequests).toBeLessThanOrEqual(2);
  });

  it('reports chapter failures and retry rounds without counting failed attempts as complete', async () => {
    const attempts = new Map<string, number>();

    class RetryingClient extends Wenku8Client {
      constructor() {
        super({ concurrency: 1, retries: 0, timeoutMs: 2_000, requestsPerSecond: 20 });
      }

      override getBookDetails(bookId: number): Promise<{ book: BookDetails; raw: string }> {
        const raw = `<div id="content"><span><b>重试测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><div id="contentmain">测试简介</div></div>`;
        return Promise.resolve({
          raw,
          book: parseBookDetails(raw, bookId, `https://www.wenku8.net/book/${bookId}.htm`),
        });
      }

      override getCatalogue(): Promise<{ volumes: Volume[]; raw: string }> {
        const raw = `<table>
          <tr><td colspan="4">第一卷</td></tr>
          <tr>
            <td><a href="1.htm">第一章</a></td>
            <td><a href="2.htm">第二章</a></td>
          </tr>
        </table>`;
        return Promise.resolve({
          raw,
          volumes: parseCatalogue(raw, 'https://www.wenku8.net/novel/42/index.htm'),
        });
      }

      override getChapter(chapter: Chapter): Promise<{ chapter: Chapter; raw: string }> {
        const attempt = (attempts.get(chapter.id) ?? 0) + 1;
        attempts.set(chapter.id, attempt);
        if (chapter.title === '第一章' && attempt === 1) {
          return Promise.reject(new Error('HTTP 429 for test'));
        }
        return Promise.resolve({
          raw: '<div id="content">正文</div>',
          chapter: {
            ...chapter,
            blocks: [{ type: 'paragraph', text: `${chapter.title}正文` }],
          },
        });
      }
    }

    const events: ProgressEvent[] = [];
    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-retry-'));
    await new Downloader(new RetryingClient()).download(42, {
      workDirectory: root,
      outputDirectory: root,
      chapterConcurrency: 1,
      chapterRetryRounds: 1,
      chapterRetryDelayMs: 1,
      onProgress: (event) => events.push(event),
    });

    const failed = events.find((event) => event.phase === 'chapters' && event.kind === 'failed');
    const retry = events.find((event) => event.phase === 'chapters' && event.kind === 'retry');
    const completed = events.filter(
      (event) => event.phase === 'chapters' && event.kind === 'complete',
    );
    expect(failed).toMatchObject({ completed: 0, total: 2 });
    expect(retry).toMatchObject({ completed: 1, total: 2 });
    expect(completed.map((event) => event.completed)).toEqual([1, 2]);
  });
});
