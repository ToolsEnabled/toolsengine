// browser.show and browser.hide with the real programs: a real browser on its
// private display, TigerVNC's server and viewer, and a second private Xvfb
// that stands in for the person's screen. Nothing here touches the display
// the tests were started from: every X program is given one of these
// private displays explicitly, with its own cookie.
//
// What is checked: hidden, nothing is on the person's screen and the browser
// is on its own display; shown, a window appears on the person's screen,
// showing the same live page, and the person's clicks and keys in it reach
// that page; hidden again, the window is gone, the page is the same page
// (not reloaded, same cookies and session storage) and the browser tools go
// on working. Also the channel: Unix socket only, password, one viewer.
//
//   TOOLSENGINE_TEST_VNC_ROOT=DIR   an unpacked usr folder of the packages
//                                   tigervnc-scraping-server and
//                                   tigervnc-viewer, when they are not installed
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { serverBrowserSkipped } from './support/browser-under-test.js';
import { createBrowserBridge } from '../src/browser.js';
import { createFirefoxBrowserBridge } from '../src/firefox.js';
import { findViewPrograms, serverArguments, viewerArguments, obfuscateVncPassword, tcpListeningSockets, VIEW_TITLE } from '../src/browser-view.js';
import { xauthorityEntry, trustedProgram } from '../src/private-display.js';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export const VIEW_PLATFORM_SKIP = 'browser.show and browser.hide require Linux';
const NO_VNC = 'needs TigerVNC (the packages tigervnc-scraping-server and tigervnc-viewer), or TOOLSENGINE_TEST_VNC_ROOT naming an unpacked copy of them';
const NO_X = 'needs Xvfb, xdotool and xwininfo';

async function viewPrograms() {
  const root = process.env.TOOLSENGINE_TEST_VNC_ROOT;
  if (root) {
    const pick = names => names.map(name => path.join(root, 'bin', name)).find(file => existsSync(file)) || null;
    const lib = path.join(root, 'lib', 'x86_64-linux-gnu');
    const server = pick(['X0tigervnc', 'x0vncserver']), viewer = pick(['xtigervncviewer', 'vncviewer']);
    return server && viewer ? { server, viewer, env: existsSync(lib) ? { LD_LIBRARY_PATH: lib } : {} } : null;
  }
  if (process.platform !== 'linux') return null;
  const found = await findViewPrograms();
  return found.server && found.viewer ? found : null;
}
const programs = await viewPrograms();
const xTools = process.platform === 'linux' && ['Xvfb', 'xdotool', 'xwininfo'].every(name => trustedProgram([name]));
const skipReason = extra => process.platform !== 'linux' ? VIEW_PLATFORM_SKIP : !xTools ? NO_X : !programs ? NO_VNC : extra || false;

