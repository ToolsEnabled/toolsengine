import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '../src/config.js';
import { createToolsEngine, underscoreToolNames } from '../src/server.js';

// The names Grok admits: letters, digits, underscores and hyphens only.
const GROK_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

async function connect(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-names-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let opened = 0;
  const engine = await createToolsEngine({ workspace: root, ...extra }, {
    makeBrowserBridge: async () => ({
      tools: [{ name: 'browser.tabs', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, handler: async () => { opened++; return { tabs: [] }; } }],
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'tool-names-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await engine.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await engine.close(); });
  return { client, root, opened: () => opened };
}

test('--tool-names accepts dotted or underscore and nothing else', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-names-config-'));
  try {
    assert.equal((await parseConfig(['--workspace', root, '--no-browser', '--tool-names', 'underscore'])).toolNames, 'underscore');
    assert.equal((await parseConfig(['--workspace', root, '--no-browser', '--tool-names', 'dotted'])).toolNames, 'dotted');
    assert.equal((await parseConfig(['--workspace', root, '--no-browser'])).toolNames, undefined);
    await assert.rejects(parseConfig(['--workspace', root, '--no-browser', '--tool-names', 'grok']), /--tool-names must be dotted or underscore/);
    await assert.rejects(parseConfig(['--workspace', root, '--no-browser', '--tool-names']), /--tool-names requires a value/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('default connections keep the real dotted names', async t => {
  const { client } = await connect(t);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.includes('workspace.read_file'));
  assert.ok(names.includes('browser.tabs'));
  const status = JSON.parse((await client.callTool({ name: 'system.status', arguments: {} })).content[0].text);
  assert.ok(status.tools.includes('system.status'));
  assert.equal((await client.callTool({ name: 'system_status', arguments: {} })).isError, true, 'an unadvertised underscore name is not offered');
});

test('underscore connections show only admissible names and dispatch to the real tool', async t => {
  const { client, root, opened } = await connect(t, { toolNames: 'underscore' });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  assert.ok(names.length > 5);
  for (const name of names) assert.match(name, GROK_TOOL_NAME, name);
  assert.ok(names.includes('workspace_write_file') && names.includes('browser_tabs'));

  const written = await client.callTool({ name: 'workspace_write_file', arguments: { path: 'note.txt', content: 'hello' } });
  assert.notEqual(written.isError, true, JSON.stringify(written));
  assert.equal(await fs.readFile(path.join(root, 'note.txt'), 'utf8'), 'hello');
  assert.notEqual((await client.callTool({ name: 'browser_tabs', arguments: {} })).isError, true);
  assert.equal(opened(), 1);

  const status = JSON.parse((await client.callTool({ name: 'system_status', arguments: {} })).content[0].text);
  assert.deepEqual(status.tools, [...names].sort());
  const found = JSON.parse((await client.callTool({ name: 'capability_find', arguments: { query: 'write a file' } })).content[0].text);
  assert.equal(found.tools[0].name, 'workspace_write_file');

  const dotted = await client.callTool({ name: 'workspace.write_file', arguments: { path: 'other.txt', content: 'x' } });
  assert.equal(dotted.isError, true, 'only advertised names are accepted on an underscore connection');
  assert.match(dotted.content[0].text, /Tool is not offered: workspace\.write_file/);
  await assert.rejects(fs.stat(path.join(root, 'other.txt')), /ENOENT/);
});

test('two tools that would share a shown name are refused rather than guessed', () => {
  assert.throws(() => underscoreToolNames(['browser.tabs', 'browser_tabs']), /refusing to guess/);
  assert.deepEqual([...underscoreToolNames(['a.b', 'c']).entries()], [['a_b', 'a.b'], ['c', 'c']]);
});
