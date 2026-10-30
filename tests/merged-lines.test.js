import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { parseConfig } from '../src/config.js';
import { createToolsEngine } from '../src/server.js';

// One ToolsEngine carries both lines: browser.show and browser.hide from the
// 0.1.9 line, and --chrome-hidden and --tool-names from the 0.2.0 line.

const empty = { type: 'object', properties: {}, additionalProperties: false };

test('the help text offers the view, hidden Chrome and tool-name options together', () => {
  const help = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  for (const option of ['--private-display', '--browser-view-runtime', '--firefox-hidden', '--chrome-hidden', '--tool-names dotted|underscore'])
    assert.ok(help.stdout.includes(option), option);
});

test('--private-display and --chrome-hidden are refused together', { skip: process.platform !== 'linux' && '--private-display requires Linux' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merged-lines-'));
  try {
    await assert.rejects(parseConfig(['--workspace', root, '--private-display', '--chrome-hidden'], {}), /--chrome-hidden runs Chrome headless with no display to show/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an underscore connection shows and dispatches the view tools and the Chrome transfer', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'merged-lines-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const called = [];
  const tool = name => ({ name, inputSchema: empty, handler: async () => { called.push(name); return { ok: true }; } });
  const engine = await createToolsEngine({ workspace: root, toolNames: 'underscore' }, {
    makeBrowserBridge: async () => ({
      tools: [tool('browser.tabs'), tool('browser.transfer_chrome_session')],
      viewTools: [tool('browser.show'), tool('browser.hide'), tool('browser.visibility')],
      viewState: () => ({ shown: false }),
      close: async () => {},
    }),
  });
  const client = new Client({ name: 'merged-lines-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await engine.server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await engine.close(); });

  const names = (await client.listTools()).tools.map(item => item.name);
  for (const name of ['browser_show', 'browser_hide', 'browser_visibility', 'browser_transfer_chrome_session']) assert.ok(names.includes(name), name);
  assert.ok(!names.some(name => name.includes('.')));
  for (const name of ['browser_show', 'browser_hide', 'browser_transfer_chrome_session'])
    assert.notEqual((await client.callTool({ name, arguments: {} })).isError, true, name);
  assert.deepEqual(called, ['browser.show', 'browser.hide', 'browser.transfer_chrome_session']);
  assert.equal((await client.callTool({ name: 'browser.show', arguments: {} })).isError, true, 'the dotted name is not offered on an underscore connection');

  const status = JSON.parse((await client.callTool({ name: 'system_status', arguments: {} })).content[0].text);
  assert.deepEqual(status.browserView, { shown: false });
  assert.ok(status.tools.includes('browser_show'));
});
