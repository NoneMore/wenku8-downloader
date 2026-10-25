import { spawn } from 'node:child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function context() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wenku8-cli-auth-'));
  directories.push(cwd);
  await writeFile(path.join(cwd, '.wenku8-cookie'), 'synthetic-ignored-secret');
  await writeFile(
    path.join(cwd, 'preload.mjs'),
    `import os from 'node:os'; os.homedir = () => ${JSON.stringify(cwd)}; globalThis.fetch = async () => { throw new Error('Unexpected network request in CLI fixture'); };\n`,
  );
  return cwd;
}

async function runNode(args: string[], cwd: string) {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const child = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--import',
      pathToFileURL(path.join(cwd, 'preload.mjs')).href,
      ...args,
    ],
    {
      cwd,
      env: {
        ...process.env,
        [pathKey]: '',
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

async function run(args: string[], cwd?: string) {
  return runNode(
    [fileURLToPath(new URL('../cli.ts', import.meta.url)), ...args],
    cwd ?? (await context()),
  );
}

describe('CLI account authentication', () => {
  it('reuses a saved authenticated session in a new CLI process and rejects it after logout', async () => {
    const cwd = await context();
    await appendFile(
      path.join(cwd, 'preload.mjs'),
      `
import iconv from ${JSON.stringify(import.meta.resolve('iconv-lite'))};
globalThis.fetch = async (url, init = {}) => {
  const pathname = new URL(url).pathname;
  const signedIn = (new Headers(init.headers).get('cookie') || '').includes('synthetic_session=valid');
  const login = '<form method="post" action="/login.php?do=submit"><input name="username"><input name="password" type="password"></form>';
  let body = login;
  const headers = {};
  if (pathname === '/login.php' && init.method === 'POST') { headers['set-cookie'] = 'synthetic_session=valid; Path=/; Secure; HttpOnly'; body = '登录成功'; }
  else if (pathname === '/userdetail.php' && signedIn) body = '<a href="/logout.php">退出</a>';
  else if (pathname === '/book/1973.htm' && signedIn) body = '<div id="content"><span><b>跨进程认证测试</b></span><div>小说作者：测试作者</div><a href="/novel/1973/index.htm">目录</a><div id="contentmain">测试简介</div></div>';
  else if (pathname !== '/login.php') throw new Error('Unexpected unauthenticated fixture request');
  return new Response(iconv.encode(body, 'gbk'), { headers });
};
`,
    );
    const bootstrap = `import {loginAccount} from ${JSON.stringify(new URL('../auth/login.ts', import.meta.url).href)}; import {SessionStore} from ${JSON.stringify(new URL('../auth/session.ts', import.meta.url).href)}; const session = await loginAccount({username:'synthetic',password:'synthetic-password'}); await new SessionStore().save(session);`;
    expect((await runNode(['--input-type=module', '-e', bootstrap], cwd)).code).toBe(0);
    const info = await run(['info', '1973'], cwd);
    expect(info.code).toBe(0);
    expect(info.output).toContain('跨进程认证测试');
    expect(info.output).not.toContain('synthetic_session');
    expect((await run(['logout'], cwd)).code).toBe(0);
    const loggedOut = await run(['info', '1973'], cwd);
    expect(loggedOut.code).toBe(1);
    expect(loggedOut.output).toContain('尚未登录');
  }, 30_000);
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
