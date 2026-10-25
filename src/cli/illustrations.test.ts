import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stableId } from '../domain/ids.js';
import type { IllustrationInspectionReport } from '../service/illustration-inspection.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function run(root: string, args: string[]) {
  const preload = path.join(root, 'preload.mjs');
  await writeFile(
    preload,
    `import os from 'node:os'; os.homedir = () => ${JSON.stringify(root)}; globalThis.fetch = async () => { throw new Error('Unexpected network'); };`,
  );
  const child = spawn(
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
      cwd: root,
      env: { ...process.env, APPDATA: root, XDG_CONFIG_HOME: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

describe('offline illustrations CLI', () => {
  it('emits one JSON object for complete, partial and fatal results without login or workspace creation', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'wenku8-illustrations-cli-'));
    directories.push(root);
    const work = path.join(root, 'work');
    const fatal = await run(root, ['illustrations', '42', '-w', work, '--json']);
    expect(fatal.code).toBe(1);
    expect(fatal.stderr).toBe('');
    expect((JSON.parse(fatal.stdout) as IllustrationInspectionReport).status).toBe('error');
    expect(await readdir(root)).toEqual(['preload.mjs']);
    const directory = path.join(work, '42');
    await mkdir(path.join(directory, 'raw'), { recursive: true });
    await mkdir(path.join(directory, 'chapters'));
    const chapterUrl = 'https://example.test/1.htm';
    const chapterId = stableId(chapterUrl);
    const manifest = {
      version: 1,
      bookId: 42,
      createdAt: 'test',
      updatedAt: 'test',
      resources: {
        catalogue: {
          key: 'catalogue',
          kind: 'catalogue',
          state: 'complete',
          sourceUrl: 'https://example.test/index.htm',
          updatedAt: 'test',
        },
        [`chapter:${chapterId}`]: {
          key: `chapter:${chapterId}`,
          kind: 'chapter',
          state: 'complete',
          updatedAt: 'test',
        },
      },
    };
    await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(
      path.join(directory, 'raw', 'catalogue.html'),
      '<table><tr><td><a href="1.htm">合成章</a></td></tr></table>',
    );
    const partial = await run(root, [
      'illustrations',
      'https://www.wenku8.net/book/42.htm',
      '-w',
      work,
      '--json',
    ]);
    expect(partial.code).toBe(2);
    expect(partial.stderr).toBe('');
    expect((JSON.parse(partial.stdout) as IllustrationInspectionReport).status).toBe('partial');
    await writeFile(
      path.join(directory, 'chapters', `${chapterId}.json`),
      JSON.stringify({
        id: chapterId,
        index: 0,
        title: '合成章',
        sourceUrl: chapterUrl,
        blocks: [
          { type: 'paragraph', text: '正文不得出现在报告' },
          { type: 'paragraph', text: '（插图001）' },
        ],
      }),
    );
    const before = await readFile(path.join(directory, 'manifest.json'), 'utf8');
    const complete = await run(root, ['illustrations', '42', '-w', work, '--json']);
    expect(complete.code).toBe(0);
    expect(complete.stderr).toBe('');
    const report = JSON.parse(complete.stdout) as IllustrationInspectionReport;
    expect(Object.keys(report).sort()).toEqual(
      [
        'version',
        'bookId',
        'status',
        'counts',
        'chapters',
        'markers',
        'images',
        'diagnostics',
      ].sort(),
    );
    expect(report.status).toBe('complete');
    expect(report.counts.symbolMarkers).toBe(1);
    expect(complete.stdout).not.toContain('正文不得');
    expect(await readFile(path.join(directory, 'manifest.json'), 'utf8')).toBe(before);
    const human = await run(root, ['illustrations', '42', '-w', work]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('complete');
    expect(human.stdout).not.toContain('正文不得');
  }, 30_000);
});
