import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const checker = fileURLToPath(new URL('./check-spec-lifecycle.mjs', import.meta.url));

function repository(t) {
  const directory = mkdtempSync(join(tmpdir(), 'wenku8-spec-lifecycle-'));
  t.after(() => {
    assert.equal(dirname(directory), tmpdir());
    rmSync(directory, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Lifecycle test',
        GIT_AUTHOR_EMAIL: 'lifecycle@example.invalid',
        GIT_COMMITTER_NAME: 'Lifecycle test',
        GIT_COMMITTER_EMAIL: 'lifecycle@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  const write = (path, content = '# Specification\n') => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  };
  const commit = () => {
    git('add', '.');
    git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'test');
    return git('rev-parse', 'HEAD');
  };
  const move = (from, to) => {
    mkdirSync(dirname(join(directory, to)), { recursive: true });
    renameSync(join(directory, from), join(directory, to));
  };
  const check = (base, head, result = head) => {
    const run = spawnSync(process.execPath, [checker, base, head, result], {
      cwd: directory,
      encoding: 'utf8',
    });
    if (run.error) throw run.error;
    return { status: run.status, output: run.stdout + run.stderr };
  };
  git('init', '--quiet');
  return { git, write, commit, move, check };
}

test('accepts multiple Changes in one PR and leaves deferred specifications planned', (t) => {
  const repo = repository(t);
  repo.write('specs/planned/first/spec.md');
  const base = repo.commit();
  repo.move('specs/planned/first', 'specs/active/first');
  repo.write('specs/active/second/spec.md');
  repo.write('specs/planned/later/spec.md');
  repo.commit();
  repo.move('specs/active/first', 'specs/archive/first');
  repo.move('specs/active/second', 'specs/archive/second');
  const run = repo.check(base, repo.commit());
  assert.equal(run.status, 0, run.output);
});

for (const state of ['none', 'planned', 'archive']) {
  test(`rejects a PR with only ${state} specifications`, (t) => {
    const repo = repository(t);
    const base = repo.commit();
    repo.write(state === 'none' ? 'README.md' : `specs/${state}/change/spec.md`);
    const run = repo.check(base, repo.commit());
    assert.equal(run.status, 1);
    assert.match(run.output, /at least one new/);
  });
}

for (const outcome of ['active', 'deleted', 'planned', 'empty-archive', 'renamed-archive']) {
  test(`rejects an activated Change that ends as ${outcome}`, (t) => {
    const repo = repository(t);
    const base = repo.commit();
    repo.write('specs/active/change/spec.md');
    repo.commit();
    if (outcome === 'deleted') repo.git('rm', 'specs/active/change/spec.md');
    if (outcome === 'planned') repo.move('specs/active/change', 'specs/planned/change');
    if (outcome === 'empty-archive') {
      repo.move('specs/active/change', 'specs/archive/change');
      repo.write('specs/archive/change/spec.md', ' \n');
    }
    if (outcome === 'renamed-archive') {
      repo.move('specs/active/change', 'specs/archive/other');
    }
    const run = repo.check(base, repo.commit());
    assert.equal(run.status, 1);
    assert.match(run.output, /before merging/);
  });
}

for (const state of ['active', 'archive']) {
  test(`rejects reuse of a Change already ${state} on the base branch`, (t) => {
    const repo = repository(t);
    repo.write(`specs/${state}/change/spec.md`);
    const base = repo.commit();
    repo.write('specs/active/change/spec.md', '# Reused\n');
    const run = repo.check(base, repo.commit());
    assert.equal(run.status, 1);
    assert.match(run.output, /already exists on the base/);
  });
}

test('requires a non-empty spec.md for each activated Change', (t) => {
  const repo = repository(t);
  const base = repo.commit();
  repo.write('specs/active/change/spec.md', ' \n');
  const run = repo.check(base, repo.commit());
  assert.equal(run.status, 1);
  assert.match(run.output, /needs a non-empty spec.md/);
});

test('checks the merge result as well as PR history', (t) => {
  const repo = repository(t);
  const base = repo.commit();
  repo.write('specs/active/change/spec.md');
  repo.commit();
  repo.move('specs/active/change', 'specs/archive/change');
  const head = repo.commit();
  repo.write('specs/active/remaining/tasks.md');
  const run = repo.check(base, head, repo.commit());
  assert.equal(run.status, 1);
  assert.match(run.output, /Archive all active Changes/);
});

test('does not count active specifications inherited from an updated base branch', (t) => {
  const repo = repository(t);
  repo.commit();
  repo.write('specs/active/earlier/spec.md');
  repo.commit();
  repo.move('specs/active/earlier', 'specs/archive/earlier');
  const base = repo.commit();
  repo.write('README.md');
  const run = repo.check(base, repo.commit());
  assert.equal(run.status, 1);
  assert.match(run.output, /at least one new/);
});
