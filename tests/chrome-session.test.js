import test from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseConfig, chromeSessionEnvironment } from '../src/config.js';
import { assertPluginProfile } from '../src/plugin-policy.js';
import { browserCapabilityStatus, serverInstructions } from '../src/server.js';
import { transferOrigins, chromeTransferAllowed, captureChromeSession, readApprovedChromeSession, sessionReceipt, CHROME_TRANSFER_SETTING } from '../src/chrome-session.js';
async function directory(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'te-chrome-config-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
test('hidden Chrome config forces sandboxed headless installed Chrome and a marked profile', async t => {
  const dir = await directory(t);
  const profile = path.join(dir, 'profile');
  const config = await parseConfig(['--workspace', dir, '--chrome-hidden', '--profile-dir', profile]);
  assert.equal(config.chromeHidden, true); assert.equal(config.browserChannel, 'chrome');
  assert.equal(config.headless, true); assert.equal(config.browserSandbox, true);
  assert.match(await fs.readFile(path.join(profile, '.toolsengine-profile'), 'utf8'), /dedicated profile/);
  for (const args of [['--headed'], ['--no-browser-sandbox'], ['--browser-extension'], ['--firefox-hidden'], ['--cdp-endpoint', 'http://127.0.0.1:9222'], ['--browser-channel', 'chrome'], ['--no-browser']])
    await assert.rejects(parseConfig(['--workspace', dir, '--chrome-hidden', '--profile-dir', profile, ...args]), /cannot|requires|headless/);
  assert.throws(() => assertPluginProfile({ pluginProfile: 'openai', browser: false, chromeHidden: true }), /only scoped files and public web/);
});
test('status states the hidden screen boundary without claiming verified authentication', () => {
  const status = browserCapabilityStatus({ chromeHidden: true }, true);
  assert.equal(status.browserUsesVisibleScreen, false); assert.equal(status.headless, true);
  assert.equal(status.browserAuthenticationVerified, false);
  assert.match(serverInstructions({ browser: 'chrome', desktop: false }), /headless Chrome/);
});
test('transfer requires bounded origin scope, and settings disable before source or runtime access', async () => {
  assert.deepEqual(transferOrigins(['https://example.test/', 'https://example.test']), ['https://example.test']);
  for (const origins of [[], ['https://user:password@example.test'], ['file:///tmp/test'], ['https://example.test/path'], ['https://example.test?token=x'], ['https://example.test#x']]) assert.throws(() => transferOrigins(origins));
  assert.equal(chromeTransferAllowed({ [CHROME_TRANSFER_SETTING]: false }), false);
  assert.equal(chromeTransferAllowed({ values: { [CHROME_TRANSFER_SETTING]: 'enabled' } }), true);
  await assert.rejects(readApprovedChromeSession({ workspace: '/does-not-exist', fleetSettings: { [CHROME_TRANSFER_SETTING]: false } }, ['https://example.test']), /No source connection was opened/);
});
test('source capture reads only existing approved pages and returns no state in the public receipt', async () => {
  const origin = 'https://example.test';
  const state = { origin, localStorage: [{name:'auth',value:'synthetic-private-local'}], indexedDB: [], sessionStorage: [{name:'tab',value:'synthetic-private-tab'}] };
  let reads = 0;
  const context = { pages: () => [{url:()=>origin + '/home', evaluate:async()=>{reads++;return state;}}],
    cookies: async () => [{name:'session',value:'synthetic-private-cookie',domain:'example.test',path:'/app',secure:true}, {name:'other',value:'excluded-private-cookie',domain:'other.test',path:'/'}] };
  const captured = await captureChromeSession({contexts:()=>[context]}, [origin]);
  assert.equal(reads, 1);
  const receipt = sessionReceipt(captured);
  assert.equal(receipt.cookies, 1); assert.equal(receipt.sessionStorageEntries, 1);
  assert.equal(receipt.authenticationVerified, false);
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-private|example.test/);
  await assert.rejects(captureChromeSession({contexts:()=>[context]}, ['https://other.test']), /already have a shared, open/);
});

test('source diagnostics never escape worker failures and cancellation terminates its relay', async t => {
  const dir = await directory(t);
  for (const cancelled of [false, true]) {
    const controller = new AbortController();
    let terminated = 0, registry;
    const operation = readApprovedChromeSession({ workspace: dir, fleetSettings: {} }, ['https://example.test'], {
      signal: controller.signal,
      workerFactory: data => {
        registry = data.registry;
        const worker = new EventEmitter();
        worker.stdout = worker.stderr = { resume() {} };
        worker.terminate = async () => { terminated++; };
        queueMicrotask(() => cancelled ? controller.abort() : worker.emit('error', new Error('private-cookie-value')));
        return worker;
      },
    });
    await assert.rejects(operation, error => !error.message.includes('private-cookie-value') && /Chrome/.test(error.message));
    assert.equal(terminated, 1);
    await assert.rejects(fs.lstat(registry), { code: 'ENOENT' });
  }
});

test('Chrome transfer strips inherited protocol and file diagnostics without changing unrelated configuration', () => {
  const env = { DEBUG: 'pw:*', DEBUG_FILE: '/private/log', PWDEBUG: '1', PW_TRACE_DIR: '/private/trace', PLAYWRIGHT_DEBUG_LOG: '1', DISPLAY: ':98', PLAYWRIGHT_MCP_EXTENSION_TOKEN: 'synthetic-token' };
  const quiet = chromeSessionEnvironment(env);
  for (const name of ['DEBUG','DEBUG_FILE','PWDEBUG','PW_TRACE_DIR','PLAYWRIGHT_DEBUG_LOG']) assert.equal(quiet[name], undefined);
  assert.equal(quiet.DISPLAY, ':98');
  assert.equal(quiet.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'synthetic-token');
  assert.equal(env.DEBUG_FILE, '/private/log');
});
