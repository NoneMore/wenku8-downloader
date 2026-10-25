import { createServer, request, type IncomingHttpHeaders } from 'node:http';
import { connect, type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { ProxyAuthenticationError, isProxyError, type ProxyPolicy } from './proxy.js';

/** A loopback relay keeps Chromium's per-protocol and bypass rules identical to CLI requests.
 * CONNECT is relayed as bytes; TLS and certificate verification remain in the browser. */
export async function startBrowserProxy(policy: ProxyPolicy) {
  const sockets = new Set<Duplex>();
  const failures = new Map<string, Error>();
  const remember = (target: URL | undefined, error: unknown) => {
    if (target && isProxyError(error)) failures.set(target.origin, error);
  };
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    return socket;
  };
  const server = createServer((incoming, response) => {
    let target: URL | undefined;
    let proxy: string | undefined;
    try {
      target = new URL(incoming.url ?? '');
      if (target.protocol !== 'http:') throw new Error('Invalid proxy request');
      proxy = policy.resolve(target);
    } catch (error) {
      remember(target, error);
      response.writeHead(502).end();
      return;
    }
    const outgoing = request(
      proxy ?? target,
      {
        method: incoming.method,
        path: proxy ? target.href : `${target.pathname}${target.search}`,
        headers: forwardHeaders(incoming.headers, target.host),
        agent: false,
      },
      (upstream) => {
        if (proxy && upstream.statusCode === 407) remember(target, new ProxyAuthenticationError());
        response.writeHead(upstream.statusCode ?? 502, upstream.headers);
        upstream.pipe(response);
        upstream.on('error', () => response.destroy());
      },
    );
    outgoing.on('socket', track);
    outgoing.setTimeout(20_000, () => outgoing.destroy(new Error('Proxy request timed out')));
    outgoing.on('error', () => {
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
    response.on('close', () => outgoing.destroy());
    incoming.pipe(outgoing);
  });
  server.on('connection', track);
  server.on('connect', (incoming, downstream, head) => {
    track(downstream);
    let target: URL | undefined;
    let proxy: string | undefined;
    try {
      target = new URL(`https://${incoming.url ?? ''}`);
      if (target.username || target.password || target.pathname !== '/')
        throw new Error('Invalid tunnel');
      proxy = policy.resolve(target);
    } catch (error) {
      remember(target, error);
      downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    const authority = `${target.hostname}:${target.port || '443'}`;
    const tunnel = (upstream: Duplex, initial: Buffer = Buffer.alloc(0)) => {
      track(upstream);
      if (downstream.destroyed) {
        upstream.destroy();
        return;
      }
      downstream.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (initial.length) downstream.write(initial);
      if (head.length) upstream.write(head);
      upstream.pipe(downstream);
      downstream.pipe(upstream);
      upstream.on('close', () => downstream.destroy());
      downstream.on('close', () => upstream.destroy());
    };
    const fail = () => downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    if (!proxy) {
      const upstream: Socket = track(
        connect({
          host: target.hostname.replace(/^\[|\]$/g, ''),
          port: Number(target.port || 443),
        }),
      );
      upstream.setTimeout(20_000, () => upstream.destroy());
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        tunnel(upstream);
      });
      upstream.once('error', fail);
      downstream.on('close', () => upstream.destroy());
    } else {
      const outgoing = request(proxy, {
        method: 'CONNECT',
        path: authority,
        headers: { host: authority },
        agent: false,
      });
      outgoing.on('socket', track);
      outgoing.setTimeout(20_000, () => outgoing.destroy());
      outgoing.on('connect', (response, upstream, initial) => {
        if (response.statusCode !== 200) {
          if (response.statusCode === 407) remember(target, new ProxyAuthenticationError());
          upstream.destroy();
          fail();
          return;
        }
        upstream.setTimeout(0);
        tunnel(upstream, initial);
      });
      outgoing.on('error', fail);
      downstream.on('close', () => outgoing.destroy());
      outgoing.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动浏览器代理转发');
  return {
    settings: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' },
    failureFor(target: string) {
      return failures.get(new URL(target).origin);
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

function forwardHeaders(headers: IncomingHttpHeaders, host: string): IncomingHttpHeaders {
  const result: IncomingHttpHeaders = { ...headers, host };
  for (const key of [
    ...(headers.connection ?? '').split(',').map((key) => key.trim().toLowerCase()),
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'keep-alive',
    'upgrade',
  ]) {
    delete result[key];
  }
  return result;
}
