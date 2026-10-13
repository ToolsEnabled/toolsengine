import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createToolsEngine } from '../src/server.js';

test('viewport resize is discoverable, bounded and rejects unreviewed options without launching a browser', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-resize-schema-'));
  const engine = await createToolsEngine({ workspace, headless: true, browserExecutable: '/nonexistent/never-launch' });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  const tool = engine.tools.find(t => t.name === 'browser.resize');
  assert.ok(tool, 'reviewed browser.resize must be offered');
  assert.equal(tool.annotations.readOnlyHint, false);
  const find = JSON.parse((await engine.call('capability.find', { query: 'resize viewport' })).content[0].text);
  assert.ok(find.tools.some(t => t.name === 'browser.resize'));
  const status = JSON.parse((await engine.call('system.status', {})).content[0].text);
  assert.ok(status.tools.includes('browser.resize'));
  for (const args of [{}, { width:390 }, { height:844 }, { width:319,height:844 }, { width:3841,height:844 },
    { width:390,height:239 }, { width:390,height:2161 }, { width:390.5,height:844 }, { width:390,height:844.5 },
    { width:'390',height:844 }, { width:390,height:null }, { width:390,height:844,deviceScaleFactor:2 },
    { width:390,height:844,code:'arbitrary code' }]) {
    const result = await engine.call('browser.resize', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, /Invalid arguments/, JSON.stringify(result));
  }
  for (const name of ['browser.evaluate', 'browser.run_code_unsafe', 'browser.cookies', 'browser.storage_state'])
    assert.equal((await engine.call(name, {})).isError, true);
});
