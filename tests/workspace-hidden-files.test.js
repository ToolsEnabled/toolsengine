// The tool descriptions and the README say how hidden files are treated.
// These tests hold the text to the behaviour: list, read and write handle a
// dot-file like any other file; only search skips hidden folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createToolsEngine } from '../src/server.js';

test('workspace list, read and write treat a hidden file like any other; search skips hidden folders only', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-hidden-')));
  const engine = await createToolsEngine({ workspace, browser: false, headless: true });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const call = async (name, args) => {
    const result = await engine.call(name, args);
    assert.notEqual(result.isError, true, `${name}: ${result.content[0].text}`);
    return JSON.parse(result.content[0].text);
  };
  await fs.writeFile(path.join(workspace, '.env'), 'SAMPLE_SETTING=needle-in-dotfile\n');
  await fs.mkdir(path.join(workspace, '.hidden-folder'));
  await fs.writeFile(path.join(workspace, '.hidden-folder', 'inside.txt'), 'needle-in-hidden-folder\n');
  await fs.writeFile(path.join(workspace, 'plain.txt'), 'needle-in-plain-file\n');

  const listed = await call('workspace.list', {});
  assert.deepEqual(listed.entries.map(entry => entry.name).sort(), ['.env', '.hidden-folder', 'plain.txt']);

  const read = await call('workspace.read_file', { path: '.env' });
  assert.equal(read.content, 'SAMPLE_SETTING=needle-in-dotfile\n');
  assert.equal((await call('workspace.read_file', { path: '.hidden-folder/inside.txt' })).content, 'needle-in-hidden-folder\n');

  const replaced = await call('workspace.write_file', { path: '.env', content: 'SAMPLE_SETTING=replaced\n', expectedSha256: read.sha256 });
  assert.equal(replaced.created, false);
  assert.equal(await fs.readFile(path.join(workspace, '.env'), 'utf8'), 'SAMPLE_SETTING=replaced\n', 'the previous content is gone, as the description says');
  assert.equal((await call('workspace.write_file', { path: '.new-dotfile', content: 'created\n' })).created, true);

  await fs.writeFile(path.join(workspace, '.env'), 'SAMPLE_SETTING=needle-in-dotfile\n');
  const found = await call('workspace.search', { query: 'needle-in' });
  assert.deepEqual(found.matches.map(match => match.path).sort(), ['.env', 'plain.txt'], 'a hidden file in a searched folder is searched; a hidden folder is not');
  assert.equal(found.skipped.hiddenDirectories, 1);
  const refused = await engine.call('workspace.search', { query: 'needle-in', path: '.hidden-folder' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /hidden directory/);

  // Replacing without the current hash, or creating into a folder that does
  // not exist, is refused, as the description says.
  for (const args of [{ path: 'plain.txt', content: 'x' }, { path: 'no-such-folder/new.txt', content: 'x' }])
    assert.equal((await engine.call('workspace.write_file', args)).isError, true, JSON.stringify(args));
});
