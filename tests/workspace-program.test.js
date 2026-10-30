import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PROGRAM_FOLDER, parseConfig } from '../src/config.js';
import { createWorkspaceTools } from '../src/workspace.js';

test('workspace above installed runtime remains useful and cannot expose or change runtime files', async t => {
  const program = await realpath(PROGRAM_FOLDER), workspace = path.dirname(program);
  const cfg = await parseConfig(['--workspace', workspace, '--no-browser']);
  const tools = Object.fromEntries(createWorkspaceTools(cfg).map(tool => [tool.name, tool]));
  const fixture = await mkdtemp(path.join(workspace, 'zuse-parent-check-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const rel = p => path.relative(workspace, p).split(path.sep).join('/');
  const file = path.join(fixture, 'example.txt');
  await tools['workspace.write_file'].handler({ path: rel(file), content: 'user-owned example' });
  assert.equal(await readFile(file, 'utf8'), 'user-owned example');
  const result = await tools['workspace.read_file'].handler({ path: rel(file) });
  assert.match(JSON.stringify(result), /user-owned example/);
  const packagePath = path.join(program, 'package.json'), before = await readFile(packagePath);
  for (const [name, args] of [
    ['workspace.read_file', { path: rel(packagePath) }],
    ['workspace.write_file', { path: rel(packagePath), content: 'must never write' }],
    ['workspace.write_file', { path: rel(path.join(program, 'zuse-must-not-create.txt')), content: 'must never write' }],
    ['workspace.list', { path: rel(program) }],
    ['workspace.search', { path: rel(program), query: 'ToolsEngine' }],
  ]) await assert.rejects(tools[name].handler(args), error => error.code === 'PROGRAM_FOLDER', name);
  assert.deepEqual(await readFile(packagePath), before);
  const listed = await tools['workspace.list'].handler({ path: '.' });
  assert.ok(!listed.entries.some(entry => entry.name === path.basename(program)));
  assert.ok(listed.skippedProgramFolders >= 1);
  const searched = await tools['workspace.search'].handler({ path: '.', query: 'user-owned example', maxFiles: 1000 });
  assert.ok(!JSON.stringify(searched.matches).includes(rel(packagePath)));
  assert.ok(searched.skipped.programFolders >= 1);
});
