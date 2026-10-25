import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium } from 'playwright';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from './client.js';
import { ProxyPolicy, ProxyConfigurationError, ProxyAuthenticationError } from './proxy.js';
import { startBrowserProxy } from './browser-proxy.js';
import { userConfigDirectory } from '../cli/paths.js';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
const proxyKeys = [
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
];

beforeEach(() => {
  for (const key of proxyKeys) vi.stubEnv(key, undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
});

async function listen(server: Server): Promise<string> {
  const sockets = new Set<Duplex>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => {
    for (const socket of sockets) socket.destroy();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function proxyServer(options: { status?: number; hang?: boolean; tunnelPort?: number } = {}) {
  const requests: Array<{ method: string; url: string }> = [];
  const sockets = new Set<Duplex>();
  const server = createServer((incoming, response) => {
    requests.push({ method: incoming.method ?? '', url: incoming.url ?? '' });
    if (options.hang) return;
    if (options.status) {
      response.writeHead(options.status).end();
      return;
    }
    const target = new URL(incoming.url ?? '');
    const outgoing = request(
      {
        hostname: '127.0.0.1',
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: incoming.method,
        headers: incoming.headers,
        agent: false,
      },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
      },
    );
    outgoing.on('error', () => response.writeHead(502).end());
    response.on('close', () => outgoing.destroy());
    incoming.pipe(outgoing);
  });
  server.on('connect', (incoming, downstream, head) => {
    requests.push({ method: 'CONNECT', url: incoming.url ?? '' });
    if (options.hang) return;
    if (options.status) {
      downstream.end(`HTTP/1.1 ${options.status} Failed\r\n\r\n`);
      return;
    }
    const target = new URL(`https://${incoming.url ?? ''}`);
    const upstream = connect(options.tunnelPort ?? Number(target.port || 443), '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
    });
    sockets.add(upstream);
    upstream.on('close', () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
  });
  const url = await listen(server);
  cleanup.push(() => {
    for (const socket of sockets) socket.destroy();
    return Promise.resolve();
  });
  return { url, requests };
}

function client(options: ConstructorParameters<typeof HttpClient>[0] = {}) {
  const http = new HttpClient({ retries: 0, requestsPerSecond: 100, timeoutMs: 2_000, ...options });
  cleanup.push(() => http.close());
  return http;
}

async function siteFixture() {
  const key = await readFile(new URL('./fixtures/proxy-test-key.pem', import.meta.url));
  const cert = await readFile(new URL('./fixtures/proxy-test-cert.pem', import.meta.url));
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#f0f0f0' } })
    .png()
    .toBuffer();
  const hits: string[] = [];
  let secondChapterAttempts = 0;
  const form =
    '<form method="post" action="https://www.wenku8.net/login.php?do=submit"><input name="username"><input name="password" type="password"><input type="submit"></form>';
  const origin = await listen(
    createHttpsServer({ key, cert }, (incoming, response) => {
      const pathname = new URL(incoming.url ?? '/', 'https://www.wenku8.net').pathname;
      hits.push(`${incoming.method} ${pathname}`);
      response.setHeader('content-type', 'text/html; charset=gbk');
      let html = '';
      if (pathname === '/login.php') {
        if (incoming.method === 'POST') {
          response.setHeader('set-cookie', 'synthetic_session=valid; Path=/; Secure; HttpOnly');
          html = '<a href="/logout.php">退出</a>';
        } else html = form;
      } else if (pathname === '/userdetail.php') {
        html = incoming.headers.cookie?.includes('synthetic_session=valid')
          ? '<a href="/logout.php">退出</a>'
          : form;
      } else if (pathname === '/book/42.htm') {
        html =
          '<div id="content"><span><b>代理下载测试</b></span><div>小说作者：测试作者</div><a href="/novel/42/index.htm">目录</a><img src="/cover.png"><div id="contentmain">测试简介</div></div>';
      } else if (pathname === '/novel/42/index.htm') {
        html =
          '<table><tr><td colspan="2">第一卷</td></tr><tr><td><a href="1.htm">第一章</a></td><td><a href="2.htm">第二章</a></td></tr></table>';
      } else if (pathname === '/novel/42/1.htm') {
        html = '<div id="content">测试正文<br><img src="/image.png"></div>';
      } else if (pathname === '/novel/42/2.htm') {
        secondChapterAttempts += 1;
        if (secondChapterAttempts === 1) {
          response.writeHead(503).end();
          return;
        }
        html = '<div id="content">第二章正文</div>';
      } else if (pathname === '/cover.png' || pathname === '/image.png') {
        response.setHeader('content-type', 'image/png');
        response.end(image);
        return;
      } else {
        response.writeHead(404).end();
        return;
      }
      response.end(iconv.encode(html, 'gbk'));
    }),
  );
  const proxy = await proxyServer({ tunnelPort: Number(new URL(origin).port) });
  const certificate = fileURLToPath(new URL('./fixtures/proxy-test-cert.pem', import.meta.url));
  return { proxy, cert, certificate, hits };
}

async function isolatedProgram(program: string, env: NodeJS.ProcessEnv) {
  return execFileAsync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
    { env: { ...process.env, ...env }, timeout: 20_000 },
  );
}

describe('proxy selection contract', () => {
  it('uses protocol-specific variables, lowercase precedence, empty fallback and ALL_PROXY', () => {
    const policy = new ProxyPolicy(undefined, {
      http_proxy: ' http://lower.test:7890 ',
      HTTP_PROXY: 'http://upper.test',
      https_proxy: ' ',
      HTTPS_PROXY: 'http://secure.test',
      ALL_PROXY: 'http://fallback.test',
    });
    expect(policy.resolve('http://example.test')).toBe('http://lower.test:7890');
    expect(policy.resolve('https://example.test')).toBe('http://secure.test');
    const fallback = new ProxyPolicy(undefined, {
      HTTP_PROXY: 'http://only-http.test',
      ALL_PROXY: 'http://fallback.test',
    });
    expect(fallback.resolve('https://example.test')).toBe('http://fallback.test');
    expect(
      new ProxyPolicy(undefined, { HTTP_PROXY: 'http://only-http.test' }).resolve(
        'https://example.test',
      ),
    ).toBeUndefined();
  });

  it('explicit modes ignore all environmental configuration, and policies snapshot the environment', () => {
    const env = { HTTP_PROXY: 'socks5://bad', NO_PROXY: 'unsupported:8080' };
    expect(new ProxyPolicy(false, env).resolve('http://example.test')).toBeUndefined();
    expect(new ProxyPolicy('http://forced.test', env).resolve('http://example.test')).toBe(
      'http://forced.test',
    );
    const inherited = { ALL_PROXY: 'http://original.test' };
    const policy = new ProxyPolicy(undefined, inherited);
    inherited.ALL_PROXY = 'http://changed.test';
    expect(policy.resolve('http://example.test')).toBe('http://original.test');
    expect(
      new ProxyPolicy(undefined, { NO_PROXY: '*', ALL_PROXY: 'socks5://unused' }).resolve(
        'https://example.test',
      ),
    ).toBeUndefined();
  });

  it.each([
    ['example.test', 'http://EXAMPLE.test:8080', true],
    ['.example.test', 'http://a.example.test', true],
    ['example.test', 'http://notexample.test', false],
    ['example.test', 'http://example.test.other', false],
    [' , localhost, ', 'http://localhost:5432', true],
    ['127.0.0.1', 'http://127.0.0.1:80', true],
    ['127.0.0.1', 'http://127.0.0.10', false],
    ['127.0.0.1', 'http://localhost', false],
    ['::1', 'http://[0:0:0:0:0:0:0:1]', true],
    ['*', 'https://anything.test', true],
    ['', 'http://localhost', false],
  ])('matches NO_PROXY %s against %s', (noProxy, url, bypass) => {
    const policy = new ProxyPolicy(undefined, {
      no_proxy: noProxy,
      all_proxy: 'http://proxy.test',
    });
    expect(policy.resolve(url)).toBe(bypass ? undefined : 'http://proxy.test');
  });

  it.each(['example.test:8080', '127.0.0.0/8', '*.test', '[::1]'])(
    'rejects unsupported bypass syntax %s',
    (entry) => {
      expect(() =>
        new ProxyPolicy(undefined, { NO_PROXY: entry }).resolve('http://example.test'),
      ).toThrow(ProxyConfigurationError);
    },
  );

  it.each([
    '',
    'bad',
    'https://proxy.test',
    'socks5://proxy.test',
    'http://private-user:private-password@proxy.test',
    'http://proxy.test/path',
    'http://proxy.test?query',
  ])('rejects invalid or unsupported proxies without echoing values', (value) => {
    expect(() => new ProxyPolicy(value, {})).toThrow(ProxyConfigurationError);
    try {
      new ProxyPolicy(value, {});
    } catch (error) {
      expect((error as Error).message).not.toContain('private-user');
      expect((error as Error).message).not.toContain('private-password');
    }
  });
});

describe.each([false, true])('real HTTP proxy routing (preferCurl=%s)', (preferCurl) => {
  it('inherits HTTP_PROXY, honors bypass, and makes explicit modes override it', async () => {
    let hits = 0;
    const target = await listen(
      createServer((_request, response) => {
        hits += 1;
        response.end('ok');
      }),
    );
    const proxy = await proxyServer();
    vi.stubEnv('HTTP_PROXY', proxy.url);
    expect(await client({ preferCurl }).text(target)).toBe('ok');
    expect(proxy.requests).toHaveLength(1);
    expect(proxy.requests[0]?.url).toBe(`${target}/`);
    vi.stubEnv('NO_PROXY', '127.0.0.1');
    expect(await client({ preferCurl }).text(target)).toBe('ok');
    expect(proxy.requests).toHaveLength(1);
    expect(await client({ preferCurl, proxy: proxy.url }).text(target)).toBe('ok');
    expect(proxy.requests).toHaveLength(2);
    vi.stubEnv('HTTP_PROXY', 'socks5://unsupported');
    vi.stubEnv('NO_PROXY', 'unsupported:8080');
    expect(await client({ preferCurl, proxy: false }).text(target)).toBe('ok');
    expect(proxy.requests).toHaveLength(2);
    expect(hits).toBe(4);
  });

  it('reevaluates bypass on redirects and retains Cookie host scoping', async () => {
    let receivedCookie: string | undefined;
    const destination = await listen(
      createServer((incoming, response) => {
        receivedCookie = incoming.headers.cookie;
        response.end('redirected');
      }),
    );
    const source = await listen(
      createServer((_incoming, response) =>
        response
          .writeHead(302, {
            location: destination,
            'set-cookie': 'synthetic=private; Path=/',
          })
          .end(),
      ),
    );
    const proxy = await proxyServer();
    vi.stubEnv('http_proxy', proxy.url);
    vi.stubEnv('no_proxy', '127.0.0.1');
    // localhost and its numeric address are different Cookie and bypass hosts.
    const sourceUrl = new URL(source);
    sourceUrl.hostname = 'localhost';
    expect(await client({ preferCurl }).text(sourceUrl.href)).toBe('redirected');
    expect(proxy.requests).toHaveLength(1);
    expect(receivedCookie).toBeUndefined();
  });

  it('reports 407 without retries, target access or direct fallback', async () => {
    let hits = 0;
    const target = await listen(
      createServer((_request, response) => {
        hits += 1;
        response.end('unexpected');
      }),
    );
    const proxy = await proxyServer({ status: 407 });
    const http = client({ preferCurl, proxy: proxy.url, retries: 2 });
    await expect(http.text(target)).rejects.toThrow(ProxyAuthenticationError);
    expect(proxy.requests).toHaveLength(1);
    expect(http.stats().automaticRetries).toBe(0);
    expect(hits).toBe(0);
    await expect(http.text('https://127.0.0.1:8443')).rejects.toThrow(ProxyAuthenticationError);
    expect(proxy.requests).toHaveLength(2);
  });

  it('fails configuration before traffic, and cancels hanging proxies without direct fallback', async () => {
    let hits = 0;
    const target = await listen(
      createServer((_request, response) => {
        hits += 1;
        response.end('unexpected');
      }),
    );
    vi.stubEnv('http_proxy', 'socks5://unsupported');
    const invalid = client({ preferCurl, retries: 2 });
    await expect(invalid.text(target)).rejects.toThrow(ProxyConfigurationError);
    expect(invalid.stats().automaticRetries).toBe(0);
    const proxy = await proxyServer({ hang: true });
    const hanging = client({ preferCurl, proxy: proxy.url });
    await expect(hanging.text(target, 'utf-8', AbortSignal.timeout(150))).rejects.toThrow();
    await expect(
      client({ preferCurl, proxy: proxy.url, timeoutMs: 150 }).text(target),
    ).rejects.toThrow();
    expect(hits).toBe(0);
  });
});

it('keeps the selected proxy when a Node request falls back to curl', async () => {
  let hits = 0;
  const target = await listen(
    createServer((_request, response) => {
      hits += 1;
      if (hits === 1) response.writeHead(403, { 'cf-mitigated': 'challenge' }).end();
      else response.end('fallback-ok');
    }),
  );
  const proxy = await proxyServer();
  const http = client({ proxy: proxy.url, cookie: 'synthetic=valid' });
  expect(await http.text(target)).toBe('fallback-ok');
  expect(http.stats()).toMatchObject({ fetchRequests: 1, curlRequests: 1, curlFallbacks: 1 });
  expect(proxy.requests).toHaveLength(2);
});

describe('HTTPS proxy tunnels and browser relay', () => {
  async function tlsTarget(redirect?: string) {
    const key = await readFile(new URL('./fixtures/localhost-test-key.pem', import.meta.url));
    const cert = await readFile(new URL('./fixtures/localhost-test-cert.pem', import.meta.url));
    const url = (
      await listen(
        createHttpsServer({ key, cert }, (_request, response) => {
          if (redirect) response.writeHead(302, { location: redirect }).end();
          else response.end('tls-ok');
        }),
      )
    ).replace('http:', 'https:');
    return { url, cert };
  }

  it.each([false, true])(
    'uses CONNECT with normal certificate verification (preferCurl=%s)',
    async (preferCurl) => {
      const target = await tlsTarget();
      const proxy = await proxyServer();
      const certificate = fileURLToPath(
        new URL('./fixtures/localhost-test-cert.pem', import.meta.url),
      );
      const program = `import {HttpClient} from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)}; const http=new HttpClient({proxy:${JSON.stringify(proxy.url)},preferCurl:${preferCurl},retries:0}); try { console.log(await http.text(${JSON.stringify(target.url)})); } finally { await http.close(); }`;
      const result = await execFileAsync(
        process.execPath,
        ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
        {
          env: { ...process.env, NODE_EXTRA_CA_CERTS: certificate, CURL_CA_BUNDLE: certificate },
          timeout: 10_000,
        },
      );
      expect(result.stdout.trim()).toBe('tls-ok');
      expect(proxy.requests).toEqual([{ method: 'CONNECT', url: new URL(target.url).host }]);
      const untrusted = client({ proxy: proxy.url, preferCurl });
      await expect(untrusted.text(target.url)).rejects.toThrow();
    },
    15_000,
  );

  it.each([false, true])(
    'reselects the proxy after an HTTPS to HTTP public redirect (preferCurl=%s)',
    async (preferCurl) => {
      const plain = await listen(createServer((_request, response) => response.end('redirect-ok')));
      const secure = await tlsTarget(plain);
      const httpProxy = await proxyServer();
      const httpsProxy = await proxyServer();
      const certificate = fileURLToPath(
        new URL('./fixtures/localhost-test-cert.pem', import.meta.url),
      );
      const program = `import {HttpClient} from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)}; const http=new HttpClient({preferCurl:${preferCurl},retries:0,requestsPerSecond:100}); try { console.log(await http.text(${JSON.stringify(secure.url)})); } finally { await http.close(); }`;
      const result = await isolatedProgram(program, {
        NODE_EXTRA_CA_CERTS: certificate,
        CURL_CA_BUNDLE: certificate,
        http_proxy: httpProxy.url,
        https_proxy: httpsProxy.url,
      });
      expect(result.stdout.trim()).toBe('redirect-ok');
      expect(httpProxy.requests).toEqual([{ method: 'GET', url: `${plain}/` }]);
      expect(httpsProxy.requests).toEqual([{ method: 'CONNECT', url: new URL(secure.url).host }]);
    },
    15_000,
  );

  async function browserFor(policy: ProxyPolicy, cert?: Buffer) {
    const relay = await startBrowserProxy(policy);
    cleanup.push(() => relay.close());
    const channel = process.env.WENKU8_TEST_BROWSER;
    const spki = cert
      ? createHash('sha256')
          .update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' }))
          .digest('base64')
      : undefined;
    const browser = await chromium.launch({
      headless: true,
      ...(channel ? { channel } : {}),
      proxy: relay.settings,
      args: spki ? [`--ignore-certificate-errors-spki-list=${spki}`] : [],
    });
    cleanup.push(() => browser.close());
    const page = await browser.newPage();
    return { relay, page };
  }

  it('routes actual browser pages, forms and subresources by target protocol', async () => {
    const secure = await tlsTarget();
    const seen: string[] = [];
    const plain = await listen(
      createServer((incoming, response) => {
        seen.push(`${incoming.method} ${incoming.url}`);
        response.setHeader('content-type', 'text/html');
        if (incoming.url === '/redirect') {
          response.writeHead(302, { location: secure.url }).end();
          return;
        }
        if (incoming.url === '/')
          response.end(
            '<form method="post" action="/submit"><input type="submit"></form><img src="/image">',
          );
        else response.end('plain-ok');
      }),
    );
    const httpProxy = await proxyServer();
    const httpsProxy = await proxyServer();
    const { page } = await browserFor(
      new ProxyPolicy(undefined, { http_proxy: httpProxy.url, https_proxy: httpsProxy.url }),
      secure.cert,
    );
    await page.goto(plain);
    await page.locator('[type=submit]').click();
    await page.goto(`${plain}/redirect`);
    expect(await page.textContent('body')).toBe('tls-ok');
    expect(seen).toContain('GET /image');
    expect(seen).toContain('POST /submit');
    expect(httpProxy.requests.map((item) => item.method)).toContain('POST');
    expect(httpsProxy.requests.some((item) => item.method === 'CONNECT')).toBe(true);
    expect(httpProxy.requests.every((item) => item.method !== 'CONNECT')).toBe(true);
  }, 20_000);

  it('handles mixed direct/proxy routing and explicit direct mode without system defaults', async () => {
    const secure = await tlsTarget();
    const proxy = await proxyServer();
    const plain = await listen(createServer((_request, response) => response.end('plain-ok')));
    const { page } = await browserFor(
      new ProxyPolicy(undefined, { http_proxy: proxy.url }),
      secure.cert,
    );
    await page.goto(plain);
    await page.goto(secure.url);
    expect(proxy.requests.some((item) => item.method === 'CONNECT')).toBe(false);
    expect(proxy.requests.length).toBeGreaterThan(0);
    const count = proxy.requests.length;
    const direct = await browserFor(
      new ProxyPolicy(false, { all_proxy: proxy.url, no_proxy: 'invalid:80' }),
      secure.cert,
    );
    await direct.page.goto(plain);
    await direct.page.goto(secure.url);
    expect(proxy.requests).toHaveLength(count);
  }, 20_000);

  it('applies bypass consistently and surfaces unsupported proxy authentication', async () => {
    const plain = await listen(createServer((_request, response) => response.end('plain-ok')));
    const proxy = await proxyServer({ status: 407 });
    const bypass = await browserFor(
      new ProxyPolicy(undefined, { all_proxy: proxy.url, no_proxy: '127.0.0.1' }),
    );
    await bypass.page.goto(plain);
    expect(proxy.requests.filter((item) => item.url.startsWith(plain))).toHaveLength(0);
    const forced = await browserFor(new ProxyPolicy(proxy.url, { no_proxy: '*' }));
    await forced.page.goto(plain).catch(() => undefined);
    expect(forced.relay.failureFor(plain)).toBeInstanceOf(ProxyAuthenticationError);
    expect(proxy.requests.length).toBeGreaterThan(0);
  }, 20_000);
});

describe('authentication and resumable downloads through real proxies', () => {
  it.each([false, true])(
    'logs in, downloads every resource and resumes cached chapters (preferCurl=%s)',
    async (preferCurl) => {
      const site = await siteFixture();
      const directory = await mkdtemp(path.join(tmpdir(), 'wenku8-proxy-download-'));
      cleanup.push(() => rm(directory, { recursive: true, force: true }));
      const program = `
      import {loginAccount} from ${JSON.stringify(new URL('../auth/login.ts', import.meta.url).href)};
      import {Wenku8Client} from ${JSON.stringify(new URL('../site/client.ts', import.meta.url).href)};
      import {Downloader} from ${JSON.stringify(new URL('../service/downloader.ts', import.meta.url).href)};
      const proxy=${JSON.stringify(site.proxy.url)};
      const session=await loginAccount({username:'synthetic',password:'synthetic-password'},{proxy});
      const client=new Wenku8Client({proxy,preferCurl:${preferCurl},cookieJar:session.cookieJar,retries:0,requestsPerSecond:100});
      const downloader=new Downloader(client);
      const options={workDirectory:${JSON.stringify(directory)},outputDirectory:${JSON.stringify(directory)},chapterRetryRounds:0};
      let stopped=false;
      try { await downloader.download(42,options); } catch { stopped=true; }
      try {
        const result=await downloader.download(42,options);
        console.log(JSON.stringify({stopped,title:result.book.title,assets:result.book.assets.length,chapters:result.book.volumes[0].chapters.length}));
      } finally { await client.http.close(); }
    `;
      const result = await isolatedProgram(program, {
        NODE_EXTRA_CA_CERTS: site.certificate,
        CURL_CA_BUNDLE: site.certificate,
        no_proxy: '*',
      });
      expect(JSON.parse(result.stdout)).toEqual({
        stopped: true,
        title: '代理下载测试',
        assets: 2,
        chapters: 2,
      });
      for (const resource of [
        '/book/42.htm',
        '/novel/42/index.htm',
        '/novel/42/1.htm',
        '/cover.png',
        '/image.png',
      ]) {
        expect(site.hits.filter((hit) => hit === `GET ${resource}`)).toHaveLength(1);
      }
      expect(site.hits.filter((hit) => hit === 'GET /novel/42/2.htm')).toHaveLength(2);
      expect(site.proxy.requests.length).toBeGreaterThan(0);
    },
    25_000,
  );

  it('hands off a real browser login to the CLI transport using the same forced proxy', async () => {
    const site = await siteFixture();
    const spki = createHash('sha256')
      .update(new X509Certificate(site.cert).publicKey.export({ type: 'spki', format: 'der' }))
      .digest('base64');
    const program = `
      import {chromium} from ${JSON.stringify(import.meta.resolve('playwright'))};
      import {CookieJar} from ${JSON.stringify(import.meta.resolve('tough-cookie'))};
      import {loginInBrowser} from ${JSON.stringify(new URL('../auth/browser.ts', import.meta.url).href)};
      const session=await loginInBrowser({username:'synthetic',password:'synthetic-password'},new CookieJar(),{
        proxy:${JSON.stringify(site.proxy.url)},
        createContext:async (_signal,proxy)=>{
          const channel=process.env.WENKU8_TEST_BROWSER;
          const browser=await chromium.launch({headless:true,...(channel?{channel}:{}),proxy,args:[${JSON.stringify(`--ignore-certificate-errors-spki-list=${spki}`)}]});
          return browser.newContext();
        }
      });
      console.log(JSON.stringify({transport:session.transport,authenticated:session.cookieJar.getCookieStringSync('https://www.wenku8.net/').includes('synthetic_session=valid')}));
    `;
    const result = await isolatedProgram(program, {
      NODE_EXTRA_CA_CERTS: site.certificate,
      CURL_CA_BUNDLE: site.certificate,
      no_proxy: '*',
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ authenticated: true });
    expect(site.hits).toContain('GET /userdetail.php');
    expect(site.hits.filter((hit) => hit === 'POST /login.php')).toHaveLength(1);
    expect(site.proxy.requests.some((item) => item.url === 'www.wenku8.net:443')).toBe(true);
  }, 25_000);
});

describe('CLI proxy options', () => {
  async function run(args: string[], env: NodeJS.ProcessEnv = {}) {
    const directory = await mkdtemp(path.join(tmpdir(), 'wenku8-proxy-cli-'));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const session = {
      version: 1,
      id: '00000000-0000-4000-8000-000000000000',
      userAgent: 'proxy-test',
      transport: 'node',
      cookieJar: new CookieJar().serializeSync(),
    };
    const configuration = userConfigDirectory({
      home: directory,
      env: { APPDATA: directory, XDG_CONFIG_HOME: directory },
    });
    await mkdir(configuration, { recursive: true });
    await writeFile(path.join(configuration, 'session.json'), JSON.stringify(session));
    const preload = path.join(directory, 'preload.mjs');
    await writeFile(
      preload,
      `import os from 'node:os'; os.homedir = () => ${JSON.stringify(directory)};`,
    );
    try {
      return await execFileAsync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--import',
          pathToFileURL(preload).href,
          fileURLToPath(new URL('../cli.ts', import.meta.url)),
          ...args,
        ],
        {
          env: { ...process.env, APPDATA: directory, XDG_CONFIG_HOME: directory, ...env },
          timeout: 10_000,
        },
      );
    } catch (error) {
      const result = error as Error & { stdout: string; stderr: string };
      return { stdout: result.stdout, stderr: result.stderr };
    }
  }

  it('accepts global options before and after subcommands and ignores invalid environment overrides', async () => {
    const site = await siteFixture();
    for (const args of [
      ['--proxy', site.proxy.url, 'info', '42', '--json'],
      ['info', '42', '--json', '--proxy', site.proxy.url],
    ]) {
      const result = await run(args, {
        NODE_EXTRA_CA_CERTS: site.certificate,
        https_proxy: 'socks5://unsupported',
        no_proxy: 'unsupported:80',
      });
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toMatchObject({ title: '代理下载测试' });
    }
    expect(site.hits.filter((hit) => hit === 'GET /book/42.htm')).toHaveLength(2);
  }, 25_000);

  it('rejects conflicting modes and private proxy URLs without echoing secrets', async () => {
    for (const args of [
      ['--proxy', 'http://private-user:private-password@localhost', 'info', '1973'],
      ['info', '1973', '--no-proxy', '--proxy', 'http://private-user:private-password@localhost'],
      ['--proxy', 'http://localhost', 'info', '1973', '--no-proxy'],
    ]) {
      const result = await run(args);
      expect(result.stderr).toMatch(/不支持带认证|不能同时/);
      expect(result.stderr).not.toContain('private-user');
      expect(result.stderr).not.toContain('private-password');
    }
  }, 20_000);

  it('keeps offline commands usable with invalid environment variables, and advertises global options', async () => {
    for (const args of [['--help'], ['--version'], ['config']]) {
      const result = await run(args, {
        http_proxy: 'socks5://unsupported',
        no_proxy: 'unsupported:8080',
      });
      expect(result.stderr).toBe('');
      expect(result.stdout.length).toBeGreaterThan(0);
      if (args[0] === '--help') expect(result.stdout).toContain('--no-proxy');
    }
  }, 20_000);
});
