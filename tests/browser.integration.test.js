import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { browserNeedsShortTemp, workspaceSocketTemp, createBrowserBridge } from '../src/browser.js';
import { serverBrowserSkipped, ownBrowserSkipped } from './support/browser-under-test.js';

async function boundedCleanup(promise, label, timeout = 5000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeout}ms`)), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopFixtureProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve, reject) => {
    child.once('close', resolve);
    child.once('error', reject);
  });
  child.kill();
  try { await boundedCleanup(exited, 'Fixture browser termination'); }
  catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await boundedCleanup(exited, 'Fixture browser forced termination');
  }
}

test('real Chromium navigation, form interaction, snapshot, screenshot and PDF', { timeout: 120000, skip: serverBrowserSkipped }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-live-'));
  const fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>ToolsEngine fixture</title><h1>Portable browser</h1><label>Name <input id="name"></label><button id="save" onclick="document.querySelector(\'#result\').textContent=\'Saved \'+document.querySelector(\'#name\').value">Save</button><p id="result">Waiting</p>');
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  // TOOLSENGINE_TEST_NO_SANDBOX=1 is only for a machine where the browser under
  // test cannot set its sandbox up (see tests/browser-sandbox.integration.test.js).
  const bridge = await createBrowserBridge({ workspace: root, headless: true, browserExecutable: process.env.TOOLSENGINE_TEST_BROWSER,
    browserSandbox: process.env.TOOLSENGINE_TEST_NO_SANDBOX !== '1' });
  t.after(async () => { await bridge.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const call = async (name, args) => {
    const result = await bridge.tools.find(t => t.name === name).handler(args);
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result;
  };
  let result = await call('browser.navigate', { url: `http://127.0.0.1:${fixture.address().port}` });
  assert.match(JSON.stringify(result), /ToolsEngine fixture/);
  result = await call('browser.snapshot', {});
  assert.match(JSON.stringify(result), /Portable browser/);
  await call('browser.type', { target: '#name', text: 'Windows and Linux' });
  await call('browser.click', { target: '#save' });
  result = await call('browser.snapshot', {});
  assert.match(JSON.stringify(result), /Saved Windows and Linux/);
  await call('browser.take_screenshot', { filename: 'proof.png', scale: 'css' });
  await call('browser.pdf_save', { filename: 'proof.pdf' });
  assert.ok((await fs.stat(path.join(root, 'proof.png'))).size > 100);
  assert.ok((await fs.stat(path.join(root, 'proof.pdf'))).size > 100);
  await assert.rejects(bridge.tools.find(t => t.name === 'browser.take_screenshot').handler({ filename: '../outside.png', scale: 'css' }));
  assert.ok(!bridge.tools.some(t => t.name === 'browser.run_code_unsafe'));
  await call('browser.close', {});
  result = await call('browser.navigate', { url: `http://127.0.0.1:${fixture.address().port}` });
  assert.match(JSON.stringify(result), /ToolsEngine fixture/);
});

