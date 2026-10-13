// The browser that ToolsEngine starts runs with Chromium's sandbox on.
//
// The sandbox is what keeps a web page that breaks out of the page from acting
// as the person's account. The browser dependency starts Chromium with
// --no-sandbox unless it is asked not to, so until this was fixed every
// browser ToolsEngine started, the person's installed Chrome included, ran
// unconfined. Where the sandbox cannot be set up the browser must not start
// without it: the tool fails with a plain message, and only the explicit
// startup option --no-browser-sandbox switches the sandbox off.
//
// The live tests start the real server over stdio, open a blank page and read
// the command lines of the browser processes that belong to their own
// throwaway workspace. No site is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as browserModule from '../src/browser.js';
import { parseConfig } from '../src/config.js';

const windows = process.platform === 'win32';
const firstExisting = files => files.find(file => file && existsSync(file));
const installedChannel = process.env.TOOLSENGINE_TEST_CHANNEL
  || (windows
    ? (firstExisting([`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`]) ? 'chrome'
      : firstExisting([`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`]) ? 'msedge' : null)
    : existsSync('/opt/google/chrome/chrome') ? 'chrome' : existsSync('/opt/microsoft/msedge/msedge') ? 'msedge' : null);

test('the sandbox is on in the options the browser is started with, unless it was switched off at startup', async () => {
  const { browserLaunchOptions } = browserModule;
  assert.equal(typeof browserLaunchOptions, 'function', 'src/browser.js must build the launch options in one place');
  assert.deepEqual(browserLaunchOptions({ headless: true }), { headless: true, chromiumSandbox: true });
  assert.deepEqual(browserLaunchOptions({ headless: false, browserChannel: 'chrome' }), { headless: false, chromiumSandbox: true, executablePath: (await import('../src/config.js')).channelExecutable('chrome') });
  assert.deepEqual(browserLaunchOptions({ browserExecutable: '/opt/x/browser', browserSandbox: true }), { headless: true, chromiumSandbox: true, executablePath: '/opt/x/browser' });
  assert.equal(browserLaunchOptions({ browserSandbox: false }).chromiumSandbox, false);
  // Nothing but the exact value false switches it off.
  for (const value of [undefined, null, 0, '', 'false', 'off']) assert.equal(browserLaunchOptions({ browserSandbox: value }).chromiumSandbox, true, String(value));
});

test('only --no-browser-sandbox switches the sandbox off, and only for a browser the server starts itself', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-sandbox-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  assert.equal((await parseConfig(['--workspace', workspace])).browserSandbox, true);
  assert.equal((await parseConfig(['--workspace', workspace, '--browser-channel', 'chrome', '--headed'])).browserSandbox, true);
  assert.equal((await parseConfig(['--workspace', workspace, '--no-browser-sandbox'])).browserSandbox, false);
  await assert.rejects(parseConfig(['--workspace', workspace, '--no-browser', '--no-browser-sandbox']), /--no-browser-sandbox/);
  await assert.rejects(parseConfig(['--workspace', workspace, '--cdp-endpoint', 'http://127.0.0.1:9222', '--no-browser-sandbox']), /--no-browser-sandbox/);
  await assert.rejects(parseConfig(['--workspace', workspace, '--no-sandbox']), /Unknown option/);
});

