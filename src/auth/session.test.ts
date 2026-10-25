import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import lockfile from 'proper-lockfile';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore, type AccountSession } from './session.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function setup() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wenku8-session-'));
  directories.push(directory);
  const file = path.join(directory, 'session.json');
  return { directory, file, store: new SessionStore(file) };
}

function session(): AccountSession {
  const cookieJar = new CookieJar();
  cookieJar.setCookieSync(
    'test_session=synthetic; Path=/; Secure; HttpOnly',
    'https://www.wenku8.net',
  );
  return { id: randomUUID(), userAgent: 'Test browser', transport: 'curl', cookieJar };
}

describe('SessionStore', () => {
  it('merges independent response changes without restoring stale cookies, including deletions', async () => {
    const { store, file } = await setup();
    await store.save(session());
    const a = (await new SessionStore(file).load())!;
    const b = (await new SessionStore(file).load())!;
    const url = 'https://www.wenku8.net';
    await new SessionStore(file).update(a, [
      { url, cookie: 'test_session=rotated; Path=/; Secure; HttpOnly' },
    ]);
    await new SessionStore(file).update(b, [{ url, cookie: 'other=fresh; Path=/; Secure' }]);
    expect((await store.load())!.cookieJar.getCookieStringSync(url)).toBe(
      'test_session=rotated; other=fresh',
    );
    await new SessionStore(file).update(a, [
      { url, cookie: 'other=deleted; Path=/; Secure; Max-Age=0' },
    ]);
    await new SessionStore(file).update(b, [{ url, cookie: 'third=value; Path=/; Secure' }]);
    expect((await store.load())!.cookieJar.getCookieStringSync(url)).toBe(
      'test_session=rotated; third=value',
    );
  });
  it('serializes independent stores so an in-flight refresh cannot undo logout', async () => {
    const { store, file } = await setup();
    const original = session();
    await store.save(original);
    const release = await lockfile.lock(file);
    const update = new SessionStore(file).update(original, []);
    const logout = new SessionStore(file).logout();
    await release();
    await Promise.all([update, logout]);
    expect(await store.load()).toBeUndefined();
  });
  it('round-trips scoped session cookies across store instances and clears them on logout', async () => {
    const { store, file } = await setup();
    const original = session();
    await store.save(original);
    const loaded = (await new SessionStore(file).load())!;
    expect(loaded.id).toBe(original.id);
    expect(loaded.cookieJar.getCookieStringSync('https://www.wenku8.net')).toBe(
      'test_session=synthetic',
    );
    expect(loaded.cookieJar.getCookieStringSync('https://example.org')).toBe('');
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    await store.logout();
    expect(await new SessionStore(file).load()).toBeUndefined();
  });

  it('ignores old cookie sources and hides malformed session contents', async () => {
    const { store, directory, file } = await setup();
    await writeFile(path.join(directory, 'cookie'), 'synthetic-old-secret');
    await writeFile(path.join(directory, '.wenku8-cookie'), 'synthetic-old-secret');
    expect(await store.load()).toBeUndefined();
    await writeFile(file, 'synthetic-sensitive-invalid-json');
    await expect(store.load()).rejects.toThrow('登录态文件无效');
    await expect(store.load()).rejects.not.toThrow('synthetic-sensitive');
  });

  it('does not replace an existing session when writing fails', async () => {
    const { store, file } = await setup();
    await store.save(session());
    const content = await readFile(file, 'utf8');
    await expect(new SessionStore(path.join(file, 'child')).save(session())).rejects.toThrow(
      /无法保存/,
    );
    expect(await readFile(file, 'utf8')).toBe(content);
  });

  it('does not resurrect a logged-out or replaced session through response updates', async () => {
    const { store } = await setup();
    const old = session();
    await store.save(old);
    const replacement = session();
    await store.save(replacement);
    await store.update(old, []);
    expect((await store.load())?.id).toBe(replacement.id);
    await store.logout();
    await store.update(replacement, []);
    expect(await store.load()).toBeUndefined();
  });

  it('does not damage a previous session when a replacement cannot be serialized', async () => {
    const { store, file } = await setup();
    await store.save(session());
    const content = await readFile(file, 'utf8');
    const invalid = session();
    invalid.cookieJar.serializeSync = () => {
      throw new Error('synthetic-secret');
    };
    await expect(store.save(invalid)).rejects.toThrow(/无法保存/);
    expect(await readFile(file, 'utf8')).toBe(content);
  });
});
