import { createServer, type RequestListener } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { CookieJar } from 'tough-cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from './client.js';
import { HttpStatusError } from '../domain/errors.js';
import { verificationFailure } from '../auth/login.js';

const execFileAsync = promisify(execFile);

describe('HttpClient', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  async function listen(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    return `http://127.0.0.1:${address.port}`;
  }
  afterEach(async () => {
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    );
    servers.length = 0;
  });

  it('reports Cloudflare challenges with an actionable error', async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { 'cf-mitigated': 'challenge' });
      response.end('challenge');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const client = new HttpClient({ retries: 0, timeoutMs: 1_000 });
    await expect(client.text(`http://127.0.0.1:${address.port}/`)).rejects.toThrow(
      /Cloudflare challenge/,
    );
    expect(client.stats()).toMatchObject({ fetchRequests: 1, cloudflareChallenges: 1 });
  });

  it('tracks 429 responses and automatic retries', async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      if (requests === 1) {
        response.writeHead(429);
        response.end('rate limited');
        return;
      }
      response.writeHead(200);
      response.end('ok');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test server did not bind');
    const retryEvents: Array<{ status?: number; retriesLeft: number; attemptNumber: number }> = [];
    const client = new HttpClient({
      retries: 1,
      timeoutMs: 1_000,
      minDelayMs: 1,
      rateLimitCooldownMs: 1,
      onRetry: (event) => retryEvents.push(event),
    });

    await expect(client.text(`http://127.0.0.1:${address.port}/`, 'utf-8')).resolves.toBe('ok');
    expect(client.stats()).toMatchObject({
      fetchRequests: 2,
      http429Responses: 1,
      retryableFailures: 1,
      automaticRetries: 1,
      rateLimitCooldowns: 1,
      statusCodes: { '200': 1, '429': 1 },
    });
    expect(retryEvents).toMatchObject([{ status: 429, retriesLeft: 1, attemptNumber: 1 }]);
  });

  for (const preferCurl of [false, true]) {
    it(`stops explicit challenges without retrying even with HTTP 200 (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let requests = 0;
      const origin = await listen((_request, response) => {
        requests += 1;
        response.writeHead(200, { 'cf-mitigated': 'challenge' });
        response.end('verification');
      });
      const client = new HttpClient({ preferCurl, allowCurlFallback: false, retries: 2 });
      await expect(client.text(origin)).rejects.toThrow(/Cloudflare challenge/);
      expect(requests).toBe(1);
      expect(client.stats().automaticRetries).toBe(0);
    });

    it(`does not retry a completed response when saving cookies fails (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let requests = 0;
      const origin = await listen((_request, response) => {
        requests += 1;
        response.writeHead(200, { 'set-cookie': 'session=synthetic; Path=/' });
        response.end('ok');
      });
      const failure = new Error('session write failed');
      const client = new HttpClient({
        preferCurl,
        retries: 2,
        minDelayMs: 1,
        onCookiesChanged: () => Promise.reject(failure),
      });
      await expect(client.text(origin)).rejects.toBe(failure);
      expect(requests).toBe(1);
      expect(client.stats().automaticRetries).toBe(0);
    });

    it(`blocks TLS downgrade and 307/308 credential replay (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let plaintextRequests = 0;
      const plaintextCookies: Array<string | undefined> = [];
      let posts = 0;
      const plain = await listen((request, response) => {
        plaintextRequests += 1;
        plaintextCookies.push(request.headers.cookie);
        response.end('unexpected');
      });
      const tls = createHttpsServer(
        {
          key: await readFile(new URL('./fixtures/localhost-test-key.pem', import.meta.url)),
          cert: await readFile(new URL('./fixtures/localhost-test-cert.pem', import.meta.url)),
        },
        (request, response) => {
          if (request.method === 'POST') posts += 1;
          const status = request.url === '/308' ? 308 : 307;
          response.writeHead(request.url === '/downgrade' ? 302 : status, {
            location: request.url === '/downgrade' ? plain : '/credential-target',
          });
          response.end();
        },
      );
      servers.push(tls);
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const address = tls.address();
      if (!address || typeof address === 'string') throw new Error('TLS test server did not bind');
      const origin = `https://127.0.0.1:${address.port}`;
      const clientModule = new URL('./client.ts', import.meta.url).href;
      const program = `import {HttpClient} from ${JSON.stringify(clientModule)}; const client=new HttpClient({preferCurl:${preferCurl},cookie:'auth=synthetic',retries:0,requestsPerSecond:100}); const errors=[]; for (const path of ['/downgrade','/307','/308']) { try { if(path==='/downgrade') await client.text(${JSON.stringify(origin)}+path); else await client.postForm(${JSON.stringify(origin)}+path,'password=synthetic'); } catch(error) { errors.push(error.message); } } const publicClient=new HttpClient({preferCurl:${preferCurl},retries:0,requestsPerSecond:100}); if(await publicClient.text(${JSON.stringify(origin)}+'/downgrade')!=='unexpected') throw new Error('public redirect failed'); console.log(JSON.stringify(errors));`;
      const certificate = fileURLToPath(
        new URL('./fixtures/localhost-test-cert.pem', import.meta.url),
      );
      const result = await execFileAsync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
        { env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, CURL_CA_BUNDLE: certificate } },
      );
      expect(JSON.parse(result.stdout)).toEqual([
        expect.stringContaining('降级'),
        expect.stringContaining('重新提交凭证'),
        expect.stringContaining('重新提交凭证'),
      ]);
      expect(plaintextRequests).toBe(1);
      expect(plaintextCookies).toEqual([undefined]);
      expect(posts).toBe(2);
    }, 15_000);
    it(`keeps response cookies scoped across redirects and rotates them (${preferCurl ? 'curl' : 'Node'})`, async () => {
      const cookies: Array<string | undefined> = [];
      const jar = new CookieJar();
      let updates = 0;
      const origin = await listen((request, response) => {
        cookies.push(request.headers.cookie);
        if (request.url === '/start') {
          response.writeHead(302, {
            location: '/private/next',
            'set-cookie': ['only_private=synthetic; Path=/private', 'root=one; Path=/'],
          });
        } else if (request.url === '/private/next') {
          response.writeHead(302, { location: '/public', 'set-cookie': 'root=two; Path=/' });
        } else {
          response.writeHead(200);
        }
        response.end('ok');
      });
      const client = new HttpClient({
        preferCurl,
        cookieJar: jar,
        retries: 0,
        requestsPerSecond: 100,
        onCookiesChanged: () => {
          updates += 1;
          return Promise.resolve();
        },
      });
      expect(await client.text(`${origin}/start`)).toBe('ok');
      expect(cookies[0]).toBeUndefined();
      expect(cookies[1]).toContain('only_private=synthetic');
      expect(cookies[1]).toContain('root=one');
      expect(cookies[2]).toBe('root=two');
      expect(updates).toBe(2);
      expect(jar.getCookieStringSync(`${origin}/private/future`)).toContain('root=two');
      expect(client.stats().statusCodes).toEqual({ '200': 1, '302': 2 });
    });

    it(`does not leak host-only cookies on cross-host redirects (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let leaked: string | undefined;
      const origin = await listen((request, response) => {
        if (request.url === '/start') {
          response.writeHead(302, {
            location: `${origin.replace('127.0.0.1', 'localhost')}/end`,
            'set-cookie': 'host_only=synthetic; Path=/',
          });
        } else {
          leaked = request.headers.cookie;
          response.writeHead(200);
        }
        response.end('ok');
      });
      const client = new HttpClient({ preferCurl, retries: 0, requestsPerSecond: 100 });
      await client.text(`${origin}/start`);
      expect(leaked).toBeUndefined();
    });

    it(`does not replay failed login POSTs or classify ordinary 403 as a challenge (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let posts = 0;
      const origin = await listen((request, response) => {
        if (request.method === 'POST') posts += 1;
        response.writeHead(request.url === '/post' ? 503 : 403);
        response.end('error');
      });
      const client = new HttpClient({
        preferCurl,
        retries: 3,
        minDelayMs: 1,
        requestsPerSecond: 100,
      });
      await expect(client.postForm(`${origin}/post`, 'password=synthetic')).rejects.toThrow(/503/);
      expect(posts).toBe(1);
      const forbidden = await client.text(`${origin}/forbidden`).catch((error: unknown) => error);
      expect(forbidden).toBeInstanceOf(HttpStatusError);
      expect(verificationFailure(forbidden)).toBe('账号页面返回 HTTP 403');
      expect(client.stats().cloudflareChallenges).toBe(0);
    });

    it(`blocks login redirects before disclosing credentials (${preferCurl ? 'curl' : 'Node'})`, async () => {
      let received = false;
      const target = await listen((_request, response) => {
        received = true;
        response.end('unexpected');
      });
      const origin = await listen((_request, response) => {
        response.writeHead(307, { location: target });
        response.end();
      });
      const client = new HttpClient({ preferCurl, retries: 0, requestsPerSecond: 100 });
      await expect(client.postForm(`${origin}/login`, 'password=synthetic')).rejects.toThrow(
        /不受信任/,
      );
      expect(received).toBe(false);
    });
  }
});
