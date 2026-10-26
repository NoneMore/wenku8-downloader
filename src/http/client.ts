import { spawn } from 'node:child_process';
import PQueue from 'p-queue';
import pRetry, { AbortError } from 'p-retry';
import { CookieJar } from 'tough-cookie';
import { Agent, ProxyAgent } from 'undici';
import {
  CloudflareChallengeError,
  HttpStatusError,
  NonRetryableHttpError,
} from '../domain/errors.js';
import { resolveProxy, validateProxy, type ProxyOptions } from './proxy.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export interface HttpClientOptions extends ProxyOptions {
  concurrency?: number;
  timeoutMs?: number;
  retries?: number;
  minDelayMs?: number;
  requestsPerSecond?: number;
  preferCurl?: boolean;
  allowCurlFallback?: boolean;
  rateLimitCooldownMs?: number;
  cookie?: string;
  cookieJar?: CookieJar;
  userAgent?: string;
  onCookiesChanged?: (changes: readonly CookieUpdate[]) => Promise<void>;
  onRetry?: (event: HttpRetryEvent) => void;
}

export interface CookieUpdate {
  url: string;
  cookie: string;
}

export interface HttpClientStats {
  fetchRequests: number;
  curlRequests: number;
  cloudflareChallenges: number;
  curlFallbacks: number;
  http429Responses: number;
  retryableFailures: number;
  automaticRetries: number;
  rateLimitCooldowns: number;
  rateLimitCooldownWaitMs: number;
  statusCodes: Record<string, number>;
}

export interface HttpRetryEvent {
  url: string;
  attemptNumber: number;
  retriesLeft: number;
  retriesConsumed: number;
  error: Error;
  status?: number;
}

export class HttpClient {
  private readonly queue: PQueue;
  readonly cookieJar: CookieJar;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly minDelayMs: number;
  private readonly headers: HeadersInit;
  private readonly cookie: string | undefined;
  private cookieSeeded = false;
  private readonly onCookiesChanged:
    | ((changes: readonly CookieUpdate[]) => Promise<void>)
    | undefined;
  private readonly allowCurlFallback: boolean;
  private readonly userAgent: string;
  private readonly rateLimitCooldownMs: number;
  private readonly onRetry: ((event: HttpRetryEvent) => void) | undefined;
  private readonly rateLimitUntil = new Map<string, number>();
  private useCurlTransport = false;
  private readonly proxy: string | false | undefined;
  private readonly requestStats: HttpClientStats = {
    fetchRequests: 0,
    curlRequests: 0,
    cloudflareChallenges: 0,
    curlFallbacks: 0,
    http429Responses: 0,
    retryableFailures: 0,
    automaticRetries: 0,
    rateLimitCooldowns: 0,
    rateLimitCooldownWaitMs: 0,
    statusCodes: {},
  };

  constructor(options: HttpClientOptions = {}) {
    this.proxy = typeof options.proxy === 'string' ? validateProxy(options.proxy) : options.proxy;
    this.queue = new PQueue({
      concurrency: options.concurrency ?? 3,
      intervalCap: options.requestsPerSecond ?? 1,
      interval: 1000,
      strict: true,
    });
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 4;
    this.minDelayMs = options.minDelayMs ?? 800;
    this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? 15_000;
    this.onRetry = options.onRetry;
    this.cookieJar = options.cookieJar ?? new CookieJar();
    this.onCookiesChanged = options.onCookiesChanged;
    this.allowCurlFallback = options.allowCurlFallback ?? true;
    this.cookie = options.cookie?.trim();
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.useCurlTransport = options.preferCurl ?? false;
    this.headers = {
      accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'cache-control': 'no-cache',
      pragma: 'no-cache',
      'upgrade-insecure-requests': '1',
      'user-agent': this.userAgent,
    };
  }

  async bytes(
    url: string,
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; response: Response }> {
    return this.request(url, {}, signal);
  }

  async postForm(url: string, body: string, signal?: AbortSignal): Promise<string> {
    const { data } = await this.request(url, { method: 'POST', body }, signal);
    return new TextDecoder('gb18030').decode(data);
  }

