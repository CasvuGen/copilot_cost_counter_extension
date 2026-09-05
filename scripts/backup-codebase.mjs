import { access, cp, mkdir, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const projectRoot = process.env.COPILOT_COST_COUNTER_BACKUP_ROOT
  ? path.resolve(process.env.COPILOT_COST_COUNTER_BACKUP_ROOT)
  : path.resolve(new URL('..', import.meta.url).pathname);
const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const backupRoot = path.join(projectRoot, 'versions', packageJson.version, 'codebase');
const excludedDirectories = new Set(['.copilot', '.git', '.vscode', 'dist', 'node_modules', 'packages', 'versions']);

try {
  await access(backupRoot);
  console.log(`Codebase backup already exists: ${backupRoot}`);
  process.exit(0);
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}

await mkdir(path.dirname(backupRoot), { recursive: true });
await mkdir(backupRoot);
for (const entry of await readdir(projectRoot)) {
  if (excludedDirectories.has(entry)) continue;
  await cp(path.join(projectRoot, entry), path.join(backupRoot, entry), { recursive: true });
}

console.log(`Backed up codebase ${packageJson.version} to ${backupRoot}`);