// Bundles the server into one dependency-free file, dist/index.js. That file is committed: clients
// launch the server straight from GitHub (`npx -y github:...`, the Claude Code plugin, the Gemini
// extension, the .mcpb bundle), and a self-contained file starts fast with nothing to install.
import { readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await rm('dist', { recursive: true, force: true });
await build({
    entryPoints: ['src/index.ts'],
    outfile: 'dist/index.js',
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    legalComments: 'none',
    define: { __VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
    // Some bundled dependencies are CommonJS and call require().
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