// An Xvfb of the tests' own, with a fresh cookie: the stand-in for the
// person's screen, or a display for the channel check.
async function privateX(t, { width = 1440, height = 960 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'te-view-x-'));
  const number = [...Array(30).keys()].map(i => 179 - i).find(n => !existsSync(`/tmp/.X11-unix/X${n}`) && !existsSync(`/tmp/.X${n}-lock`));
  const xauthority = path.join(directory, 'xauthority');
  await fs.writeFile(xauthority, xauthorityEntry(number, randomBytes(16)), { mode: 0o600 });
  const child = spawn(trustedProgram(['Xvfb']), [`:${number}`, '-screen', '0', `${width}x${height}x24`, '-nolisten', 'tcp', '-nolisten', 'local', '-auth', xauthority, '-displayfd', '3'],
    { stdio: ['ignore', 'ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  await new Promise((resolve, reject) => { child.stdio[3].once('data', resolve); child.once('exit', code => reject(new Error(`Xvfb :${number} exited ${code}`))); });
  const display = `:${number}`;
  const env = { PATH: '/usr/bin:/bin', DISPLAY: display, XAUTHORITY: xauthority, HOME: directory };
  t.after(async () => { if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } await fs.rm(directory, { recursive: true, force: true }); });
  return { display, xauthority, env, pid: child.pid, directory };
}
const x = async (env, file, args) => (await run(file, args, { env, timeout: 10000 })).stdout;
// The top-level windows of a display, as "id title" lines.
const topWindows = async env => (await x(env, 'xwininfo', ['-root', '-children'])).split('\n').filter(line => /^\s+0x[0-9a-f]+/.test(line)).map(line => line.trim());
async function viewerWindow(env) {
  const line = (await x(env, 'xwininfo', ['-root', '-tree'])).split('\n').find(text => text.includes(`"${VIEW_TITLE} - TigerVNC"`));
  if (!line) return null;
  const id = line.trim().split(/\s+/)[0];
  const info = await x(env, 'xwininfo', ['-id', id]);
  const value = name => Number(new RegExp(`${name}:\\s+(-?\\d+)`).exec(info)[1]);
  return { id, x: value('Absolute upper-left X'), y: value('Absolute upper-left Y'), width: value('Width'), height: value('Height') };
}
async function waitFor(check, what, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await sleep(100);
  }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
// The environment of each process of this account, where it can be read.
async function environments() {
  const found = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if ((await fs.stat(`/proc/${entry}`)).uid !== process.getuid()) continue;
      const env = Object.fromEntries((await fs.readFile(`/proc/${entry}/environ`)).toString().split('\0').filter(Boolean).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
      const command = (await fs.readFile(`/proc/${entry}/cmdline`)).toString().split('\0')[0];
      found.push({ pid: Number(entry), env, command });
    } catch { /* gone, or not readable */ }
  }
  return found;
}

