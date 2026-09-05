import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

const runFile = promisify(execFile);
const backupScript = path.resolve('scripts/backup-codebase.mjs');

test('backs up the current codebase before packaging without generated directories', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'copilot-cost-counter-backup-'));
  try {
    await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1.2.3"}\n');
    await writeFile(path.join(projectRoot, 'README.md'), '# Snapshot source\n');
    await mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await writeFile(path.join(projectRoot, 'src', 'extension.ts'), 'export {};\n');
    await mkdir(path.join(projectRoot, 'node_modules', 'dependency'), { recursive: true });
    await writeFile(path.join(projectRoot, 'node_modules', 'dependency', 'generated.js'), 'ignored\n');
    await mkdir(path.join(projectRoot, 'dist'), { recursive: true });
    await writeFile(path.join(projectRoot, 'dist', 'extension.js'), 'ignored\n');

    await runFile(process.execPath, [backupScript], { env: { ...process.env, COPILOT_COST_COUNTER_BACKUP_ROOT: projectRoot } });

    const backupRoot = path.join(projectRoot, 'versions', '1.2.3', 'codebase');
    assert.equal(await readFile(path.join(backupRoot, 'src', 'extension.ts'), 'utf8'), 'export {};\n');
    assert.equal(await readFile(path.join(backupRoot, 'README.md'), 'utf8'), '# Snapshot source\n');
    await assert.rejects(access(path.join(backupRoot, 'node_modules')));
    await assert.rejects(access(path.join(backupRoot, 'dist')));
    await writeFile(path.join(projectRoot, 'README.md'), '# Updated source\n');
    const rerun = await runFile(process.execPath, [backupScript], { env: { ...process.env, COPILOT_COST_COUNTER_BACKUP_ROOT: projectRoot } });
    assert.match(rerun.stdout, /Codebase backup already exists/);
    assert.equal(await readFile(path.join(backupRoot, 'README.md'), 'utf8'), '# Snapshot source\n');
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});