// An installed Chrome or Edge must start whatever the length of the workspace
// path.
//
// The CLI points the temporary directory into the workspace. Outside Windows,
// an installed Chrome or Edge opens a Unix socket in its temporary directory
// (<temp>/com.google.Chrome.XXXXXX/SingletonSocket), and a socket path cannot
// be longer than about 100 bytes: with a workspace such as
// /home/someone/Documents/toolsengine-workspace the browser stopped at once
// with "Socket path too long". Playwright's own headless build has no such
// socket, which is why the other browser tests never met this.
//
// The live test needs an installed Chrome or Edge (or TOOLSENGINE_TEST_CHANNEL)
// and is skipped where there is none. It uses the server's own headless
// browser session and a blank page; no site is opened.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as browserModule from '../src/browser.js';

const channel = process.env.TOOLSENGINE_TEST_CHANNEL
  || (process.platform === 'linux' && existsSync('/opt/google/chrome/chrome') ? 'chrome' : null)
  || (process.platform === 'linux' && existsSync('/opt/microsoft/msedge/msedge') ? 'msedge' : null);

test('the temporary directory is too long for a browser socket only outside Windows and only past the limit', () => {
  const { browserNeedsShortTemp } = browserModule;
  assert.equal(typeof browserNeedsShortTemp, 'function', 'src/browser.js must decide when the browser needs a short temporary directory');
  assert.equal(browserNeedsShortTemp('/home/a/ToolsEngine/workspace/.toolsengine-runtime/tmp', 'linux'), false);
  assert.equal(browserNeedsShortTemp('/home/someone/Documents/toolsengine-workspace/.toolsengine-runtime/tmp', 'linux'), true);
  assert.equal(browserNeedsShortTemp('/home/someone/Documents/toolsengine-workspace/.toolsengine-runtime/tmp', 'darwin'), true);
  assert.equal(browserNeedsShortTemp(`C:\\Users\\someone\\${'long\\'.repeat(30)}tmp`, 'win32'), false);
  // Counted in bytes, as the socket address is.
  assert.equal(browserNeedsShortTemp(`/home/${'e'.repeat(30)}`, 'linux'), false);
  assert.equal(browserNeedsShortTemp(`/home/${'é'.repeat(30)}`, 'linux'), true);
});

test('short directories left by a server that is gone are removed; those of a living server and anything else are kept',
  { skip: process.platform === 'win32' ? 'no short directories on Windows' : false }, async t => {
    const { removeAbandonedShortTemps } = browserModule;
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-sweep-'));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    // A process number that belonged to a process which has ended.
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    const abandoned = `toolsengine-browser-${ended}-Ab12Cd`;
    const living = `toolsengine-browser-${process.pid}-Ab12Cd`;
    const others = ['toolsengine-browser-notanumber-Ab12Cd', `toolsengine-browser-${ended}-short`, `another-${ended}-Ab12Cd`];
    for (const name of [abandoned, living, ...others]) await fs.mkdir(path.join(base, name, 'inside'), { recursive: true });
    const aFile = `toolsengine-browser-${ended}-Zz99Zz`;
    await fs.writeFile(path.join(base, aFile), 'a file, not a directory');
    assert.deepEqual(await removeAbandonedShortTemps(base), [abandoned]);
    assert.deepEqual((await fs.readdir(base)).sort(), [living, ...others, aFile].sort());

    // The Linux directories, under the workspace's runtime folder, by their
    // own prefix: the same rule, and directories of the other kind are not
    // touched by it.
    const runtime = path.join(base, 'runtime-tmp');
    const abandonedSocket = `browser-sockets-${ended}-Ab12Cd`;
    const livingSocket = `browser-sockets-${process.pid}-Ab12Cd`;
    const otherKind = `toolsengine-browser-${ended}-Ab12Cd`;
    const profile = 'playwright_chromiumdev_profile-Xy12Zw';
    for (const name of [abandonedSocket, livingSocket, otherKind, profile]) await fs.mkdir(path.join(runtime, name, 'inside'), { recursive: true });
    assert.deepEqual(await removeAbandonedShortTemps(runtime, 'browser-sockets-'), [abandonedSocket]);
    assert.deepEqual((await fs.readdir(runtime)).sort(), [livingSocket, otherKind, profile].sort());
    assert.deepEqual(await removeAbandonedShortTemps(path.join(base, 'does-not-exist'), 'browser-sockets-'), []);
  });