// A page that says whether it was reloaded (load), what its session storage
// and cookie hold, and how often the person and the agent clicked.
function fixtureSite(t) {
  const cookie = `session=${randomBytes(6).toString('hex')}`;
  const page = `<!doctype html><title>View fixture</title>
<style>body{margin:0;font:16px sans-serif}#bar{height:40px}#pnote{position:fixed;left:0;top:50px;width:100%;height:60px;font-size:28px}#person{position:fixed;left:0;right:0;top:120px;bottom:0;font-size:40px}</style>
<div id=bar><input id=agentnote aria-label="Agent note"> <button id=agentbtn onclick="agent++;render()">Agent button</button></div>
<input id=pnote aria-label="Person note" oninput="render()">
<button id=person onclick="person++;render()">Person button</button>
<p id=state>state</p>
<script>
const load=Math.random().toString(36).slice(2,10);
if(!sessionStorage.mark)sessionStorage.mark='m'+Math.random().toString(36).slice(2,10);
let person=0,agent=0;
function render(){document.getElementById('state').textContent='load='+load+' mark='+sessionStorage.mark+' cookie='+document.cookie+' person='+person+' agent='+agent+' typed='+(document.getElementById('pnote').value||'-')+' ui='+(outerHeight-innerHeight);}
render();
</script>`;
  const server = http.createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `${cookie}; Path=/` }); response.end(page); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/`, cookie })));
}
const readState = text => {
  const match = /load=(\w+) mark=(\w+) cookie=(\S*) person=(\d+) agent=(\d+) typed=(\S+) ui=(\d+)/.exec(text);
  assert.ok(match, `no state in: ${text.slice(0, 2000)}`);
  return { load: match[1], mark: match[2], cookie: match[3], person: Number(match[4]), agent: Number(match[5]), typed: match[6], ui: Number(match[7]) };
};

test('the view channel is a private Unix socket with a password, for one viewer, and no network port', { timeout: 60000, skip: skipReason() }, async t => {
  const screen = await privateX(t, { width: 640, height: 480 }), person = await privateX(t, { width: 800, height: 600 });
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'te-view-channel-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const socketPath = path.join(folder, 'view.sock'), passwordFile = path.join(folder, 'passwd'), wrong = path.join(folder, 'wrong');
  await fs.writeFile(passwordFile, obfuscateVncPassword('Abcdefgh'), { mode: 0o600 });
  await fs.writeFile(wrong, obfuscateVncPassword('Wrongpw1'), { mode: 0o600 });
  const base = { PATH: '/usr/bin:/bin', HOME: folder, ...(programs.env || {}) };
  const children = [];
  const start = (file, args, display, xauthority) => {
    const child = spawn(file, args, { env: { ...base, DISPLAY: display, XAUTHORITY: xauthority }, stdio: ['ignore', 'ignore', 'pipe'] });
    child.log = ''; child.stderr.on('data', data => { child.log += data; });
    children.push(child);
    return child;
  };
  t.after(async () => { for (const child of children) if (child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); } });
  const server = start(programs.server, serverArguments({ display: screen.display, socketPath, passwordFile }), screen.display, screen.xauthority);
  await waitFor(async () => (await fs.lstat(socketPath).catch(() => null))?.isSocket(), 'the socket');
  const socket = await fs.lstat(socketPath);
  assert.equal(socket.mode & 0o777, 0o600);
  assert.equal(socket.uid, process.getuid());
  assert.deepEqual(await tcpListeningSockets(server.pid), [], 'no TCP listener');
  const ss = await run('ss', ['-lxp']).then(result => result.stdout.split('\n').filter(line => line.includes(`pid=${server.pid},`)), () => ['ss unavailable']);
  t.diagnostic(`view server ${server.pid} listening: ${ss.map(line => line.replace(/\s+/g, ' ')).join(' | ')}`);
  assert.ok(ss.length === 1 && ss[0].includes(socketPath), 'one listener, the private socket');
  const ssTcp = await run('ss', ['-ltnup']).then(result => result.stdout.split('\n').filter(line => line.includes(`pid=${server.pid},`)), () => []);
  assert.deepEqual(ssTcp, []);
  // A wrong password is refused.
  const refused = start(programs.viewer, viewerArguments({ socketPath, passwordFile: wrong }), person.display, person.xauthority);
  await waitFor(() => refused.exitCode !== null || refused.signalCode !== null, 'the refused viewer to exit');
  assert.match(refused.log, /Authentication failure/);
  assert.doesNotMatch(refused.log, /Using pixel format/);
  // The right one connects and its window appears on the other display.
  const first = start(programs.viewer, viewerArguments({ socketPath, passwordFile }), person.display, person.xauthority);
  await waitFor(() => /Using pixel format/.test(first.log), 'the viewer to connect');
  await waitFor(() => viewerWindow(person.env), 'the viewer window');
  // While it is connected a second viewer, even with the password, is refused.
  const second = start(programs.viewer, viewerArguments({ socketPath, passwordFile }), person.display, person.xauthority);
  await waitFor(() => second.exitCode !== null || second.signalCode !== null, 'the second viewer to exit');
  assert.match(second.log, /already in use/);
  assert.equal(first.exitCode, null, 'the first viewer stays connected');
});

test('ToolsEngine\'s Chromium on its private display: hidden, shown to the person who uses it, hidden again with the same live page', { timeout: 180000, skip: skipReason(serverBrowserSkipped) }, async t => {
  const person = await privateX(t);
  const site = await fixtureSite(t);
  // A long workspace path: the view socket is then named through the folder handle.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-view-chromium-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const workspace = path.join(root, 'w'.repeat(70)); await fs.mkdir(workspace);
  const named = process.env.TOOLSENGINE_TEST_BROWSER;
  const bridge = await createBrowserBridge({ workspace, privateDisplay: true, headless: true, ...(named ? { browserExecutable: named } : {}), ...(process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1' ? { browserSandbox: false } : {}) },
    { personDisplay: { display: person.display, xauthority: person.xauthority }, viewPrograms: programs });
  let closed = false;
  t.after(async () => { if (!closed) await bridge.close(); });
  const tools = new Map([...bridge.tools, ...bridge.viewTools].map(tool => [tool.name, tool]));
  const call = async (name, args = {}) => {
    const result = await tools.get(name).handler(args, {});
    if (result?.isError) throw new Error(`${name}: ${result.content.map(part => part.text).join(' ')}`);
    return result?.content ? result.content.map(part => part.text).join('\n') : result;
  };
  const snapshot = async () => call('browser.snapshot');

  // Hidden: the agent works; nothing is on the person's screen.
  await call('browser.navigate', { url: site.url });
  await call('browser.type', { target: '#agentnote', text: 'agent text' });
  await call('browser.click', { target: '#agentbtn' });
  const before = readState(await snapshot());
  assert.equal(before.cookie, site.cookie);
  assert.equal(before.agent, 1);
  assert.deepEqual(await call('browser.visibility'), { visible: false, lastHidden: null });
  assert.deepEqual(await topWindows(person.env), [], 'nothing on the person\'s screen while hidden');
  const display = bridge.privateDisplay();
  assert.notEqual(display.display, person.display);
  assert.ok(display.alive);
  // The browser is on its own display and never on the person's.
  const processes = await environments();
  const onPrivate = processes.filter(proc => proc.env.XAUTHORITY === display.xauthority && proc.pid !== display.pid);
  assert.ok(onPrivate.length >= 1, 'the browser\'s processes were found');
  for (const proc of onPrivate) {
    assert.equal(proc.env.DISPLAY, display.display, proc.command);
    assert.equal(proc.env.WAYLAND_DISPLAY, undefined, proc.command);
    assert.equal(proc.env.DBUS_SESSION_BUS_ADDRESS, 'disabled:', proc.command);
  }
  assert.ok(!processes.some(proc => proc.env.DISPLAY === person.display && proc.pid !== person.pid), 'no process is on the person\'s display while hidden');
  // The private display wants its cookie and offers no TCP and no abstract socket.
  await assert.rejects(run('xdotool', ['getdisplaygeometry'], { env: { PATH: '/usr/bin:/bin', DISPLAY: display.display, XAUTHORITY: '/dev/null' }, timeout: 5000 }));
  assert.deepEqual(await tcpListeningSockets(display.pid), []);
  const xvfbSockets = (await run('ss', ['-lxp'])).stdout.split('\n').filter(line => line.includes(`pid=${display.pid},`));
  t.diagnostic(`private Xvfb ${display.pid} listening: ${xvfbSockets.map(line => line.replace(/\s+/g, ' ')).join(' | ')}`);
  assert.ok(xvfbSockets.length === 1 && xvfbSockets[0].includes(`/tmp/.X11-unix/X${display.display.slice(1)}`) && !xvfbSockets[0].includes('@'));

  // Shown: a window on the person's screen, showing that same page.
  const shown = await call('browser.show');
  assert.equal(shown.visible, true);
  assert.equal(shown.personDisplay, person.display);
  const viewer = await waitFor(() => viewerWindow(person.env), 'the viewer window on the person\'s screen');
  assert.deepEqual(await call('browser.visibility'), shown);
  const { server, viewer: viewerPid, folder } = bridge.view.processes();
  assert.deepEqual(await tcpListeningSockets(server), [], 'the view server has no TCP listener');
  assert.deepEqual(await tcpListeningSockets(viewerPid), []);
  const sockets = (await run('ss', ['-lxp'])).stdout.split('\n').filter(line => line.includes(`pid=${server},`));
  t.diagnostic(`view server ${server} listening: ${sockets.map(line => line.replace(/\s+/g, ' ')).join(' | ')}`);
  assert.equal(sockets.length, 1);
  assert.equal((await fs.lstat(folder)).mode & 0o777, 0o700);
  assert.equal((await fs.lstat(path.join(folder, 'view.sock'))).mode & 0o777, 0o600);
  assert.equal((await fs.lstat(path.join(folder, 'passwd'))).mode & 0o777, 0o600);
  // Only the viewer is on the person's display.
  assert.deepEqual((await environments()).filter(proc => proc.env.DISPLAY === person.display && proc.pid !== person.pid).map(proc => proc.pid), [viewerPid]);
  // The person clicks the page's big button and types into its field, in the viewer window.
  const ui = before.ui;
  await x(person.env, 'xdotool', ['mousemove', String(viewer.x + 640), String(viewer.y + ui + 450), 'click', '1']);
  await waitFor(async () => readState(await snapshot()).person === 1, 'the person\'s click to reach the page');
  await x(person.env, 'xdotool', ['mousemove', String(viewer.x + 640), String(viewer.y + ui + 80), 'click', '1']);
  await x(person.env, 'xdotool', ['windowfocus', viewer.id]);
  await x(person.env, 'xdotool', ['type', '--delay', '60', 'hello']);
  await waitFor(async () => readState(await snapshot()).typed === 'hello', 'the person\'s typing to reach the page');
  // The agent works on while it is shown.
  await call('browser.click', { target: '#agentbtn' });
  assert.equal(readState(await snapshot()).agent, 2);

  // Hidden again: the window is gone, the programs have stopped, the page is the same.
  const hidden = await call('browser.hide');
  assert.equal(hidden.visible, false);
  assert.equal(hidden.lastHidden.reason, 'browser.hide');
  assert.deepEqual(await topWindows(person.env), [], 'the window is gone');
  assert.equal(alive(server), false);
  assert.equal(alive(viewerPid), false);
  await assert.rejects(fs.lstat(folder), { code: 'ENOENT' });
  const after = readState(await snapshot());
  assert.deepEqual({ load: after.load, mark: after.mark, cookie: after.cookie, person: after.person, typed: after.typed }, { load: before.load, mark: before.mark, cookie: site.cookie, person: 1, typed: 'hello' }, 'not reloaded: same page, session storage and cookie');
  await call('browser.click', { target: '#agentbtn' });
  assert.equal(readState(await snapshot()).agent, 3, 'the browser tools go on working');
  assert.match(await snapshot(), /agent text/);

  // View only: the person sees it, and their click does not reach the page.
  await call('browser.show', { viewOnly: true });
  const watching = await waitFor(() => viewerWindow(person.env), 'the view-only window');
  await x(person.env, 'xdotool', ['mousemove', String(watching.x + 640), String(watching.y + ui + 450), 'click', '1']);
  await sleep(1500);
  assert.equal(readState(await snapshot()).person, 1, 'a view-only window sends no input');

  // The person closing the window hides the browser.
  await x(person.env, 'xdotool', ['windowkill', watching.id]);
  await waitFor(async () => !(await call('browser.visibility')).visible, 'the closed window to be noticed');
  assert.equal((await call('browser.visibility')).lastHidden.reason, 'window-closed');
  assert.deepEqual(await topWindows(person.env), []);

  // The browser closing while shown closes the window, and its private display ends with it.
  await call('browser.show');
  await waitFor(() => viewerWindow(person.env), 'the window again');
  await call('browser.close');
  assert.equal((await call('browser.visibility')).lastHidden.reason, 'browser-closed');
  assert.deepEqual(await topWindows(person.env), []);
  await waitFor(() => !alive(display.pid), 'the private display to end with the browser');
  // A new browser call starts the browser on a new private display, hidden.
  await call('browser.navigate', { url: site.url });
  assert.deepEqual(await topWindows(person.env), []);
  const again = bridge.privateDisplay();
  assert.ok(again.alive && again.pid !== display.pid);
  await bridge.close(); closed = true;
  await waitFor(() => !alive(again.pid), 'the private display to end when ToolsEngine closes');
});

// The real server over stdio, with the stand-in for the person's screen as
// its DISPLAY. The programs browser.show uses are looked up as in a real
// installation (system folders only): where TigerVNC is installed it shows
// and hides; where it is not, the answer names the packages, and nothing
// appears on the person's screen either way.
test('over stdio, --private-display offers browser.show, keeps the browser off the person\'s screen, and shows it or names what is missing', { timeout: 150000, skip: process.platform !== 'linux' ? VIEW_PLATFORM_SKIP : !xTools ? NO_X : serverBrowserSkipped || false }, async t => {
  const person = await privateX(t);
  const site = await fixtureSite(t);
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'te-view-stdio-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const named = process.env.TOOLSENGINE_TEST_BROWSER;
  const env = { ...process.env, DISPLAY: person.display, XAUTHORITY: person.xauthority };
  delete env.WAYLAND_DISPLAY;
  const transport = new StdioClientTransport({ command: process.execPath, cwd: workspace, stderr: 'pipe', env,
    args: [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--private-display',
      ...(process.env.TOOLSENGINE_TEST_VNC_ROOT ? ['--browser-view-runtime', process.env.TOOLSENGINE_TEST_VNC_ROOT] : []),
      ...(named ? ['--browser-executable', named] : []), ...(process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1' ? ['--no-browser-sandbox'] : [])] });
  let errors = '';
  transport.stderr?.on('data', chunk => { errors += chunk; });
  const client = new Client({ name: 'toolsengine-view-acceptance', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of ['browser.show', 'browser.hide', 'browser.visibility']) assert.ok(names.includes(name), name);
  assert.equal(names.length, 30, 'the 27 tools of the default mode and the three');
  assert.match(client.getInstructions(), /browser\.show opens a window on the person's screen/);
  const call = async (name, args = {}) => client.callTool({ name, arguments: args });
  const json = async (name, args) => JSON.parse((await call(name, args)).content[0].text);
  const status = await json('system.status');
  assert.equal(status.browserWindowMode, 'private-display');
  assert.deepEqual(status.browserView, { visible: false, lastHidden: null });
  assert.notEqual((await call('browser.navigate', { url: site.url })).isError, true);
  assert.deepEqual(await topWindows(person.env), [], 'the headed browser is not on the person\'s screen');
  const installed = process.env.TOOLSENGINE_TEST_VNC_ROOT ? programs : await findViewPrograms();
  const shown = await call('browser.show');
  if (installed.server && installed.viewer) {
    assert.notEqual(shown.isError, true, JSON.stringify(shown));
    assert.equal(JSON.parse(shown.content[0].text).visible, true);
    await waitFor(() => viewerWindow(person.env), 'the viewer window');
    assert.equal(JSON.parse((await call('browser.hide')).content[0].text).visible, false);
  } else {
    assert.equal(shown.isError, true);
    assert.match(shown.content[0].text, /^browser\.show: Showing the browser needs TigerVNC's scraping server \(x0vncserver\) and viewer \(vncviewer\); on Debian and Ubuntu they are the packages tigervnc-scraping-server and tigervnc-viewer\. (?:Neither is|The scraping server is not|The viewer is not) installed in \/usr\/bin, \/usr\/local\/bin, \/bin\. Nothing was shown; the browser keeps running hidden\./);
    t.diagnostic('TigerVNC is not installed in the system folders here: checked the refusal; the showing itself is checked by the other tests of this file');
  }
  assert.deepEqual(await topWindows(person.env), []);
  assert.deepEqual(await json('browser.visibility'), (await json('system.status')).browserView);
  assert.equal(errors, '', 'nothing on stderr');
});

test('hidden Firefox: shown to the person who clicks in it, hidden again with the same live page', {
  timeout: 240000,
  skip: skipReason(process.env.TOOLSENGINE_FIREFOX_LIVE !== '1' ? 'set TOOLSENGINE_FIREFOX_LIVE=1 on a Linux desktop with Firefox, Xvfb, xauth and AT-SPI' : false),
}, async t => {
  const person = await privateX(t);
  const site = await fixtureSite(t);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-view-firefox-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  await fs.mkdir(home); await fs.mkdir(workspace);
  let bridge, firefoxPid, receipt;
  t.after(async () => {
    receipt ??= await fs.readFile(path.join(bridge.agentProfileDir, '.toolsengine-display.json'), 'utf8').then(JSON.parse).catch(() => null);
    await bridge?.close();
    // Retire only the browser and display bearing this fixture's unique profile, as tests/firefox-live.linux.test.js does.
    if (firefoxPid) { const args = (await fs.readFile(`/proc/${firefoxPid}/cmdline`).catch(() => Buffer.from(''))).toString().split('\0'); if (args.some((value, index) => value === '--profile' && args[index + 1] === bridge.agentProfileDir)) process.kill(firefoxPid, 'SIGTERM'); }
    if (receipt) { const args = (await fs.readFile(`/proc/${receipt.pid}/cmdline`).catch(() => Buffer.from(''))).toString().split('\0'); if (args.includes(receipt.display) && args.includes(path.join(bridge.agentProfileDir, receipt.auth))) process.kill(receipt.pid, 'SIGTERM'); }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  bridge = await createFirefoxBrowserBridge({ home, workspace, visibleDisplay: person.display }, { personDisplay: { display: person.display, xauthority: person.xauthority }, viewPrograms: programs });
  const tools = new Map([...bridge.tools, ...bridge.viewTools].map(tool => [tool.name, tool]));
  const call = async (name, args = {}) => { const result = await tools.get(name).handler(args, {}); return result?.content ? result.content.map(part => part.text).join('\n') : result; };
  await call('browser.tabs', { action: 'new', url: site.url });
  const stateIn = text => readState(text.replace(/\\"/g, '"'));
  const before = await waitFor(async () => { const text = await call('browser.snapshot', { depth: 30 }); return /load=\w+/.test(text) && stateIn(text); }, 'the fixture page');
  firefoxPid = JSON.parse(await call('browser.windows', { action: 'list' }))[0].pid;
  receipt = JSON.parse(await fs.readFile(path.join(bridge.agentProfileDir, '.toolsengine-display.json'), 'utf8'));
  assert.deepEqual(await call('browser.visibility'), { visible: false, lastHidden: null });
  assert.deepEqual(await topWindows(person.env), [], 'nothing on the person\'s screen while hidden');

  const shown = await call('browser.show');
  assert.equal(shown.visible, true);
  const viewer = await waitFor(() => viewerWindow(person.env), 'the viewer window');
  // The Firefox window's top left on its display: the page's big button is below its toolbars.
  await x(person.env, 'xdotool', ['mousemove', String(viewer.x + 640), String(viewer.y + 520), 'click', '1']);
  const clicked = await waitFor(async () => { const state = stateIn(await call('browser.snapshot', { depth: 30 })); return state.person === 1 && state; }, 'the person\'s click to reach the page', 20000);
  assert.equal(clicked.load, before.load);
  const { server, viewer: viewerPid } = bridge.view.processes();
  assert.deepEqual(await tcpListeningSockets(server), []);

  const hidden = await call('browser.hide');
  assert.equal(hidden.visible, false);
  assert.deepEqual(await topWindows(person.env), []);
  assert.equal(alive(viewerPid), false);
  const page = await call('browser.snapshot', { depth: 30 });
  const after = stateIn(page);
  assert.deepEqual({ load: after.load, mark: after.mark, cookie: after.cookie, person: after.person }, { load: before.load, mark: before.mark, cookie: site.cookie, person: 1 });
  const button = /push button "Agent button"[^\n]*\[ref=([^\]]+)\]/.exec(page)?.[1];
  assert.ok(button, page.slice(0, 1500));
  await call('browser.click', { ref: button });
  await waitFor(async () => stateIn(await call('browser.snapshot', { depth: 30 })).agent === 1, 'the agent\'s click after hiding');
});
