import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(args: string[]) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wenku8-cli-auth-'));
  directories.push(cwd);
  await writeFile(path.join(cwd, '.wenku8-cookie'), 'synthetic-ignored-secret');
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('../cli.ts', import.meta.url)),
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        APPDATA: cwd,
        XDG_CONFIG_HOME: cwd,
        WENKU8_COOKIE: 'synthetic-ignored-secret',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, output };
}

describe('CLI account authentication', () => {
  it('rejects non-interactive account input without waiting or leaking old cookie values', async () => {
    const result = await run(['login']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('交互终端');
    expect(result.output).not.toContain('synthetic-ignored-secret');
  }, 15_000);

  it('ignores manual cookie sources when deciding whether a command is logged in', async () => {
    const result = await run(['info', '1973']);
    expect(result.code).toBe(1);
    expect(result.output).toContain('尚未登录');
    expect(result.output).toContain('wenku8 login');
  }, 15_000);

  it('rejects removed credential flags without echoing their secret values', async () => {
    for (const args of [
      ['login', '--cookie=synthetic-secret'],
      ['info', '1973', '--cookie-file', 'synthetic-secret-file'],
    ]) {
      const result = await run(args);
      expect(result.code).toBe(1);
      expect(result.output).toContain('不再支持手动 Cookie 参数');
      expect(result.output).not.toContain('synthetic-secret');
    }
  }, 15_000);
});
