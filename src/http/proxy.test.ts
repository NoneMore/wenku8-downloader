import { createServer, request, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFile, mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CookieJar } from 'tough-cookie';
import iconv from 'iconv-lite';
import { HttpClient } from './client.js';
import { resolveProxy, validateProxy } from './proxy.js';
import { NonRetryableHttpError } from '../domain/errors.js';
import { userConfigDirectory } from '../cli/paths.js';

const execFileAsync = promisify(execFile);
const cleanup: Array<() => Promise<unknown>> = [];
beforeEach(() => {
  for (const name of ['http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    vi.stubEnv(name, undefined);
    vi.stubEnv(name.toUpperCase(), undefined);
  }
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
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

async function proxyServer(tunnelPort?: number, status?: number) {
  const hits: string[] = [];
  const server = createServer((incoming, response) => {
    hits.push(incoming.url ?? '');
    if (status) {
      response.writeHead(status).end();
      return;
    }
    const target = new URL(incoming.url ?? '');
    const outgoing = request(target, { headers: incoming.headers, agent: false }, (upstream) => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
    outgoing.on('error', () => response.writeHead(502).end());
    response.on('close', () => outgoing.destroy());
    incoming.pipe(outgoing);
  });
  server.on('connect', (incoming, downstream, head) => {
    hits.push(incoming.url ?? '');
    if (status) {
      downstream.end(`HTTP/1.1 ${status} Failed\r\n\r\n`);
      return;
    }
    const target = new URL(`https://${incoming.url}`);
    const upstream = connect(tunnelPort ?? Number(target.port || 443), '127.0.0.1', () => {
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    upstream.on('error', () => downstream.destroy());
    downstream.on('error', () => upstream.destroy());
    downstream.on('close', () => upstream.destroy());
    upstream.on('close', () => downstream.destroy());
  });
  return { url: await listen(server), hits };
}

async function tlsTarget() {
  const cert = await readFile(new URL('./fixtures/proxy-test-cert.pem', import.meta.url));
  const key = await readFile(new URL('./fixtures/proxy-test-key.pem', import.meta.url));
  const form =
    '<form method="post" action="/login.php"><input name="username"><input name="password" type="password"><input type="submit"></form>';
  const url = (
    await listen(
      createHttpsServer({ key, cert }, (incoming, response) => {
        response.setHeader('content-type', 'text/html; charset=gbk');
        let html = 'tls-ok';
        if (incoming.url?.startsWith('/login.php')) {
          html = form;
          if (incoming.method === 'POST') {
            response.setHeader('set-cookie', 'synthetic=valid; Path=/; Secure; HttpOnly');
            html = '<a href="/logout.php">退出</a>';
          }
        } else if (incoming.url === '/userdetail.php') {
          html = incoming.headers.cookie?.includes('synthetic=valid')
            ? '<a href="/logout.php">退出</a>'
            : form;
        } else if (incoming.url === '/book/42.htm') {
          html =
            '<div id="content"><span><b>代理冒烟测试</b></span><a href="/novel/42/index.htm">目录</a></div>';
        }
        response.end(iconv.encode(html, 'gbk'));
      }),
    )
  ).replace('http:', 'https:');
  return {
    url,
    cert,
    certificate: fileURLToPath(new URL('./fixtures/proxy-test-cert.pem', import.meta.url)),
  };
}

async function runProgram(program: string, env: NodeJS.ProcessEnv) {
  return execFileAsync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
    {
      env: { ...process.env, ...env },
      timeout: 20_000,
    },
  );
}

it('inherits common proxy variables and honors explicit overrides', () => {
  vi.stubEnv('http_proxy', 'http://http.test:7890');
  vi.stubEnv('https_proxy', 'http://https.test:7890');
  vi.stubEnv('all_proxy', 'http://fallback.test:7890');
  expect(resolveProxy('http://example.test')).toBe('http://http.test:7890');
  expect(resolveProxy('https://example.test')).toBe('http://https.test:7890');
  vi.stubEnv('https_proxy', undefined);
  expect(resolveProxy('https://example.test')).toBe('http://fallback.test:7890');
  vi.stubEnv('no_proxy', '*');
  expect(resolveProxy('https://example.test')).toBeUndefined();
  expect(resolveProxy('https://example.test', 'http://forced.test')).toBe('http://forced.test');
  expect(resolveProxy('https://example.test', false)).toBe(false);
});

it('does not reject unrelated NO_PROXY entries and keeps excluded IP ranges direct', () => {
  vi.stubEnv('no_proxy', 'localhost,10.0.0.0/8,example.test:443,unsupported:format');
  expect(resolveProxy('http://unrelated.test')).toBeUndefined();
  vi.stubEnv('http_proxy', 'http://proxy.test');
  vi.stubEnv('https_proxy', 'http://proxy.test');
  expect(resolveProxy('http://unrelated.test')).toBe('http://proxy.test');
  expect(resolveProxy('http://localhost')).toBeUndefined();
  expect(resolveProxy('https://example.test')).toBeUndefined();
  expect(resolveProxy('http://10.2.3.4')).toBe(false);
  expect(resolveProxy('http://11.2.3.4')).toBe('http://proxy.test');
  vi.stubEnv('no_proxy', '10.0.0.0/,10.0.0.0/8/unsupported');
  expect(resolveProxy('http://11.2.3.4')).toBe('http://proxy.test');
});

it('keeps ordinary direct fetch free of a custom dispatcher', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('direct'));
  expect(await new HttpClient().text('http://example.test')).toBe('direct');
  expect(fetch.mock.calls[0]?.[1]).not.toHaveProperty('dispatcher');
});

it.each(['bad', 'https://proxy.test', 'http://private-user:private-password@proxy.test'])(
  'rejects unsupported proxies without echoing secrets',
  (value) => {
    expect(() => validateProxy(value)).toThrow(NonRetryableHttpError);
    try {
      validateProxy(value);
    } catch (error) {
      expect((error as Error).message).not.toMatch(/private-user|private-password/);
    }
  },
);

it.each([false, true])(
  'routes HTTP and supports explicit direct mode (curl=%s)',
  async (preferCurl) => {
    const target = await listen(createServer((_request, response) => response.end('ok')));
    const proxy = await proxyServer();
    vi.stubEnv('http_proxy', proxy.url);
    const options = { preferCurl, retries: 0, requestsPerSecond: 100 };
    expect(await new HttpClient(options).text(target)).toBe('ok');
    expect(proxy.hits).toHaveLength(1);
    vi.stubEnv('no_proxy', '127.0.0.1');
    expect(await new HttpClient(options).text(target)).toBe('ok');
    expect(proxy.hits).toHaveLength(1);
    expect(await new HttpClient({ ...options, proxy: proxy.url }).text(target)).toBe('ok');
    expect(proxy.hits).toHaveLength(2);
    expect(await new HttpClient({ ...options, proxy: false }).text(target)).toBe('ok');
    expect(proxy.hits).toHaveLength(2);
  },
);

it('forces direct access even when Node environment proxy support is enabled', async () => {
  const target = await listen(createServer((_request, response) => response.end('direct')));
  const proxy = await proxyServer();
  const result = await runProgram(
    `import {HttpClient} from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    console.log(await new HttpClient({proxy:false}).text(${JSON.stringify(target)}));`,
    {
      NODE_USE_ENV_PROXY: '1',
      http_proxy: proxy.url,
    },
  );
  expect(result.stdout.trim()).toBe('direct');
  expect(proxy.hits).toHaveLength(0);
});

it('preserves curl user configuration in automatic mode', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'wenku8-curl-config-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, '.curlrc'), 'header = "X-Wenku8-Test: configured"\n');
  vi.stubEnv('CURL_HOME', directory);
  const target = await listen(
    createServer((incoming, response) => response.end(incoming.headers['x-wenku8-test'])),
  );
  expect(await new HttpClient({ preferCurl: true, retries: 0 }).text(target)).toBe('configured');
});

it('keeps an internal proxy timeout fatal while preserving caller cancellation', async () => {
  let requests = 0;
  const cancel = new AbortController();
  const reason = new Error('caller cancelled');
  const proxy = await listen(
    createServer(() => {
      requests += 1;
      if (requests === 2) cancel.abort(reason);
    }),
  );
  const timedOut = new HttpClient({ proxy, timeoutMs: 500, retries: 2, minDelayMs: 1 });
  await expect(timedOut.text('http://example.test/image')).rejects.toBeInstanceOf(
    NonRetryableHttpError,
  );
  expect(timedOut.stats().automaticRetries).toBe(0);
  expect(requests).toBe(1);
  const cancelled = new HttpClient({ proxy, timeoutMs: 5_000, retries: 2, minDelayMs: 1 });
  await expect(cancelled.text('http://example.test/image', 'utf-8', cancel.signal)).rejects.toBe(
    reason,
  );
  expect(cancelled.stats().automaticRetries).toBe(0);
  expect(requests).toBe(2);
});

it('keeps a CIDR-excluded IP direct when Node environment proxy support is enabled', async () => {
  const target = await listen(createServer((_request, response) => response.end('direct')));
  const proxy = await proxyServer();
  const result = await runProgram(
    `import {HttpClient} from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    console.log(await new HttpClient({retries:0}).text(${JSON.stringify(target)}));`,
    {
      NODE_USE_ENV_PROXY: '1',
      http_proxy: proxy.url,
      no_proxy: '127.0.0.0/8',
    },
  );
  expect(result.stdout.trim()).toBe('direct');
  expect(proxy.hits).toHaveLength(0);
});

it.each([false, true])(
  'uses HTTPS CONNECT and retains certificate verification (curl=%s)',
  async (preferCurl) => {
    const target = await tlsTarget();
    const proxy = await proxyServer();
    const program = `import {HttpClient} from ${JSON.stringify(new URL('./client.ts', import.meta.url).href)};
    console.log(await new HttpClient({proxy:${JSON.stringify(proxy.url)},preferCurl:${preferCurl},retries:0}).text(${JSON.stringify(target.url)}));`;
    const result = await runProgram(program, {
      NODE_EXTRA_CA_CERTS: target.certificate,
      CURL_CA_BUNDLE: target.certificate,
    });
    expect(result.stdout.trim()).toBe('tls-ok');
    expect(proxy.hits).toEqual([new URL(target.url).host]);
    await expect(
      new HttpClient({ proxy: proxy.url, preferCurl, retries: 0 }).text(target.url),
    ).rejects.toThrow();
  },
  15_000,
);

it.each([false, true])(
  'does not fall back to direct access or hide proxy authentication failures (curl=%s)',
  async (preferCurl) => {
    let directHits = 0;
    const target = await listen(
      createServer((_request, response) => {
        directHits += 1;
        response.end('unexpected');
      }),
    );
    const rejecting = await proxyServer(undefined, 407);
    const options = { preferCurl, retries: 0 };
    await expect(
      new HttpClient({ ...options, proxy: rejecting.url }).text(target),
    ).rejects.toBeInstanceOf(NonRetryableHttpError);
    await expect(
      new HttpClient({ ...options, proxy: rejecting.url }).text('https://example.test'),
    ).rejects.toBeInstanceOf(NonRetryableHttpError);
    await expect(
      new HttpClient({ ...options, proxy: 'http://127.0.0.1:1' }).text(target),
    ).rejects.toBeInstanceOf(NonRetryableHttpError);
    vi.stubEnv('http_proxy', 'http://127.0.0.1:1');
    vi.stubEnv('no_proxy', '127.0.0.1');
    const originError: unknown = await new HttpClient(options)
      .text('http://127.0.0.1:1')
      .catch((error: unknown) => error);
    expect(originError).toBeInstanceOf(Error);
    expect(originError).not.toBeInstanceOf(NonRetryableHttpError);
    expect(directHits).toBe(0);
  },
);

it('hands native browser proxy configuration through login and CLI Cookie verification', async () => {
  const target = await tlsTarget();
  const proxy = await proxyServer(Number(new URL(target.url).port));
  const spki = createHash('sha256')
    .update(new X509Certificate(target.cert).publicKey.export({ type: 'spki', format: 'der' }))
    .digest('base64');
  const result = await runProgram(
    `
    import {chromium} from ${JSON.stringify(import.meta.resolve('playwright'))};
    import {CookieJar} from ${JSON.stringify(import.meta.resolve('tough-cookie'))};
    import {loginInBrowser} from ${JSON.stringify(new URL('../auth/browser.ts', import.meta.url).href)};
    const session=await loginInBrowser({username:'synthetic',password:'synthetic-password'},new CookieJar(),{
      proxy:${JSON.stringify(proxy.url)},createContext:async (_signal,proxy)=>{
        const channel=process.env.WENKU8_TEST_BROWSER;
        const browser=await chromium.launch({headless:true,...(channel?{channel}:{}),proxy,
          args:[${JSON.stringify(`--ignore-certificate-errors-spki-list=${spki}`)}]});
        return browser.newContext();
      }});
    console.log(session.cookieJar.getCookieStringSync('https://www.wenku8.net/').includes('synthetic=valid'));
  `,
    { NODE_EXTRA_CA_CERTS: target.certificate, CURL_CA_BUNDLE: target.certificate },
  );
  expect(result.stdout.trim()).toBe('true');
  expect(proxy.hits).toContain('www.wenku8.net:443');
}, 25_000);

it('runs a real CLI request through an explicit proxy', async () => {
  const target = await tlsTarget();
  const proxy = await proxyServer(Number(new URL(target.url).port));
  const directory = await mkdtemp(path.join(tmpdir(), 'wenku8-proxy-cli-'));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const configuration = userConfigDirectory({
    home: directory,
    env: { APPDATA: directory, XDG_CONFIG_HOME: directory },
  });
  await mkdir(configuration, { recursive: true });
  await writeFile(
    path.join(configuration, 'session.json'),
    JSON.stringify({
      version: 1,
      id: randomUUID(),
      userAgent: 'synthetic',
      transport: 'node',
      cookieJar: new CookieJar().serializeSync(),
    }),
  );
  const preload = path.join(directory, 'preload.mjs');
  await writeFile(
    preload,
    `import os from 'node:os'; os.homedir=()=>${JSON.stringify(directory)};`,
  );
  const result = await execFileAsync(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--import',
      pathToFileURL(preload).href,
      fileURLToPath(new URL('../cli.ts', import.meta.url)),
      'info',
      '42',
      '--json',
      '--proxy',
      proxy.url,
    ],
    {
      env: {
        ...process.env,
        APPDATA: directory,
        XDG_CONFIG_HOME: directory,
        NODE_EXTRA_CA_CERTS: target.certificate,
      },
      timeout: 10_000,
    },
  );
  expect(JSON.parse(result.stdout)).toMatchObject({ title: '代理冒烟测试' });
  expect(proxy.hits).toContain('www.wenku8.net:443');
}, 15_000);