test('a browser that cannot set its sandbox up is reported in plain words: which browser, what the person can do, and whose decision the unsafe option is', () => {
  const { explainLaunchFailure } = browserModule;
  assert.equal(typeof explainLaunchFailure, 'function');
  const fromDependency = new Error(['browserType.launch: Chromium sandboxing failed!', '================================', 'To avoid the sandboxing issue, do either of the following:',
    "  - (alternative): Launch Chromium without sandbox using 'chromiumSandbox: false' option", '================================', 'Browser logs:', '<launching> /home/a/.cache/ms-playwright/chromium-1247/chrome-linux/chrome --disable-field-trial-config',
    '[pid=1][err] [1:1:FATAL:zygote_host_impl_linux.cc(128)] No usable sandbox! If you are running on Ubuntu 23.10+ ... you can try using --no-sandbox.'].join('\n'));
  const explain = (config, root = false) => explainLaunchFailure(fromDependency, config, { root }).message;
  const plain = explain({});
  assert.notEqual(explainLaunchFailure(fromDependency, {}, { root: false }), fromDependency);
  assert.match(plain, /^The browser did not start, because its sandbox could not be set up\./);
  assert.match(plain, /keeps a web page from acting as the person's account/);
  // Plain means: no log lines, no command line, nothing about the dependency's own option.
  assert.doesNotMatch(plain, /<launching>|\[pid=|chromiumSandbox|FATAL|=====/);

  // The message is the whole result of a browser tool, so its reader is the
  // assistant, which in some clients can change how this server is started.
  // The option that switches the sandbox off is named with what it costs, as
  // the person's decision, and the assistant is told not to act on it.
  for (const config of [{}, { browserChannel: 'chrome' }, { browserExecutable: '/opt/x/browser' }]) for (const root of [false, true]) {
    const text = explain(config, root);
    assert.match(text, /--no-browser-sandbox/, JSON.stringify(config));
    assert.match(text, /can then read and change whatever the person's account can/, JSON.stringify(config));
    assert.match(text, /For the assistant reading this: whether to switch the sandbox off is the person's decision\. Tell them what this message says, and do not change ToolsEngine's configuration or registration yourself\.$/, JSON.stringify(config));
    assert.doesNotMatch(text, /or start ToolsEngine with --no-browser-sandbox/, 'the unsafe option must not stand among the things to do');
    assert.ok(text.length < 1500, `too long: ${text.length}`);
  }

  // The browser that failed is named, and the advice fits that browser. An
  // installed Chrome that fails is not blamed on Playwright's Chromium, and
  // is not told to use an installed Chrome.
  assert.match(plain, /The browser that failed is the Chromium that Playwright downloads/);
  assert.match(plain, /Ubuntu 23\.10 and later/);
  assert.match(plain, /use an installed Google Chrome or Microsoft Edge[^.]*--browser-channel chrome/);
  const chrome = explain({ browserChannel: 'chrome' });
  assert.match(chrome, /The browser that failed is the installed Google Chrome\./);
  assert.doesNotMatch(chrome, /Playwright|Ubuntu|use an installed|--browser-channel/);
  assert.match(chrome, /repair or reinstall that browser/);
  assert.match(explain({ browserChannel: 'msedge' }), /The browser that failed is the installed Microsoft Edge\./);
  const named = explain({ browserExecutable: '/opt/x/browser' });
  assert.match(named, /The browser that failed is the browser at \/opt\/x\/browser\./);
  assert.doesNotMatch(named, /Playwright downloads|Ubuntu/);
  assert.match(named, /use an installed Google Chrome or Microsoft Edge instead/);

  // Root is known from the account the server runs as. The browser's own line
  // about root never arrives: the library replaces that log with its own text.
  const asRoot = explain({ browserChannel: 'chrome' }, true);
  assert.match(asRoot, /ToolsEngine is running as the root account, and Chromium has no sandbox for root\./);
  assert.match(asRoot, /run ToolsEngine as an ordinary user/);
  assert.doesNotMatch(explain({ browserChannel: 'chrome' }, false), /root/);

  // Anything else is passed on unchanged, and so is a failure with the sandbox already off.
  const other = new Error("browserType.launch: Executable doesn't exist at /x/chrome");
  assert.equal(explainLaunchFailure(other, {}), other);
  assert.equal(explainLaunchFailure(fromDependency, { browserSandbox: false }), fromDependency);
});

// The command lines of the browser processes started for one workspace. The
// workspace path is part of the profile directory each of them is given: the
// temporary profile lies under .toolsengine-runtime, and a dedicated profile
// is named by its own folder.
function browserCommandLines(workspace, marker = path.join(workspace, '.toolsengine-runtime')) {
  if (!windows) {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(pid => {
      try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '); } catch { return ''; }
    }).filter(line => line.includes(marker));
  }
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe' OR Name='msedge.exe' OR Name='chrome-headless-shell.exe'" | ForEach-Object { $_.CommandLine }`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.split(/\r?\n/).filter(line => line.toLowerCase().includes(marker.toLowerCase()));
}

async function startServer(t, extraArgs) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-sandbox-')));
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--headless', ...extraArgs],
    cwd: workspace, stderr: 'pipe' });
  const client = new Client({ name: 'toolsengine-sandbox', version: '1.0.0' });
  // The server is stopped before its folders are removed: on Windows a
  // running browser holds its files.
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await client.close().catch(() => {}); } };
  t.after(async () => { await stop(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await client.connect(transport);
  const text = result => (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
  const call = async (name, args = {}) => { const result = await client.callTool({ name, arguments: args }); return { isError: result.isError === true, text: text(result) }; };
  return { workspace, call, stop };
}

test('an installed Chrome or Edge is started sandboxed; --no-browser-sandbox is the one way to start it without',
  { skip: installedChannel ? false : 'needs an installed Chrome or Edge, or TOOLSENGINE_TEST_CHANNEL', timeout: 180000 }, async t => {
    const sandboxed = await startServer(t, ['--browser-channel', installedChannel]);
    assert.equal(JSON.parse((await sandboxed.call('system.status')).text).browserSandbox, true);
    const opened = await sandboxed.call('browser.navigate', { url: 'about:blank' });
    assert.equal(opened.isError, false, `the installed ${installedChannel} did not start with its sandbox: ${opened.text.slice(0, 600)}`);
    let lines = browserCommandLines(sandboxed.workspace);
    assert.ok(lines.length > 0, 'no browser process of this workspace was found');
    assert.deepEqual(lines.filter(line => /--no-sandbox\b/.test(line)), [], 'a browser process was started with --no-sandbox');
    await sandboxed.call('browser.close');

    const unconfined = await startServer(t, ['--browser-channel', installedChannel, '--no-browser-sandbox']);
    assert.equal(JSON.parse((await unconfined.call('system.status')).text).browserSandbox, false);
    assert.equal((await unconfined.call('browser.navigate', { url: 'about:blank' })).isError, false);
    lines = browserCommandLines(unconfined.workspace);
    assert.ok(lines.some(line => /--no-sandbox\b/.test(line)), 'the option did not reach the browser');
    await unconfined.call('browser.close');
  });

// The dedicated profile is started by another call of the browser library
// than the temporary one (launchPersistentContext, not launch). That the
// sandbox option reaches it was covered only by a test of the options; this
// one reads the command line of the browser process that holds the profile.
test('a browser with a dedicated profile (--profile-dir) is started sandboxed as well, and only --no-browser-sandbox starts it without',
  { skip: installedChannel ? false : 'needs an installed Chrome or Edge, or TOOLSENGINE_TEST_CHANNEL', timeout: 240000 }, async t => {
    const profiles = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-sandbox-profile-')));
    const start = async (name, extraArgs) => {
      const profile = path.join(profiles, name);
      const server = await startServer(t, ['--browser-channel', installedChannel, '--profile-dir', profile, ...extraArgs]);
      return { ...server, profile };
    };
    // The servers are stopped before the profile folders are removed: a
    // running browser holds the files of its profile.
    let sandboxed, unconfined;
    try {
      sandboxed = await start('sandboxed', []);
      const status = JSON.parse((await sandboxed.call('system.status')).text);
      assert.equal(status.browserSession, 'dedicated-persistent-profile');
      assert.equal(status.browserSandbox, true);
      const opened = await sandboxed.call('browser.navigate', { url: 'about:blank' });
      assert.equal(opened.isError, false, `the installed ${installedChannel} did not start with its dedicated profile: ${opened.text.slice(0, 600)}`);
      let lines = browserCommandLines(sandboxed.workspace, sandboxed.profile);
      assert.ok(lines.length > 0, 'no browser process with this profile was found');
      assert.ok(lines.some(line => line.toLowerCase().includes(`--user-data-dir=${sandboxed.profile}`.toLowerCase())), 'the browser was not started with the dedicated profile');
      assert.deepEqual(lines.filter(line => /--no-sandbox\b/.test(line)), [], 'a browser process with the dedicated profile was started with --no-sandbox');
      await sandboxed.call('browser.close');

      unconfined = await start('unconfined', ['--no-browser-sandbox']);
      assert.equal(JSON.parse((await unconfined.call('system.status')).text).browserSandbox, false);
      assert.equal((await unconfined.call('browser.navigate', { url: 'about:blank' })).isError, false);
      lines = browserCommandLines(unconfined.workspace, unconfined.profile);
      assert.ok(lines.some(line => /--no-sandbox\b/.test(line)), 'the option did not reach the browser with the dedicated profile');
      await unconfined.call('browser.close');
    } finally {
      await sandboxed?.stop();
      await unconfined?.stop();
      await fs.rm(profiles, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

test('the Chromium that Playwright downloads either starts sandboxed or fails with the plain message, never unconfined',
  { skip: process.env.TOOLSENGINE_TEST_BROWSER ? 'TOOLSENGINE_TEST_BROWSER names another browser' : false, timeout: 180000 }, async t => {
    const server = await startServer(t, []);
    const opened = await server.call('browser.navigate', { url: 'about:blank' });
    if (/Executable doesn't exist/.test(opened.text)) return t.skip('the Chromium build this version is pinned to is not on this machine');
    const lines = browserCommandLines(server.workspace);
    if (!opened.isError) {
      assert.ok(lines.length > 0, 'no browser process of this workspace was found');
      assert.deepEqual(lines.filter(line => /--no-sandbox\b/.test(line)), [], 'a browser process was started with --no-sandbox');
      t.diagnostic('on this machine the downloaded Chromium starts with its sandbox');
      return;
    }
    assert.match(opened.text, /^The browser did not start, because its sandbox could not be set up\./, opened.text.slice(0, 400));
    assert.match(opened.text, /--no-browser-sandbox/);
    assert.doesNotMatch(opened.text, /<launching>|\[pid=|###/);
    assert.deepEqual(lines, [], 'a browser of this workspace is running although the start was refused');
    t.diagnostic('on this machine the downloaded Chromium cannot set its sandbox up; the tool refuses in plain words');
    // The same again on the next call: the refusal is not a one-off.
    const again = await server.call('browser.snapshot');
    assert.equal(again.isError, true);
    assert.match(again.text, /^The browser did not start, because its sandbox could not be set up\./);
  });
