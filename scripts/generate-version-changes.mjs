import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const projectRoot = process.env.COPILOT_COST_COUNTER_CHANGES_ROOT
  ? path.resolve(process.env.COPILOT_COST_COUNTER_CHANGES_ROOT)
  : path.resolve(new URL('..', import.meta.url).pathname);
const commentIndex = process.argv.indexOf('--comment');
const comment = commentIndex === -1 ? undefined : process.argv[commentIndex + 1]?.trim();

if (commentIndex !== -1 && !comment) throw new Error('The --comment option requires text.');

async function git(...args) {
  return (await runFile('git', args, { cwd: projectRoot })).stdout.trim();
}

function compareVersions(left, right) {
  const leftParts = left.split('.').map(Number);
  const rightParts = right.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

async function previousRelease(currentVersion, versionsDirectory) {
  const versions = (await readdir(versionsDirectory, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^\d+\.\d+\.\d+$/.test(entry.name) && compareVersions(entry.name, currentVersion) < 0)
    .map(entry => entry.name)
    .sort(compareVersions);
  const version = versions.at(-1);
  if (!version) throw new Error(`No previous version archive exists for ${currentVersion}.`);

  try {
    const metadata = JSON.parse(await readFile(path.join(versionsDirectory, version, 'RELEASE.json'), 'utf8'));
    if (typeof metadata.commit === 'string' && metadata.commit) return { version, commit: metadata.commit };
  } catch {
    // Releases created before commit metadata are recovered from package history.
  }

  const candidates = (await git('log', '--format=%H', '--', 'package.json')).split('\n').filter(Boolean);
  for (const candidate of candidates) {
    const packageAtCommit = JSON.parse(await git('show', `${candidate}:package.json`));
    if (packageAtCommit.version === version) return { version, commit: candidate };
  }
  throw new Error(`Could not find the Git commit that introduced previous version ${version}.`);
}

const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const currentVersion = packageJson.version;
const versionsDirectory = path.join(projectRoot, 'versions');
const previous = await previousRelease(currentVersion, versionsDirectory);
const currentCommit = await git('rev-parse', 'HEAD');
const commitLines = await git('log', '--reverse', '--format=%h%x09%s', `${previous.commit}..${currentCommit}`);
const commits = commitLines ? commitLines.split('\n').map(line => {
  const [hash, subject] = line.split('\t', 2);
  return { hash, subject };
}) : [];
const summary = comment ? comment : commits.length
  ? commits.map(commit => `- ${commit.subject}`).join('\n')
  : '- No commits were recorded after the previous release commit.';
const releaseDirectory = path.join(versionsDirectory, currentVersion);
const metadataFile = path.join(releaseDirectory, 'RELEASE.json');
const changelogFile = path.join(projectRoot, 'CHANGELOG.md');
const changelogHeader = '# Changelog\n\nRelease summaries are generated from Git commit messages when a version is packaged.\n';
const releaseStart = `<!-- release:${currentVersion}:start -->`;
const releaseEnd = `<!-- release:${currentVersion}:end -->`;
const releaseEntry = `${releaseStart}\n## [${currentVersion}] - ${new Date().toISOString().slice(0, 10)}\n\nCompared with version ${previous.version} at commit \`${previous.commit}\`.\n\n### Summary\n\n${summary}\n\n${commits.length ? `### Commits\n\n${commits.map(commit => `- \`${commit.hash}\` ${commit.subject}`).join('\n')}\n\n` : ''}${releaseEnd}`;
const metadata = {
  schemaId: 1,
  version: currentVersion,
  commit: currentCommit,
  previousVersion: previous.version,
  previousCommit: previous.commit,
  generatedAt: new Date().toISOString()
};

let existingChangelog = changelogHeader;
try {
  existingChangelog = await readFile(changelogFile, 'utf8');
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
}
const entryPattern = new RegExp(`\\n?<!-- release:${currentVersion}:start -->[\\s\\S]*?<!-- release:${currentVersion}:end -->\\n?`, 'g');
const existingEntries = existingChangelog.startsWith(changelogHeader)
  ? existingChangelog.slice(changelogHeader.length).replace(entryPattern, '').trim()
  : existingChangelog.replace(entryPattern, '').trim();
const changelog = `${changelogHeader}\n${releaseEntry}${existingEntries ? `\n\n${existingEntries}` : ''}\n`;

await mkdir(releaseDirectory, { recursive: true });
await writeFile(metadataFile, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
await writeFile(changelogFile, changelog, 'utf8');
console.log(`Generated release summary: ${changelogFile}`);