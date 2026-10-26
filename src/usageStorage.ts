import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export async function ensureWorkspaceUsageDirectory(workspacePath: string): Promise<void> {
  await fs.mkdir(path.join(workspacePath, '.copilot'), { recursive: true });
}
