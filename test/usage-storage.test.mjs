import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensureWorkspaceUsageDirectory } from '../dist/usageStorage.js';

test('creates the workspace .copilot directory before the first usage record', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'copilot-cost-counter-'));
  try {
    const usageDirectory = path.join(workspace, '.copilot');
    await assert.rejects(stat(usageDirectory), { code: 'ENOENT' });

    await ensureWorkspaceUsageDirectory(workspace);

    assert.equal((await stat(usageDirectory)).isDirectory(), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
