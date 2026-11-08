// Packs the Claude Desktop extension (.mcpb) from the committed bundle: release/apify-insights-<version>.mcpb.
// Run `npm run build` first. The manifest's version is taken from package.json.
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const stage = '.mcpb-build';
await rm(stage, { recursive: true, force: true });
await mkdir(`${stage}/server`, { recursive: true });
const manifest = JSON.parse(await readFile('mcpb/manifest.json', 'utf8'));
await writeFile(`${stage}/manifest.json`, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
await copyFile('dist/index.js', `${stage}/server/index.js`);
await copyFile('LICENSE', `${stage}/LICENSE`);
await mkdir('release', { recursive: true });
const out = `release/apify-insights-${version}.mcpb`;
execFileSync('npx', ['-y', '@anthropic-ai/mcpb@2.1.2', 'pack', stage, out], { stdio: 'inherit' });
await rm(stage, { recursive: true, force: true });
console.log(out);
