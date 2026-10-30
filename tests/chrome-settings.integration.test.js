import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('standalone MCP rereads shared Fleet settings and refuses Chrome transfer before source connection', { skip: !['linux','win32'].includes(process.platform), timeout: 30000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-chrome-shared-settings-'));
  const workspace = path.join(root, 'workspace');
  const settings = path.join(root, 'services', 'settings.json');
  await fs.mkdir(workspace); await fs.mkdir(path.dirname(settings));
  const write = revision => fs.writeFile(settings, JSON.stringify({ revision, values: { 'browser.agent_chrome_session_transfer': false } }));
  await write(1);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--chrome-hidden', '--profile-dir', path.join(root, 'hidden-profile')],
    cwd: workspace, stderr: 'pipe',
    env: { ...process.env, TOOLSENABLED_SETTINGS: settings },
  });
  let errors = '';
  transport.stderr?.on('data', chunk => { errors += chunk; });
  const client = new Client({ name: 'shared-fleet-settings-fixture', version: '1.0.0' });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const transfer = () => client.callTool({ name: 'browser.transfer_chrome_session', arguments: { origins: ['https://synthetic.invalid'] } });
  const refusal = await transfer();
  assert.equal(refusal.isError, true);
  assert.match(JSON.stringify(refusal.content), /Fleet settings disable Chrome session transfer. No source connection was opened/);
  // Changing the same shared file changes the running child's next read.
  // A malformed control-only fixture fails before source access as well.
  await fs.writeFile(settings, '{"revision":2,"values":');
  const changed = await transfer();
  assert.equal(changed.isError, true);
  assert.doesNotMatch(JSON.stringify(changed.content), /Fleet settings disable Chrome session transfer/);
  await write(3);
  assert.match(JSON.stringify((await transfer()).content), /No source connection was opened/);
  const runtime = path.join(workspace, '.toolsengine-runtime');
  const entries = await fs.readdir(runtime);
  assert.equal(entries.some(name => name.startsWith('chrome-transfer-')), false);
  assert.equal(errors, '');
});