  private async request(
    url: string,
    init: { method?: 'POST'; body?: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; response: Response }> {
    // Legacy library callers can still supply a string, scoped to the initial host.
    if (!this.cookieSeeded) {
      this.cookieSeeded = true;
      for (const pair of this.cookie?.split(';') ?? []) {
        this.cookieJar.setCookieSync(`${pair.trim()}; Path=/`, url);
      }
    }
    return pRetry(
      async () => {
        if (signal?.aborted) throw new AbortError(abortReason(signal));
        try {
          return await this.followRedirects(url, init, signal);
        } catch (error) {
          if (
            !init.method &&
            this.allowCurlFallback &&
            !this.useCurlTransport &&
            (this.cookie || this.cookieJar.serializeSync()?.cookies?.length) &&
            error instanceof CloudflareChallengeError
          ) {
            this.useCurlTransport = true;
            this.requestStats.curlFallbacks += 1;
            return this.followRedirects(url, init, signal);
          }
          throw error;
        }
      },
      {
        // Authentication submissions must never be replayed by automatic retries.
        retries: init.method ? 0 : this.retries,
        minTimeout: this.minDelayMs,
        maxTimeout: 10_000,
        factor: 2,
        randomize: true,
        shouldRetry: ({ error }) =>
          !(error instanceof CloudflareChallengeError || error instanceof NonRetryableHttpError),
        onFailedAttempt: ({ error, attemptNumber, retriesLeft, retriesConsumed }) => {
          if (
            retriesLeft > 0 &&
            !(error instanceof CloudflareChallengeError) &&
            !(error instanceof NonRetryableHttpError)
          ) {
            this.requestStats.automaticRetries += 1;
            this.onRetry?.({
              url,
              attemptNumber,
              retriesLeft,
              retriesConsumed,
              error,
              ...(error instanceof HttpStatusError ? { status: error.status } : {}),
            });
          }
        },
      },
    );
  }

  private async followRedirects(
    initialUrl: string,
    init: { method?: 'POST'; body?: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; response: Response }> {
    let url = initialUrl;
    let current = init;
    for (let hops = 0; hops < 10; hops += 1) {
      signal?.throwIfAborted();
      const output = await this.queue.add(async () => {
        signal?.throwIfAborted();
        await this.waitForRateLimitCooldown(url, signal);
        const cookie = await this.cookieJar.getCookieString(url);
        const headers = new Headers(this.headers);
        if (cookie) headers.set('cookie', cookie);
        if (current.method) headers.set('content-type', 'application/x-www-form-urlencoded');
        return this.useCurlTransport
          ? this.curlBytes(url, headers, current, signal)
          : this.fetchBytes(url, headers, current, signal);
      });
      const changes: CookieUpdate[] = [];
      for (const value of output.response.headers.getSetCookie()) {
        if (await this.cookieJar.setCookie(value, url, { ignoreError: true }))
          changes.push({ url, cookie: value });
      }
      if (changes.length && this.onCookiesChanged) {
        try {
          await this.onCookiesChanged(changes);
        } catch (error) {
          throw new AbortError(
            error instanceof Error ? error : new Error('无法保存更新后的登录态'),
          );
        }
      }
      const status = output.response.status;
      this.recordStatus(status);
      if (status === 407)
        throw new NonRetryableHttpError('代理要求认证（HTTP 407），请使用无需认证的代理');
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = output.response.headers.get('location');
        if (!location) throw new AbortError('站点重定向缺少目标地址');
        const target = new URL(location, url);
        if (!['https:', 'http:'].includes(target.protocol)) throw new AbortError('不支持的重定向');
        if (
          new URL(url).protocol === 'https:' &&
          target.protocol === 'http:' &&
          (init.method || (await this.cookieJar.getCookieString(target.href)))
        )
          throw new AbortError('拒绝 HTTPS 到 HTTP 的降级重定向');
        if (
          init.method &&
          (target.origin !== new URL(initialUrl).origin || target.protocol !== 'https:')
        ) {
          throw new AbortError('登录重定向目标不受信任，已停止发送认证信息');
        }
        if (current.method && (status === 307 || status === 308))
          throw new AbortError('登录重定向要求重新提交凭证，已停止自动提交');
        if (status === 303 || ((status === 301 || status === 302) && current.method)) current = {};
        url = target.href;
        continue;
      }
      if (output.response.headers.get('cf-mitigated') === 'challenge') {
        this.requestStats.cloudflareChallenges += 1;
        throw new CloudflareChallengeError(url);
      }
      if (!isSuccessfulStatus(status)) {
        if (status === 429) {
          this.requestStats.http429Responses += 1;
          this.applyRateLimitCooldown(
            url,
            retryAfterMs(output.response.headers.get('retry-after')),
          );
        }
        if (isRetryableStatus(status)) this.requestStats.retryableFailures += 1;
        const error = new HttpStatusError(url, status);
        if (!isRetryableStatus(status)) throw new AbortError(error);
        throw error;
      }
      return output;
    }
    throw new AbortError('站点重定向次数过多');
  }

  private async fetchBytes(
    url: string,
    headers: Headers,
    init: { method?: 'POST'; body?: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; response: Response }> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const proxy = resolveProxy(url, this.proxy);
    const dispatcher = proxy
      ? new ProxyAgent({ uri: proxy, proxyTunnel: false, connectTimeout: this.timeoutMs })
      : proxy === false
        ? new Agent()
        : undefined;
    this.requestStats.fetchRequests += 1;
    try {
      const requestOptions = {
        ...init,
        headers,
        redirect: 'manual' as const,
        signal: combinedSignal,
        ...(dispatcher ? { dispatcher } : {}),
      };
      const response = await fetch(url, requestOptions);
      return { data: new Uint8Array(await response.arrayBuffer()), response };
    } catch (error) {
      if (signal?.aborted) throw new AbortError(abortReason(signal));
      if (proxy)
        throw new NonRetryableHttpError(
          timeout.aborted
            ? '代理请求超时，请检查代理连接'
            : '代理请求失败，请检查代理连接、认证设置及目标证书',
        );
      throw error;
    } finally {
      await dispatcher?.destroy();
    }
  }

  private async curlBytes(
    url: string,
    headers: Headers,
    init: { method?: 'POST'; body?: string },
    signal?: AbortSignal,
  ): Promise<{ data: Uint8Array; response: Response }> {
    const curlOptions: CurlOptions = {
      timeoutMs: this.timeoutMs,
      userAgent: this.userAgent,
      headers,
      proxy: this.proxy,
      ...init,
    };
    if (signal) curlOptions.signal = signal;
    this.requestStats.curlRequests += 1;
    const output = await runCurl(url, curlOptions);
    return {
      data: output.data,
      response: new Response(null, { status: output.status, headers: output.headers }),
    };
  }

  async text(url: string, encoding = 'gb18030', signal?: AbortSignal): Promise<string> {
    const { data } = await this.bytes(url, signal);
    return new TextDecoder(encoding).decode(data);
  }

  async onIdle(): Promise<void> {
    await this.queue.onIdle();
  }

  getUserAgent(): string {
    return this.userAgent;
  }

  getTransport(): 'node' | 'curl' {
    return this.useCurlTransport ? 'curl' : 'node';
  }

  stats(): HttpClientStats {
    return {
      ...this.requestStats,
      statusCodes: { ...this.requestStats.statusCodes },
    };
  }

  private recordStatus(status: number): void {
    const key = String(status);
    this.requestStats.statusCodes[key] = (this.requestStats.statusCodes[key] ?? 0) + 1;
  }

  private applyRateLimitCooldown(url: string, retryAfterMs?: number): void {
    const origin = originFor(url);
    const duration = retryAfterMs ?? this.rateLimitCooldownMs;
    const until = Date.now() + duration + jitter(500);
    this.rateLimitUntil.set(origin, Math.max(this.rateLimitUntil.get(origin) ?? 0, until));
    this.requestStats.rateLimitCooldowns += 1;
  }

  private async waitForRateLimitCooldown(url: string, signal?: AbortSignal): Promise<void> {
    const until = this.rateLimitUntil.get(originFor(url)) ?? 0;
    const waitMs = Math.max(0, until - Date.now());
    if (waitMs <= 0) return;
    this.requestStats.rateLimitCooldownWaitMs += waitMs;
    await abortableDelay(waitMs, signal);
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isSuccessfulStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

function originFor(url: string): string {
  return new URL(url).origin;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (Number.isFinite(timestamp)) return Math.max(0, timestamp - Date.now());
  return undefined;
}

function jitter(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AbortError(abortReason(signal)));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new AbortError(signal ? abortReason(signal) : new Error('请求已取消')));
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function runCurl(
  url: string,
  options: CurlOptions,
): Promise<{ data: Uint8Array; status: number; headers: Headers }> {
  const marker = '\n__WENKU8_HTTP_STATUS__:';
  const child = spawn('curl', ['--config', '-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];

  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  // curl diagnostics may contain request secrets; never forward them to the CLI.
  child.stderr.resume();
  child.stdin.on('error', () => undefined);

  const abort = () => child.kill('SIGTERM');
  options.signal?.addEventListener('abort', abort, { once: true });

  child.stdin.end(curlConfig(url, options, marker));

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on('error', () => reject(new Error('无法启动 curl，请安装 curl 后重试')));
    child.on('close', resolve);
  }).finally(() => options.signal?.removeEventListener('abort', abort));

  if (options.signal?.aborted) throw new AbortError(abortReason(options.signal));
  const buffer = Buffer.concat(stdout);
  const markerIndex = buffer.lastIndexOf(marker);
  const [statusText, connectStatus, proxyUsed] = buffer
    .subarray(markerIndex + marker.length)
    .toString('utf8')
    .trim()
    .split(';');
  if (markerIndex >= 0 && (statusText === '407' || connectStatus === '407'))
    throw new NonRetryableHttpError('代理要求认证（HTTP 407），请使用无需认证的代理');
  // Let curl account for its own environment, user config and NO_PROXY rules.
  // Older curl can still classify an explicit proxy, but cannot report proxy_used.
  if (
    exitCode === 5 ||
    (exitCode === 7 &&
      (proxyUsed === '1' || typeof options.proxy === 'string') &&
      statusText === '000' &&
      connectStatus === '000')
  )
    throw new NonRetryableHttpError(`无法连接代理（curl 退出码 ${exitCode}）`);
  if (exitCode === 7 && options.proxy === undefined && proxyUsed !== '0' && proxyUsed !== '1')
    throw new NonRetryableHttpError('curl 无法报告代理使用状态，请升级至 8.7 或更高版本后重试');
  if (exitCode !== 0) {
    throw new Error(`curl 请求失败（退出码 ${exitCode ?? '未知'}）`);
  }

  if (markerIndex < 0) throw new Error('curl 响应缺少 HTTP 状态码');
  const status = Number(statusText);
  if (!Number.isInteger(status)) throw new Error('curl 响应状态码无效');
  let start = 0;
  let headers = new Headers();
  // --include can produce interim 1xx headers before the final response.
  while (true) {
    const end = buffer.indexOf('\r\n\r\n', start);
    if (end < 0 || end >= markerIndex) throw new Error('curl 响应头无效');
    const lines = buffer.subarray(start, end).toString('latin1').split('\r\n');
    const headerStatus = Number(lines.shift()?.split(' ')[1]);
    headers = new Headers();
    for (const line of lines) {
      const colon = line.indexOf(':');
      if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
    }
    start = end + 4;
    if (headerStatus >= 200) break;
  }
  return { data: buffer.subarray(start, markerIndex), status, headers };
}

function curlConfig(url: string, options: CurlOptions, marker: string): string {
  return [
    'silent',
    'show-error',
    'include',
    'suppress-connect-headers',
    'compressed',
    ...(options.proxy === undefined
      ? []
      : [`proxy = "${escapeCurlConfig(options.proxy || '')}"`, 'noproxy = ""']),
    `connect-timeout = "${Math.ceil(options.timeoutMs / 1000)}"`,
    `max-time = "${Math.ceil(options.timeoutMs / 1000)}"`,
    `url = "${escapeCurlConfig(url)}"`,
    `user-agent = "${escapeCurlConfig(options.userAgent)}"`,
    ...Array.from(
      options.headers,
      ([key, value]) => `header = "${escapeCurlConfig(`${key}: ${value}`)}"`,
    ),
    ...(options.method
      ? [`request = "POST"`, `data-raw = "${escapeCurlConfig(options.body ?? '')}"`]
      : []),
    `write-out = "${escapeCurlConfig(`${marker}%{http_code};%{http_connect};%{proxy_used}`)}"`,
    '',
  ].join('\n');
}

interface CurlOptions {
  proxy: string | false | undefined;
  timeoutMs: number;
  headers: Headers;
  method?: 'POST';
  body?: string;
  userAgent: string;
  signal?: AbortSignal;
}

function escapeCurlConfig(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('请求已取消');
}
