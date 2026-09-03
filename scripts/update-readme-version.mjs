import { readFile, writeFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const readmeUrl = new URL('../README.md', import.meta.url);
const readme = await readFile(readmeUrl, 'utf8');
const versionLine = `**Version:** ${packageJson.version}`;

if (!/^\*\*Version:\*\* .+$/m.test(readme)) {
  throw new Error('README.md is missing its **Version:** line');
}

await writeFile(readmeUrl, readme.replace(/^\*\*Version:\*\* .+$/m, versionLine), 'utf8');
console.log(`Updated README.md to version ${packageJson.version}`);
