import { isIP } from 'node:net';

export interface ProxyOptions {
  /** Omit to inherit the environment; false forces direct connections. */
  proxy?: string | false;
}

export class ProxyConfigurationError extends Error {
  readonly code = 'PROXY_CONFIGURATION';
}

export class ProxyAuthenticationError extends Error {
  readonly code = 'PROXY_AUTHENTICATION';
  constructor() {
    super('代理要求认证（HTTP 407），当前版本仅支持无需认证的 HTTP 代理');
  }
}

type Environment = Readonly<Record<string, string | undefined>>;

/** Resolve once per destination, including redirect hops, independently of transport defaults. */
export class ProxyPolicy {
  private readonly env: Environment;

  constructor(
    private readonly proxy?: string | false,
    env: Environment = process.env,
  ) {
    this.env = { ...env };
    if (typeof proxy === 'string') parseProxy(proxy, '--proxy');
  }

  resolve(target: string | URL): string | undefined {
    if (this.proxy === false) return undefined;
    if (typeof this.proxy === 'string') return parseProxy(this.proxy, '--proxy');
    const url = new URL(target);
    const bypass = this.variable('no_proxy');
    if (bypass && matchesBypass(url.hostname, bypass.value, bypass.name)) return undefined;
    const selected =
      this.variable(url.protocol === 'https:' ? 'https_proxy' : 'http_proxy') ??
      this.variable('all_proxy');
    return selected ? parseProxy(selected.value, selected.name) : undefined;
  }

  private variable(name: string): { name: string; value: string } | undefined {
    for (const key of [name, name.toUpperCase()]) {
      const value = this.env[key]?.trim();
      if (value) return { name: key, value };
    }
    return undefined;
  }
}

function parseProxy(value: string, source: string): string {
  const fail = (reason: string): never => {
    throw new ProxyConfigurationError(`${source}：${reason}`);
  };
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return fail('代理地址无效，需要 http://host:port');
  }
  if (url.protocol !== 'http:') fail('仅支持 http:// 代理服务器');
  if (url.username || url.password || value.includes('@')) fail('不支持带认证信息的代理');
  if (!url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash)
    fail('代理地址仅可包含主机和端口');
  return url.origin;
}

function normalizeHost(value: string): string {
  const host = value
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (isIP(host) === 6) return new URL(`http://[${host}]`).hostname.slice(1, -1);
  return host;
}

function matchesBypass(hostname: string, value: string, source: string): boolean {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  // Validate the whole list before matching, so an earlier wildcard cannot hide bad entries.
  for (const entry of entries) {
    if (entry === '*' || isIP(entry)) continue;
    if (!/^\.?[a-z\d_-]+(?:\.[a-z\d_-]+)*\.?$/i.test(entry))
      throw new ProxyConfigurationError(`${source}：不支持的绕过条目（端口、CIDR 或通配模式等）`);
  }
  const host = normalizeHost(hostname);
  return entries.some((entry) => {
    if (entry === '*') return true;
    const candidate = normalizeHost(entry.replace(/^\./, ''));
    if (isIP(host) || isIP(candidate)) return host === candidate;
    return host === candidate || host.endsWith(`.${candidate}`);
  });
}

export function isProxyError(
  error: unknown,
): error is ProxyConfigurationError | ProxyAuthenticationError {
  return error instanceof ProxyConfigurationError || error instanceof ProxyAuthenticationError;
}

export function isProxyAuthenticationFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    /(?:proxy.*407|407.*(?:proxy|tunneling))/i.test(error.message) ||
    isProxyAuthenticationFailure(error.cause)
  );
}
