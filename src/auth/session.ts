import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { z } from 'zod';
import lockfile from 'proper-lockfile';
import { userConfigDirectory, type UserDirectoryOptions } from '../cli/paths.js';
import type { CookieUpdate } from '../http/client.js';

export interface AccountSession {
  id: string;
  userAgent: string;
  transport: 'node' | 'curl';
  cookieJar: CookieJar;
}

const schema = z.object({
  version: z.literal(1),
  id: z.string().uuid(),
  transport: z.enum(['node', 'curl']),
  userAgent: z
    .string()
    .min(1)
    .refine((value) => !/[\r\n]/.test(value)),
  cookieJar: z.object({ cookies: z.array(z.unknown()) }).passthrough(),
});

export function sessionPath(options: UserDirectoryOptions = {}): string {
  return path.join(userConfigDirectory(options), 'session.json');
}

export class SessionStore {
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly file = sessionPath()) {}

  async load(): Promise<AccountSession | undefined> {
    let content: string;
    try {
      content = await readFile(this.file, 'utf8');
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined;
      throw new Error('无法读取登录态，请检查用户配置目录权限');
    }
    try {
      const data = schema.parse(JSON.parse(content));
      return {
        id: data.id,
        userAgent: data.userAgent,
        transport: data.transport,
        cookieJar: CookieJar.deserializeSync(JSON.stringify(data.cookieJar)),
      };
    } catch {
      throw new Error('登录态文件无效，请重新运行 `wenku8 login`');
    }
  }

  async save(session: AccountSession): Promise<void> {
    return this.enqueue(async () => this.write(session));
  }

  async update(session: AccountSession, changes: readonly CookieUpdate[]): Promise<void> {
    return this.enqueue(async () => {
      // A request finishing after logout or another login must not restore its old session.
      const current = await this.load();
      if (current?.id !== session.id) return;
      for (const change of changes) {
        await current.cookieJar.setCookie(change.cookie, change.url, { ignoreError: true });
      }
      if (changes.length) await this.write(current);
    });
  }

  async logout(): Promise<void> {
    return this.enqueue(async () => {
      await rm(this.file, { force: true });
    });
  }

  private async write(session: AccountSession): Promise<void> {
    const temp = `${this.file}.${randomUUID()}.tmp`;
    try {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await writeFile(
        temp,
        JSON.stringify({
          version: 1,
          id: session.id,
          userAgent: session.userAgent,
          transport: session.transport,
          cookieJar: session.cookieJar.serializeSync(),
        }),
        { encoding: 'utf8', mode: 0o600, flag: 'wx' },
      );
      await rename(temp, this.file);
    } catch {
      throw new Error('无法保存登录态，请检查用户配置目录权限；原有登录态未替换');
    } finally {
      await rm(temp, { force: true }).catch(() => undefined);
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const locked = async () => {
      let release: (() => Promise<void>) | undefined;
      try {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        release = await lockfile.lock(this.file, {
          realpath: false,
          retries: { retries: 5, minTimeout: 100, maxTimeout: 500 },
        });
      } catch {
        throw new Error('无法保存或清除登录态，请检查配置目录权限，或等待其他认证操作结束后重试');
      }
      try {
        await work();
      } finally {
        await release();
      }
    };
    const next = this.writes.then(locked, locked);
    this.writes = next.catch(() => undefined);
    return next;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