test('an installed Chrome or Edge starts in a workspace with a long path, and its short directory is removed again',
  { skip: channel ? false : 'needs an installed Chrome or Edge on Linux, or TOOLSENGINE_TEST_CHANNEL', timeout: 120000 }, async t => {
    const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-long-path-')));
    const workspace = path.join(base, 'a-folder-with-a-fairly-long-name', 'and-another-one-inside-it', 'workspace');
    await fs.mkdir(workspace, { recursive: true });
    assert.ok(Buffer.byteLength(path.join(workspace, '.toolsengine-runtime', 'tmp')) > 100, 'the test path must be too long for a socket');
    // Left behind by a server that was killed: a socket directory whose
    // process is gone. One of a living process (this test's) stays.
    const runtimeTemp = path.join(workspace, '.toolsengine-runtime', 'tmp');
    const ended = spawnSync(process.execPath, ['-e', '']).pid;
    const abandoned = `browser-sockets-${ended}-Ab12Cd`;
    const living = `browser-sockets-${process.pid}-Ab12Cd`;
    for (const name of [abandoned, living]) await fs.mkdir(path.join(runtimeTemp, name), { recursive: true });
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--headless', '--browser-channel', channel],
      cwd: workspace, stderr: 'pipe' });
    const client = new Client({ name: 'toolsengine-long-path', version: '1.0.0' });
    let closed = false;
    t.after(async () => { if (!closed) await client.close(); await fs.rm(base, { recursive: true, force: true }); });
    await client.connect(transport);
    // The directory's name carries the server's process number, so other
    // servers running at the same time are not counted.
    const serverPid = transport.pid;
    assert.ok(Number.isInteger(serverPid));
    const shortDirectories = async () => (await fs.readdir(path.join(workspace,'.toolsengine-runtime','tmp')).catch(() => [])).filter(name => name.startsWith(`browser-sockets-${serverPid}-`));
    const text = result => (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

    const opened = await client.callTool({ name: 'browser.navigate', arguments: { url: 'about:blank' } });
    assert.notEqual(opened.isError, true, `the browser did not start: ${text(opened).split('\n').find(line => /FATAL|too long/.test(line)) || text(opened).slice(0, 700)}`);
    // The browser profile stays in the workspace; only the socket moved.
    // The profile folder itself, by its name: other "playwright-..." folders
    // (its artifacts) are there whether or not the profile moved.
    const kept = await fs.readdir(path.join(workspace, '.toolsengine-runtime', 'tmp'));
    assert.ok(kept.some(name => name.startsWith('playwright_chromiumdev_profile-')), `the browser profile must stay in the workspace; found ${kept.join(', ')}`);
    const short = await shortDirectories();
    assert.equal(short.length, 1, 'one short private directory while the browser runs');
    // The abandoned directory was removed when this server made its own; the living one was kept.
    assert.deepEqual(kept.filter(name => name.startsWith('browser-sockets-') && !name.startsWith(`browser-sockets-${serverPid}-`)).sort(), [living]);
    assert.ok(!(await fs.readdir(path.join(workspace,'.toolsengine-runtime','tmp',short[0]))).some(name => name.startsWith('playwright_chromiumdev_profile-')), 'and the profile must not be in the short directory');

    // Closing the browser removes it; the next call makes a new one.
    assert.notEqual((await client.callTool({ name: 'browser.close', arguments: {} })).isError, true);
    assert.deepEqual(await shortDirectories(), []);
    assert.notEqual((await client.callTool({ name: 'browser.navigate', arguments: { url: 'about:blank' } })).isError, true);
    assert.equal((await shortDirectories()).length, 1);

    // So does stopping the server.
    await client.close();
    closed = true;
    assert.deepEqual(await shortDirectories(), []);
  });