// When the downloads folder under .toolsengine-runtime is not a plain
// directory, the browser has already been started by the time that is seen.
// The call is refused, and the browser that was started is closed with it:
// it used to stay running, unreferenced, until the server process ended.
test('a browser started before the downloads folder is found tampered with is closed with the refusal', { timeout: 120000, skip: serverBrowserSkipped }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-tampered-')));
  // Playwright makes the temporary profile and artifacts folders in the
  // process's temporary directory. A private one makes them attributable
  // to this test alone, whatever runs beside it.
  const temp = path.join(root, 'process-temp');
  await fs.mkdir(temp);
  const tempVariables = ['TEMP', 'TMP', 'TMPDIR'];
  const savedTemp = Object.fromEntries(tempVariables.map(name => [name, process.env[name]]));
  for (const name of tempVariables) process.env[name] = temp;
  t.after(() => {
    for (const name of tempVariables) {
      if (savedTemp[name] === undefined) delete process.env[name];
      else process.env[name] = savedTemp[name];
    }
  });
  const workspace = path.join(root, 'workspace');
  const elsewhere = path.join(root, 'elsewhere');
  await fs.mkdir(path.join(workspace, '.toolsengine-runtime'), { recursive: true });
  await fs.mkdir(elsewhere);
  await fs.symlink(elsewhere, path.join(workspace, '.toolsengine-runtime', 'downloads'), process.platform === 'win32' ? 'junction' : 'dir');
  const bridge = await createBrowserBridge({ workspace, headless: true, browserExecutable: process.env.TOOLSENGINE_TEST_BROWSER,
    browserSandbox: process.env.TOOLSENGINE_TEST_NO_SANDBOX !== '1' });
  t.after(async () => { await bridge.close(); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const navigate = bridge.tools.find(tool => tool.name === 'browser.navigate');
  const refused = await navigate.handler({ url: 'about:blank' });
  assert.equal(refused.isError, true);
  assert.match(JSON.stringify(refused), /Download directory is not plain\./);

  // The browser that had been started is gone: its temporary profile, which
  // Playwright removes when the browser closes, and the socket directory.
  const leftovers = async () => ({
    profiles: (await fs.readdir(temp)).filter(name => /^playwright_chromiumdev_profile-|^playwright-artifacts-/.test(name)),
    sockets: (await fs.readdir(path.join(workspace, '.toolsengine-runtime', 'tmp')).catch(() => [])).filter(name => name.startsWith('browser-sockets-')),
  });
  let left = await leftovers();
  for (let waited = 0; waited < 10000 && (left.profiles.length || left.sockets.length); waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    left = await leftovers();
  }
  assert.deepEqual(left, { profiles: [], sockets: [] }, 'the browser started before the refusal was left running');

  // With a plain downloads folder the next call starts a browser and works.
  await fs.unlink(path.join(workspace, '.toolsengine-runtime', 'downloads'));
  const opened = await navigate.handler({ url: 'about:blank' });
  assert.notEqual(opened.isError, true, JSON.stringify(opened));
  assert.ok((await leftovers()).profiles.length >= 1, 'the working browser has its temporary profile');
});

test('explicit CDP attachment lists tabs and disconnects without closing the browser', { timeout: 45000, skip: ownBrowserSkipped }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-cdp-'));
  const executable = process.env.TOOLSENGINE_TEST_BROWSER || chromium.executablePath();
  // This fixture is a full Chromium started directly, not through the server.
  // Like an installed Chrome it opens a socket in its temporary directory, so
  // where TMPDIR is long it timed out ("Fixture CDP startup timed out"). It is
  // given a short one in that case, as the server gives its own browser.
  const fixtureSocket = process.platform==='linux' ? await workspaceSocketTemp(root) : null;
  const fixtureTemp=fixtureSocket?.envPath;
  const child = spawn(executable, ['--headless', '--no-sandbox', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${path.join(root, 'test-profile')}`, 'about:blank'],
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...(fixtureTemp ? { env: { ...process.env, TMPDIR: fixtureTemp } } : {}) });
  let bridge;
  let fixtureOwner;
  t.after(async () => {
    const errors = [];
    const attempt = async (label, operation) => {
      try { await operation(); }
      catch (error) { errors.push(new Error(`${label}: ${error.message}`, { cause: error })); }
    };
    await attempt('Bridge cleanup', () => boundedCleanup(bridge?.close(), 'Bridge cleanup'));
    // This test owns the directly spawned browser. A CDP client's close()
    // only disconnects; killing its root on Windows can leave descendants
    // holding stderr open, so the ChildProcess close event never arrives.
    // Ask this fixture's browser to shut down its whole tree first.
    await attempt('Fixture browser shutdown', async () => {
      if (!fixtureOwner?.isConnected()) return;
      const session = await fixtureOwner.newBrowserCDPSession();
      await boundedCleanup(session.send('Browser.close'), 'Fixture browser shutdown');
    });
    await attempt('Fixture owner cleanup', () => boundedCleanup(fixtureOwner?.close(), 'Fixture owner cleanup'));
    await attempt('Fixture process cleanup', () => stopFixtureProcess(child));
    if (fixtureSocket) await attempt('Fixture temporary directory cleanup', () => fixtureSocket.close());
    await attempt('Fixture directory cleanup', () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    if (errors.length) throw new AggregateError(errors, `CDP fixture cleanup failed: ${errors.map(error => error.message).join(' | ')}`);
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Fixture CDP startup timed out')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  fixtureOwner = await chromium.connectOverCDP(endpoint);
  const context = fixtureOwner.contexts()[0];
  const sentinel = await context.newPage();
  await sentinel.setContent('<title>Viewport sentinel</title>');
  const count = context.pages().length;
  const other = context.pages()[0];
  const otherSize = await other.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  bridge = await createBrowserBridge({ workspace: root, cdpEndpoint: endpoint });
  assert.ok(!bridge.tools.some(tool => tool.name === 'browser.close'));
  const tabs = bridge.tools.find(tool => tool.name === 'browser.tabs');
  assert.ok(!tabs.inputSchema.properties.action.enum.includes('close'));
  await assert.rejects(tabs.handler({ action: 'close' }), /not offered/);
  const listed = await tabs.handler({ action: 'list' });
  assert.notEqual(listed.isError, true);
  // CDP clients may receive existing targets in different orders. Select the
  // observed MCP tab identity, never an index inferred from another client.
  const match = listed.content.filter(c => c.type === 'text').map(c => c.text).join('\n').match(/- (\d+):[^\n]*Viewport sentinel/);
  assert.ok(match, JSON.stringify(listed));
  const selected = await tabs.handler({ action: 'select', index: Number(match[1]) });
  const resize = bridge.tools.find(tool => tool.name === 'browser.resize');
  assert.ok(resize);
  assert.notEqual((await resize.handler({ width: 390, height: 844 })).isError, true);
  assert.deepEqual(await sentinel.evaluate(() => ({ width: innerWidth, height: innerHeight })), { width: 390, height: 844 }, JSON.stringify({ selected, pages: await Promise.all(context.pages().map(async page => ({ url: page.url(), size: await page.evaluate(() => ({ width: innerWidth, height: innerHeight })) }))) }));
  assert.deepEqual(await other.evaluate(() => ({ width: innerWidth, height: innerHeight })), otherSize);
  await bridge.close();
  bridge = undefined;
  assert.equal(fixtureOwner.isConnected(), true);
  assert.equal(sentinel.isClosed(), false);
  assert.equal(context.pages().length, count);
});
