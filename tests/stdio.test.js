import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('real stdio handshake, curated list, schema guards and file round trip', { timeout: 30000 }, async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-stdio-'));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace],
    cwd: workspace, stderr: 'pipe',
    env: { ...process.env, TEMP: os.tmpdir(), TMP: os.tmpdir() },
  });
  let errors = '';
  transport.stderr?.on('data', chunk => { errors += chunk; });
  const client = new Client({ name: 'toolsengine-acceptance', version: '1.0.0' });
  t.after(async () => { await client.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  await client.connect(transport);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 27);
  assert.equal(new Set(tools.map(t => t.name)).size, 27);
  const names = tools.map(t => t.name);
  assert.ok(names.includes('browser.snapshot'));
  assert.ok(names.includes('workspace.write_file'));
  assert.ok(!names.some(n => /agent\.|secret|account|shell|eval|run_code|settings|ledger/.test(n)));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const status = await call('system.status');
  assert.equal(JSON.parse(status.content[0].text).platform, process.platform);
  assert.equal((await call('browser.run_code_unsafe', { code: 'return process.env' })).isError, true);
  assert.equal((await call('system.status', { extra: true })).isError, true);
  assert.equal((await call('web.fetch', { url: 'https://example.com', allowLocalNetwork: true })).isError, true);
  assert.equal((await call('workspace.write_file', { path: 'hello.txt', content: 'MCP works' })).isError, undefined);
  const read = JSON.parse((await call('workspace.read_file', { path: 'hello.txt' })).content[0].text);
  assert.equal(read.content, 'MCP works');
  assert.equal((await call('workspace.read_file', { path: '../outside.txt' })).isError, true);
  assert.equal(errors, '');
});
