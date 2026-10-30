import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Worker } from 'node:worker_threads';
import { chromium } from 'playwright';
import { parseConfig } from '../src/config.js';
import { createBrowserBridge, browserLaunchOptions } from '../src/browser.js';
import { captureChromeSession, readApprovedChromeSession } from '../src/chrome-session.js';

// Opt-in because this is an installed, sandboxed native Chrome qualification.
// All accounts, profiles, cookies and the server are synthetic and task-owned.
test('native hidden Chrome imports an owned signed-in local session without touching source tabs' + (process.env.TOOLSENGINE_CHROME_EXTENSION_FIXTURE ? ' through its approved extension' : ''), { skip: !['linux', 'win32'].includes(process.platform) ? 'Chrome hidden mode requires Linux or native Windows' : process.env.TOOLSENGINE_CHROME_LIVE !== '1' ? 'set TOOLSENGINE_CHROME_LIVE=1 for the owned Chrome fixture' : false, timeout: 120000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-chrome-session-live-'));
  let source, bridge;
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace);
  const secret = 'synthetic-session-fixture';
  const extensionFixture = process.env.TOOLSENGINE_CHROME_EXTENSION_FIXTURE;
  if (extensionFixture) {
    const savedToken = process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN;
    process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = 'synthetic-token-must-not-skip-source-selection';
    t.after(() => { if (savedToken === undefined) delete process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN; else process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = savedToken; });
  }
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/signin') {
      res.setHeader('Set-Cookie', [
        'signed=' + secret + '; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600',
        'pathSigned=' + secret + '; HttpOnly; SameSite=Lax; Path=/app; Max-Age=3600',
      ]);
      res.end('<title>Owned synthetic source</title><h1>Owned synthetic source</h1>');
    } else if (req.url === '/app') {
      const cookieSigned = String(req.headers.cookie).includes('signed=' + secret) && String(req.headers.cookie).includes('pathSigned=' + secret);
      res.end('<h1 id="state">Checking</h1><script>(async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open("auth",1);q.onsuccess=()=>r(q.result);q.onerror=j;});const record=await new Promise((r,j)=>{const q=db.transaction("tokens").objectStore("tokens").get("session");q.onsuccess=()=>r(q.result);q.onerror=j;});db.close();document.querySelector("#state").textContent=' + JSON.stringify(cookieSigned) + '&&localStorage.getItem("auth")===' + JSON.stringify(secret) + '&&record?.token===' + JSON.stringify(secret) + '?(sessionStorage.getItem("tab")===' + JSON.stringify(secret) + '?"Synthetic signed in":"Persistent sign-in retained; tab session ended"):"Authentication missing";})().catch(()=>document.querySelector("#state").textContent="Authentication missing")</script>');
    } else res.end('<h1>Other</h1>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await bridge?.close().catch(() => {});
    await source?.close().catch(() => {});
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const sourceProfile = path.join(root, 'source-profile');
  const fixtureExecutable = extensionFixture && path.join(extensionFixture, process.platform === 'win32' ? 'chrome-win64/chrome.exe' : 'chrome-sandbox-wrapper');
  const extensionPath = extensionFixture && path.join(extensionFixture, 'extension');
  const sourceOptions = extensionFixture ? {
    executablePath: fixtureExecutable, headless: false, chromiumSandbox: true,
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    args: ['--disable-extensions-except=' + extensionPath, '--load-extension=' + extensionPath],
    env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'source-config') },
  } : browserLaunchOptions({ browserChannel: 'chrome', headless: true, browserSandbox: true }, { env: { ...process.env, XDG_CONFIG_HOME: path.join(root, 'source-config') } });
  source = await chromium.launchPersistentContext(sourceProfile, sourceOptions);
  if (extensionFixture && !source.serviceWorkers().length) await source.waitForEvent('serviceworker', { timeout: 15000 });
  const page = source.pages()[0] || await source.newPage();
  await page.goto(origin + '/signin');
  await page.evaluate(async secret => {
    localStorage.setItem('auth', secret); sessionStorage.setItem('tab', secret);
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('auth', 1);
      q.onupgradeneeded = () => q.result.createObjectStore('tokens');
      q.onsuccess = () => resolve(q.result); q.onerror = reject;
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('tokens', 'readwrite');
      tx.objectStore('tokens').put({ token: secret }, 'session');
      tx.oncomplete = resolve; tx.onerror = reject;
    }); db.close();
  }, secret);
  const initialCookies = await source.cookies();
  const initialRequests = requests.length;
  const config = await parseConfig(['--workspace', workspace, '--chrome-hidden', '--profile-dir', path.join(root, 'hidden-profile')]);
  const state = await captureChromeSession({ contexts: () => [source] }, [origin]);
  assert.equal(state.cookies.length, 2, 'path-scoped HttpOnly cookies must also transfer');
  assert.equal(state.origins[0].indexedDB.length, 1);
  assert.equal(requests.length, initialRequests, 'source capture sends no page requests');
  bridge = await createBrowserBridge(config, { readChromeSession: extensionFixture
    ? (config, origins, options) => readApprovedChromeSession(config, origins, { ...options,
      workerFactory: (data, options) => new Worker(new URL('../src/chrome-session-worker.js', import.meta.url), {
        ...options,
        workerData: { ...data, fixtureSource: { executable: fixtureExecutable, profile: sourceProfile } },
        execArgv: ['--import', new URL('./support/chrome-session-worker-fixture.mjs', import.meta.url).href],
        stdout: true, stderr: true,
      }),
    }) : async () => state });
  const call = (name, args = {}) => bridge.tools.find(tool => tool.name === name).handler(args);
  const transfer = call('browser.transfer_chrome_session', { origins: [origin] });
  if (extensionFixture) {
    const selector = await source.waitForEvent('page', { predicate: page => page.url().startsWith('chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html'), timeout: 20000 });
    // Synthetic fixture only: act as its user. Never an owner profile or token.
    await selector.locator('.tab-item', { hasText: 'Owned synthetic source' }).getByRole('button', { name: 'Allow & select' }).click().catch(error => { if (!String(error.message).includes('closed')) throw error; });
  }
  const receipt = await transfer;
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(secret));
  assert.equal(JSON.parse(receipt.content[0].text).hiddenBrowserUsesVisibleScreen, false);
  assert.equal(page.url(), origin + '/signin'); assert.equal(source.pages().length, 1);
  assert.deepEqual(await source.cookies(), initialCookies);
  assert.equal(await page.evaluate(() => localStorage.getItem('auth')), secret);
  const navigate = await call('browser.navigate', { url: origin + '/app' });
  assert.notEqual(navigate.isError, true, JSON.stringify(navigate));
  const signed = await call('browser.wait_for', { text: 'Synthetic signed in' });
  assert.notEqual(signed.isError, true, JSON.stringify(signed));
  assert.match(JSON.stringify(await call('browser.snapshot')), /Synthetic signed in/);
  assert.equal(page.url(), origin + '/signin', 'agent navigation never moves the source page');

  await call('browser.close');
  const restart = await call('browser.navigate', { url: origin + '/app' });
  assert.notEqual(restart.isError, true, JSON.stringify(restart));
  const persisted = await call('browser.wait_for', { text: 'Persistent sign-in retained; tab session ended' });
  assert.notEqual(persisted.isError, true, JSON.stringify(persisted));
  assert.match(JSON.stringify(await call('browser.snapshot')), /Persistent sign-in retained; tab session ended/);
  assert.equal(source.pages().length, 1); assert.equal(page.url(), origin + '/signin');
  await page.evaluate(async () => {
    const db = await new Promise(resolve => { const q = indexedDB.open('auth'); q.onsuccess = () => resolve(q.result); });
    await new Promise(resolve => { const tx = db.transaction('tokens', 'readwrite'); tx.objectStore('tokens').put(new Date(), 'unsupported'); tx.oncomplete = resolve; });
    db.close();
  });
  await assert.rejects(captureChromeSession({ contexts: () => [source] }, [origin]), /Unsupported IndexedDB/);
  assert.match(JSON.stringify(await call('browser.snapshot')), /Persistent sign-in retained/);
  console.log('ASSERT unsupported-source-storage-refused-before-target-mutation=true');
  console.log('ASSERT actual-approved-extension=' + Boolean(extensionFixture));
  console.log('ASSERT native-platform=' + process.platform + ' sandbox-requested=true owned-source=true hidden-target=true');
  console.log('ASSERT cookies=2 localStorage=true indexedDB=true sessionStorage=true source-tabs-unchanged=true');
  console.log('ASSERT persistent-state-survives-restart=true sessionStorage-ends-on-close=true');
});
