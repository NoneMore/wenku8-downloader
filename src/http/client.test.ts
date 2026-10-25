import { createServer, type RequestListener } from 'node:http';
import { CookieJar } from 'tough-cookie';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpClient } from './client.js';

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
      await expect(client.text(`${origin}/forbidden`)).rejects.toThrow(/403/);
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
