import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createToolsEngine, findTools } from '../src/server.js';

// Twelve "browser" tools ahead of the one asked for: the old first-ten-in-
// catalogue-order filter could never return it.
const catalogue = [
  ...Array.from({ length: 12 }, (_, i) => ({ name: `browser.step_${i}`, description: `Browser step ${i} on the page.` })),
  { name: 'browser.close', description: 'Close the whole browser.', annotations: { title: 'Close browser' } },
  { name: 'browser.file_upload', description: 'Give workspace files to the page.', annotations: { title: 'Upload files' } },
  { name: 'workspace.write_file', description: 'Create or replace a file.' },
  { name: 'workspace.read_file', description: 'Read a file.' },
];
const names = query => findTools(catalogue, query).tools.map(tool => tool.name);

test('capability.find puts the tool asked for by name first, however the name is written', () => {
  for (const query of ['browser.close', 'browser_close', 'browser close', 'Browser.Close', '  browser.close  '])
    assert.equal(names(query)[0], 'browser.close', query);
  assert.equal(names('browser_file_upload')[0], 'browser.file_upload');
  assert.equal(names('close the browser')[0], 'browser.close');
});

test('capability.find ranks by name words, then title and description, and ignores filler words', () => {
  assert.equal(names('upload')[0], 'browser.file_upload');
  assert.equal(names('uploads')[0], 'browser.file_upload', 'a plural still finds the tool');
  assert.equal(names('write a file')[0], 'workspace.write_file');
  assert.equal(names('replace')[0], 'workspace.write_file', 'a word only in the description still matches');
  assert.deepEqual(names('the'), [], 'a filler word alone matches nothing here');
  assert.deepEqual(names('to the file').sort(), ['browser.file_upload', 'workspace.read_file', 'workspace.write_file']);
});

test('capability.find returns at most ten tools, says how many matched, and explains an empty answer', () => {
  const broad = findTools(catalogue, 'browser');
  assert.equal(broad.tools.length, 10);
  assert.equal(broad.matched, 14);
  assert.equal(broad.truncated, true);
  assert.equal(broad.note, undefined);
  const narrow = findTools(catalogue, 'workspace');
  assert.deepEqual({ count: narrow.tools.length, matched: narrow.matched, truncated: narrow.truncated }, { count: 3, matched: 3, truncated: false });
  for (const query of ['zzzzqqqq', '   ', '...', 'Écran']) {
    const none = findTools(catalogue, query);
    assert.deepEqual(none.tools, [], query);
    assert.equal(none.matched, 0);
    assert.match(none.note, /system\.status/);
  }
  for (const tool of broad.tools) assert.deepEqual(Object.keys(tool).sort(), ['description', 'name']);
});

test('capability.find through the dispatcher lists only tools this connection offers', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-find-'));
  const engine = await createToolsEngine({ workspace, browser: false, headless: true });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const offered = new Set(engine.tools.map(tool => tool.name));
  assert.ok(![...offered].some(name => name.startsWith('browser.')), 'the browser is disabled in this engine');
  const find = async query => JSON.parse((await engine.call('capability.find', { query })).content[0].text);
  for (const query of ['browser', 'click', 'upload', 'file', 'status', 'find', 'desktop', 'fetch']) {
    for (const tool of (await find(query)).tools) assert.ok(offered.has(tool.name), `${query} returned ${tool.name}, which is not offered`);
  }
  assert.ok(!(await find('click')).tools.some(tool => tool.name === 'browser.click'));
  assert.equal((await find('capability.find')).tools[0].name, 'capability.find');
  assert.equal((await find('workspace.search')).tools[0].name, 'workspace.search');
  for (const args of [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: ['file'] }, { query: 'file', all: true }]) {
    const result = await engine.call('capability.find', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /Invalid arguments/);
  }
});
