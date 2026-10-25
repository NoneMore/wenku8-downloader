import { execFileSync } from 'node:child_process';
import process from 'node:process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const pathsAt = (revision, directory) =>
  git('ls-tree', '-r', '--name-only', '-z', revision, '--', directory).split('\0').filter(Boolean);
const hasContent = (revision, path) => git('show', `${revision}:${path}`).trim().length > 0;

try {
  const [baseRef, headRef, resultRef = headRef] = process.argv.slice(2);
  if (!baseRef || !headRef) {
    throw new Error('Usage: node scripts/check-spec-lifecycle.mjs <base> <head> [result]');
  }
  const [base, head, result] = [baseRef, headRef, resultRef].map((ref) =>
    git('rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim(),
  );
  const basePaths = new Set(pathsAt(base, 'specs'));
  const resultPaths = new Set(pathsAt(result, 'specs'));
  const commits = git('rev-list', '--reverse', '--first-parent', head, '--not', base)
    .trim()
    .split('\n')
    .filter(Boolean);
  const changes = new Set();

  for (const commit of commits) {
    const activePaths = new Set(pathsAt(commit, 'specs/active'));
    for (const path of activePaths) {
      const match = /^specs\/active\/([a-z0-9]+(?:-[a-z0-9]+)*)\/.+/.exec(path);
      if (!match) throw new Error(`Invalid active Change path: ${path}`);
      const name = match[1];
      if (changes.has(name)) continue;
      const spec = `specs/active/${name}/spec.md`;
      if (!activePaths.has(spec) || !hasContent(commit, spec)) {
        throw new Error(`Active Change ${name} needs a non-empty spec.md (${commit}).`);
      }
      if (
        [...basePaths].some(
          (entry) =>
            entry.startsWith(`specs/active/${name}/`) || entry.startsWith(`specs/archive/${name}/`),
        )
      ) {
        throw new Error(`Change ${name} already exists on the base branch; use a new Change name.`);
      }
      changes.add(name);
    }
  }

  if (changes.size === 0) {
    throw new Error('PR history must introduce at least one new specs/active/<change>/spec.md.');
  }
  const remaining = [...resultPaths].filter((path) => path.startsWith('specs/active/'));
  if (remaining.length > 0) {
    throw new Error(`Archive all active Changes before merging:\n${remaining.join('\n')}`);
  }
  for (const name of changes) {
    const archive = `specs/archive/${name}/spec.md`;
    if (!resultPaths.has(archive) || !hasContent(result, archive)) {
      throw new Error(`Change ${name} must have a non-empty ${archive} before merging.`);
    }
  }
  process.stdout.write(`Specification lifecycle passed: ${[...changes].join(', ')}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
