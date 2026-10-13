// What the assistant and a reviewer are told about each tool: a title, every
// hint stated, effects described as they are, and catalogues equal to the
// descriptors the server really offers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createToolsEngine } from '../src/server.js';
import { BROWSER_TOOLS, BROWSER_TEXT } from '../src/browser.js';
import { desktopToolDescriptors } from '../src/desktop.js';
import { assertReviewable, assertStatedEffects, HINTS } from '../tools/descriptor-rules.js';

async function offered(t, extra = {}) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-descriptors-'));
  // The browser bridge is built but no browser starts until a browser tool runs.
  const engine = await createToolsEngine({ workspace, headless: true, browserExecutable: '/nonexistent/never-launch', ...extra });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  return JSON.parse(JSON.stringify(engine.tools.map(({ handler, ...tool }) => tool)));
}

test('every core and desktop tool has a readable title and states all four hints', async t => {
  const tools = [...await offered(t), ...desktopToolDescriptors()];
  assert.equal(tools.length, 31);
  for (const tool of tools) assertReviewable(tool);
  assert.equal(new Set(tools.map(tool => tool.title)).size, tools.length, 'titles must tell the tools apart');
});

test('descriptions and hints state the effects a reviewer checks first', async t => {
  const tools = [...await offered(t), ...desktopToolDescriptors()];
  assertStatedEffects(tools);
  const hint = (name, key) => tools.find(tool => tool.name === name).annotations[key];
  // Only tools that change nothing at all are read-only.
  assert.deepEqual(tools.filter(tool => tool.annotations.readOnlyHint).map(tool => tool.name).sort(),
    ['capability.find', 'desktop.capture', 'desktop.inspect', 'system.status', 'web.extract', 'web.fetch', 'workspace.list', 'workspace.read_file', 'workspace.search']);
  // Tools that only add a new file, or change nothing lasting, are not destructive.
  assert.deepEqual(tools.filter(tool => !tool.annotations.readOnlyHint && !tool.annotations.destructiveHint).map(tool => tool.name).sort(),
    ['browser.find', 'browser.hover', 'browser.pdf_save', 'browser.resize', 'browser.snapshot', 'browser.take_screenshot', 'browser.wait_for']);
  // Nothing in the workspace family reaches outside it.
  for (const tool of tools.filter(tool => /^(workspace|system|capability)\./.test(tool.name))) assert.equal(tool.annotations.openWorldHint, false, tool.name);
  assert.equal(hint('workspace.write_file', 'idempotentHint'), false);
});

// The dependency's screenshot schema requires scale and gives it a default;
// the dispatcher filled the default in before checking what is required, so
// the server accepted a call without scale while the published schema told a
// client to send it. The published schema says what the server does.
test('browser.take_screenshot does not require scale, and a call without it is not refused as invalid', async t => {
  const tools = await offered(t);
  const screenshot = tools.find(tool => tool.name === 'browser.take_screenshot');
  assert.equal(screenshot.inputSchema.required, undefined);
  assert.equal(screenshot.inputSchema.properties.scale.default, 'css');
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-descriptors-'));
  const engine = await createToolsEngine({ workspace, headless: true, browserExecutable: '/nonexistent/never-launch' });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  for (const args of [{}, { filename: 'a.png' }, { scale: 'device' }]) {
    const result = await engine.call('browser.take_screenshot', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.doesNotMatch(result.content[0].text, /^Invalid arguments/, JSON.stringify(args));
  }
  assert.match((await engine.call('browser.take_screenshot', { scale: 'huge' })).content[0].text, /^Invalid arguments/);
});

test('every reviewed browser tool has its own text, and nothing else does', () => {
  assert.deepEqual(Object.keys(BROWSER_TEXT).sort(), [...BROWSER_TOOLS].sort());
  for (const [name, text] of Object.entries(BROWSER_TEXT)) {
    assert.ok(text.title && text.does, name);
    assert.deepEqual(Object.keys(text.hints), HINTS, name);
  }
});

test('an attached browser is described as the person\'s own, and closing is neither offered nor described', async t => {
  const tools = await offered(t, { browserExecutable: undefined, cdpEndpoint: 'http://127.0.0.1:9' });
  const browser = tools.filter(tool => tool.name.startsWith('browser.'));
  assert.equal(browser.length, BROWSER_TOOLS.length - 1);
  assert.ok(!browser.some(tool => tool.name === 'browser.close'));
  for (const tool of browser) {
    assertReviewable(tool);
    assert.match(tool.description, /already-running browser chosen at startup.*signed-in sessions/, tool.name);
    assert.doesNotMatch(tool.description, /ToolsEngine's own browser/, tool.name);
  }
  const tabs = browser.find(tool => tool.name === 'browser.tabs');
  assert.deepEqual(tabs.inputSchema.properties.action.enum, ['list', 'new', 'select']);
  assert.match(tabs.description, /Closing tabs is not offered/);
  assert.doesNotMatch(tabs.description, /discards its page/);
});

test('the committed catalogues are exactly what the server offers', async t => {
  const read = async name => JSON.parse(await fs.readFile(new URL(`../docs/${name}`, import.meta.url), 'utf8'));
  const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const core = await read('tool-catalogue.json');
  const desktop = await read('desktop-catalogue.json');
  assert.deepEqual(core.tools, await offered(t), 'docs/tool-catalogue.json is out of step: run node tools/refresh-catalogue.js');
  assert.deepEqual(desktop.tools, JSON.parse(JSON.stringify(desktopToolDescriptors())), 'docs/desktop-catalogue.json is out of step: run node tools/refresh-catalogue.js');
  assert.deepEqual({ core: core.version, desktop: desktop.version, count: core.count }, { core: version, desktop: version, count: core.tools.length });
});
