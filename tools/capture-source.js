import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const [repo, output] = process.argv.slice(2);
if (!repo || !output) throw new Error('Usage: node capture-source.js ISOLATED_GIT_REPO REFERENCE_DIR');
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { maxBuffer: 8 * 1024 * 1024 });
fs.mkdirSync(output, { recursive: true });
const registry = git('show', 'origin/main:src/lib/tool-registry.js');
fs.writeFileSync(path.join(output, 'public-tool-registry.js'), registry);
const ids = [...registry.toString('utf8').matchAll(/\bdefine\('([^']+)'/g)].map(m => m[1]).sort();
const metadata = {
  repo: 'https://github.com/ToolsEnabled/toolsenabled-engine',
  main: git('rev-parse', 'origin/main').toString().trim(),
  tree: git('rev-parse', 'origin/main^{tree}').toString().trim(),
  mainDate: git('log', '-1', '--format=%cI', 'origin/main').toString().trim(),
  releaseTag: 'v1.0.48', releaseCommit: git('rev-parse', 'v1.0.48^{commit}').toString().trim(),
  registrySha256: createHash('sha256').update(registry).digest('hex'),
  declaredCoreToolCount: ids.length,
  ids,
};
fs.writeFileSync(path.join(output, 'public-source.json'), JSON.stringify(metadata, null, 2) + '\n');
fs.writeFileSync(new URL('../LICENSE', import.meta.url), git('show', 'origin/main:LICENSE'));
console.log(JSON.stringify({ ...metadata, ids: undefined }));
