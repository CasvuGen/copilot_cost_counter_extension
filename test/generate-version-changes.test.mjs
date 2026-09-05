import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

const runFile = promisify(execFile);
const changesScript = path.resolve('scripts/generate-version-changes.mjs');

test('writes a commit-backed release summary and records its Git anchor', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'copilot-cost-counter-changes-'));
  try {
    await runFile('git', ['init', '--quiet'], { cwd: projectRoot });
    await runFile('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot });
    await runFile('git', ['config', 'user.name', 'Test User'], { cwd: projectRoot });
    await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1.2.3"}\n');
    await writeFile(path.join(projectRoot, 'README.md'), '# Previous\n');
    await runFile('git', ['add', '.'], { cwd: projectRoot });
    await runFile('git', ['commit', '--quiet', '-m', 'feat: establish the baseline release'], { cwd: projectRoot });
    const previousCommit = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
    await mkdir(path.join(projectRoot, 'versions', '1.2.3'), { recursive: true });
    await writeFile(path.join(projectRoot, 'versions', '1.2.3', 'RELEASE.json'), `${JSON.stringify({ version: '1.2.3', commit: previousCommit })}\n`);
    await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1.2.4"}\n');
    await writeFile(path.join(projectRoot, 'README.md'), '# Current\n');
    await runFile('git', ['add', 'package.json', 'README.md'], { cwd: projectRoot });
    await runFile('git', ['commit', '--quiet', '-m', 'feat: add release summaries'], { cwd: projectRoot });

    await runFile(process.execPath, [changesScript], { env: { ...process.env, COPILOT_COST_COUNTER_CHANGES_ROOT: projectRoot } });

    const changes = await readFile(path.join(projectRoot, 'versions', '1.2.4', 'CHANGES.md'), 'utf8');
    const metadata = JSON.parse(await readFile(path.join(projectRoot, 'versions', '1.2.4', 'RELEASE.json'), 'utf8'));
    assert.match(changes, /Compared with version 1\.2\.3 at commit/);
    assert.match(changes, /feat: add release summaries/);
    assert.equal(metadata.version, '1.2.4');
    assert.equal(metadata.previousVersion, '1.2.3');
    assert.equal(metadata.previousCommit, previousCommit);
    assert.match(metadata.commit, /^[0-9a-f]{40}$/);

    await runFile(process.execPath, [changesScript, '--comment', 'Document the release workflow.'], { env: { ...process.env, COPILOT_COST_COUNTER_CHANGES_ROOT: projectRoot } });
    const overriddenChanges = await readFile(path.join(projectRoot, 'versions', '1.2.4', 'CHANGES.md'), 'utf8');
    assert.match(overriddenChanges, /Document the release workflow\./);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test('recovers the commit that introduced a release created before metadata', async () => {
  const projectRoot = await mkdtemp(path.join(tmpdir(), 'copilot-cost-counter-legacy-release-'));
  try {
    await runFile('git', ['init', '--quiet'], { cwd: projectRoot });
    await runFile('git', ['config', 'user.email', 'test@example.com'], { cwd: projectRoot });
    await runFile('git', ['config', 'user.name', 'Test User'], { cwd: projectRoot });
    await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1.2.3"}\n');
    await runFile('git', ['add', 'package.json'], { cwd: projectRoot });
    await runFile('git', ['commit', '--quiet', '-m', 'chore: release 1.2.3'], { cwd: projectRoot });
    const releaseCommit = (await runFile('git', ['rev-parse', 'HEAD'], { cwd: projectRoot })).stdout.trim();
    await writeFile(path.join(projectRoot, 'README.md'), '# Follow-up\n');
    await runFile('git', ['add', 'README.md'], { cwd: projectRoot });
    await runFile('git', ['commit', '--quiet', '-m', 'docs: follow-up for 1.2.3'], { cwd: projectRoot });
    await mkdir(path.join(projectRoot, 'versions', '1.2.3'), { recursive: true });
    await writeFile(path.join(projectRoot, 'package.json'), '{"version":"1.2.4"}\n');
    await runFile('git', ['add', 'package.json'], { cwd: projectRoot });
    await runFile('git', ['commit', '--quiet', '-m', 'feat: release 1.2.4'], { cwd: projectRoot });

    await runFile(process.execPath, [changesScript], { env: { ...process.env, COPILOT_COST_COUNTER_CHANGES_ROOT: projectRoot } });

    const metadata = JSON.parse(await readFile(path.join(projectRoot, 'versions', '1.2.4', 'RELEASE.json'), 'utf8'));
    assert.equal(metadata.previousCommit, releaseCommit);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});