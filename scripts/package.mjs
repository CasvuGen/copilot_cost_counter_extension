import { spawnSync } from 'node:child_process';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(new URL('..', import.meta.url).pathname);
const commentIndex = process.argv.indexOf('--comment');
const comment = commentIndex === -1 ? undefined : process.argv[commentIndex + 1]?.trim();

if (commentIndex !== -1 && !comment) throw new Error('The --comment option requires text.');

function run(command, args) {
  const result = spawnSync(command, args, { cwd: projectRoot, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('npm', ['run', 'backup-codebase']);
run('npm', ['version', 'patch', '--no-git-tag-version']);
run(process.execPath, ['scripts/update-readme-version.mjs']);
run(process.execPath, ['scripts/generate-version-changes.mjs', ...(comment ? ['--comment', comment] : [])]);
run('npm', ['run', 'test']);

await mkdir(path.join(projectRoot, 'packages'), { recursive: true });
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
run(path.join(projectRoot, 'node_modules', '.bin', 'vsce'), ['package', '--allow-missing-repository', '--out', `packages/copilot-cost-counter-${packageJson.version}.vsix`]);