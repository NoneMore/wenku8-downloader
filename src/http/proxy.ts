import { BlockList, isIP } from 'node:net';
import { getProxyForUrl } from 'proxy-from-env';
import { NonRetryableHttpError } from '../domain/errors.js';

export interface ProxyOptions {
  /** Omit to inherit the environment; false forces direct connections. */
  proxy?: string | false;
}

export function validateProxy(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new NonRetryableHttpError('代理地址无效，需要 http://host:port');
  }
  if (url.protocol !== 'http:' || url.username || url.password || value.includes('@'))
    throw new NonRetryableHttpError('仅支持无需认证的 http:// 代理');
  if (url.pathname !== '/' || url.search || url.hash)
    throw new NonRetryableHttpError('代理地址仅可包含主机和端口');
  return url.origin;
}

export function resolveProxy(target: string, proxy?: string | false): string | undefined {
  if (proxy === false) return undefined;
  if (proxy !== undefined) return validateProxy(proxy);
  const selected = getProxyForUrl(target);
  if (!selected) return undefined;
  // proxy-from-env does not support CIDR. Honor valid IP exclusions rather than
  // sending an explicitly excluded IP to a proxy; unrelated entries never fail requests.
  const host = new URL(target).hostname.replace(/^\[|\]$/g, '');
  const family = isIP(host) === 6 ? 'ipv6' : 'ipv4';
  if (isIP(host)) {
    const excluded = new BlockList();
    for (const entry of (process.env.no_proxy || process.env.NO_PROXY || '').split(/[,\s]+/)) {
      const [, network, prefix] = /^(.+)\/(\d+)$/.exec(entry) ?? [];
      if (!network || !isIP(network)) continue;
      try {
        excluded.addSubnet(network, Number(prefix), isIP(network) === 6 ? 'ipv6' : 'ipv4');
      } catch {
        /* Ignore unsupported entries, like native proxy resolvers. */
      }
    }
    if (excluded.check(host, family)) return undefined;
  }
  return validateProxy(selected);
}
