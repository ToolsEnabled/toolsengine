// browser.show / browser.hide / browser.visibility without a browser: the
// password file, the displays accepted, the arguments of the two TigerVNC
// programs, the private folder, and the show/hide state with stand-in
// programs. tests/browser-view.integration.test.js runs the real programs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import {
  obfuscateVncPassword, randomVncPassword, displayNumber, personDisplayFrom, socketPathFor, privateFolder,
  removeAbandonedFolders, tcpListeningSockets, serverArguments, viewerArguments, createBrowserView,
  browserViewTools, findViewPrograms, viewProgramsFromRuntime, VIEW_INSTRUCTIONS, NOTHING_SHOWN,
} from '../src/browser-view.js';
import { xauthorityEntry, startPrivateDisplay, privateDisplayEnvironment, PRIVATE_DISPLAY_BROWSER_ARGS, DISPLAY_NUMBERS } from '../src/private-display.js';
import { parseConfig } from '../src/config.js';
import { browserCapabilityStatus, serverInstructions, createToolsEngine } from '../src/server.js';
import { browserLaunchOptions } from '../src/browser.js';
import { assertPluginProfile } from '../src/plugin-policy.js';
import { createFirefoxBrowserBridge } from '../src/firefox.js';
import { assertReviewable } from '../tools/descriptor-rules.js';

const linuxOnly = process.platform === 'linux' ? false : 'Unix sockets in private folders and X displays are tested on Linux';

test('an explicit local TigerVNC runtime is verified and unsafe binaries are refused', { skip: linuxOnly }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-vnc-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'bin'), { mode: 0o700 });
  for (const [file, kind] of [['X0tigervnc', 'Server'], ['xtigervncviewer', 'Viewer']])
    await fs.writeFile(path.join(root, 'bin', file), `#!/bin/sh\nprintf 'TigerVNC ${kind}\\n'\n`, { mode: 0o700 });
  const found = await viewProgramsFromRuntime(root);
  assert.equal(found.server, path.join(root, 'bin', 'X0tigervnc'));
  assert.equal(found.viewer, path.join(root, 'bin', 'xtigervncviewer'));
  const args = ['--workspace', root, '--browser-view-runtime', root];
  assert.equal((await parseConfig([...args, '--firefox-hidden'])).browserViewRuntime, root);
  assert.equal((await parseConfig([...args, '--private-display'])).browserViewRuntime, root);
  await assert.rejects(parseConfig(args), /requires --private-display or --firefox-hidden/);
  await assert.rejects(parseConfig([...args, '--no-browser']), /requires/);
  await assert.rejects(parseConfig([...args, '--no-browser', '--plugin-profile', 'openai']), /OpenAI plugin profile/);
  await fs.chmod(found.viewer, 0o722);
  await assert.rejects(viewProgramsFromRuntime(root), /not linked or writable/);
  await fs.chmod(found.viewer, 0o700);
  await fs.rename(found.viewer, `${found.viewer}.real`);
  await fs.symlink(`${found.viewer}.real`, found.viewer);
  await assert.rejects(viewProgramsFromRuntime(root), /not linked or writable/);
});

test('the VNC password file is TigerVNC\'s obfuscated format, with a new random password each time', () => {
  // vncpasswd -f < "abcdefgh" writes these eight bytes.
  assert.equal(obfuscateVncPassword('abcdefgh').toString('hex'), 'db8ab02565e3b4c2');
  const vncpasswd = spawnSync('vncpasswd', ['-f'], { input: 'Q7rmX2kd' });
  if (vncpasswd.status === 0) assert.equal(obfuscateVncPassword('Q7rmX2kd').toString('hex'), vncpasswd.stdout.toString('hex'));
  const passwords = new Set(Array.from({ length: 50 }, randomVncPassword));
  assert.equal(passwords.size, 50);
  for (const password of passwords) assert.match(password, /^[A-HJ-NP-Za-km-z2-9]{8}$/);
});

test('the browser is shown only on a display of this computer, and the reason is given otherwise', () => {
  assert.equal(displayNumber(':1'), '1');
  assert.equal(displayNumber(':12.0'), '12');
  assert.equal(displayNumber('unix:3'), '3');
  assert.equal(displayNumber('localhost:10.0'), '10');
  assert.equal(displayNumber('wayland-0'), null);
  assert.deepEqual(personDisplayFrom({ display: ':1', xauthority: '/run/user/1000/xauth' }), { display: ':1', xauthority: '/run/user/1000/xauth' });
  // ssh -X forwards the person's display to loopback.
  assert.deepEqual(personDisplayFrom({ display: 'localhost:10.0', xauthority: '/home/p/.Xauthority' }), { display: 'localhost:10.0', xauthority: '/home/p/.Xauthority' });
  // Without XAUTHORITY the person's default file is named, because the viewer has a private home.
  assert.deepEqual(personDisplayFrom({ display: ':0', home: '/home/p', exists: file => file === '/home/p/.Xauthority' }), { display: ':0', xauthority: '/home/p/.Xauthority' });
  assert.deepEqual(personDisplayFrom({ display: ':0', home: '/home/p', exists: () => false }), { display: ':0' });
  assert.throws(() => personDisplayFrom({}), /without the person's screen \(no DISPLAY\)/);
  assert.throws(() => personDisplayFrom({ wayland: 'wayland-0' }), /Wayland without an X11/);
  for (const display of ['192.168.1.5:0', 'example.com:0', 'evil:0.0', ':1;rm'])
    assert.throws(() => personDisplayFrom({ display }), /not a display of this computer/, display);
  for (const thrower of [() => personDisplayFrom({}), () => personDisplayFrom({ display: 'h:0' })])
    assert.throws(thrower, error => error.message.endsWith(NOTHING_SHOWN));
});

test('the view server listens on a private Unix socket only, with a password, for one viewer; the viewer shares no clipboard', () => {
  const server = serverArguments({ display: ':150', socketPath: '/p/view.sock', passwordFile: '/p/passwd' });
  const pairs = (args, name) => args[args.indexOf(name) + 1];
  assert.ok(server.includes('-rfbport=-1'), 'no TCP port');
  assert.equal(pairs(server, '-rfbunixpath'), '/p/view.sock');
  assert.equal(pairs(server, '-rfbunixmode'), '0600');
  assert.equal(pairs(server, '-SecurityTypes'), 'VncAuth');
  assert.equal(pairs(server, '-PasswordFile'), '/p/passwd');
  assert.equal(pairs(server, '-display'), ':150');
  for (const flag of ['-NeverShared=1', '-DisconnectClients=0', '-AcceptSetDesktopSize=0', '-QueryConnect=0', '-localhost=1']) assert.ok(server.includes(flag), flag);
  assert.ok(!server.some(arg => /None|TLS|X509|RA2|Plain/.test(arg)), 'no security type other than the password');
  const viewer = viewerArguments({ socketPath: '/p/view.sock', passwordFile: '/p/passwd' });
  assert.equal(viewer.at(-1), '/p/view.sock');
  for (const flag of ['-SendClipboard=0', '-AcceptClipboard=0', '-SendPrimary=0', '-SetPrimary=0', '-ViewOnly=0', '-Shared=0', '-ReconnectOnError=0', '-AlertOnFatalError=0'])
    assert.ok(viewer.includes(flag), flag);
  assert.equal(pairs(viewer, '-SecurityTypes'), 'VncAuth');
  assert.ok(viewerArguments({ socketPath: 's', passwordFile: 'p', viewOnly: true }).includes('-ViewOnly=1'));
});

test('the socket path stays within a Unix socket\'s length, through the open folder handle when the folder path is long', { skip: linuxOnly }, async t => {
  assert.equal(socketPathFor('/tmp/x', 9, 42), '/tmp/x/view.sock');
  assert.equal(socketPathFor(`/tmp/${'a'.repeat(120)}`, 9, 42), '/proc/42/fd/9/view.sock');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `toolsengine-view-${'d'.repeat(90)}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const folder = await privateFolder(root);
  assert.match(folder.socketPath, new RegExp(`^/proc/${process.pid}/fd/\\d+/view\\.sock$`));
  assert.equal((await fs.lstat(folder.directory)).mode & 0o777, 0o700);
  // A socket made through the handle path is the socket in the folder.
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(folder.socketPath, resolve));
  assert.ok((await fs.lstat(folder.socketFile)).isSocket());
  await new Promise(resolve => listener.close(resolve));
  await folder.close();
  await assert.rejects(fs.lstat(folder.directory), { code: 'ENOENT' });
  // Folders of a process that is gone are removed; those of a live process, and other names, are kept.
  const dead = path.join(root, 'browser-view-999999999-AbCdEf'), alive = path.join(root, `browser-view-${process.pid}-AbCdEf`), other = path.join(root, 'browser-view-notes');
  for (const folder of [dead, alive, other]) await fs.mkdir(folder);
  assert.deepEqual(await removeAbandonedFolders(root, 'browser-view-'), ['browser-view-999999999-AbCdEf']);
  for (const folder of [alive, other]) assert.ok((await fs.lstat(folder)).isDirectory());
});

test('a TCP listener of the view server is found from /proc', async () => {
  const fake = {
    readdir: async () => ['3', '4', '5'],
    readlink: async file => ({ '/proc/7/fd/3': 'socket:[111]', '/proc/7/fd/4': 'socket:[222]', '/proc/7/fd/5': '/dev/null' })[file],
    readFile: async table => table.endsWith('tcp')
      ? '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 00000000:170C 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 111 1 0 20 0\n   1: 0100007F:1F90 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 222 1 0 20 0\n'
      : '',
  };
  assert.deepEqual(await tcpListeningSockets(7, fake), ['00000000:170C']);
  assert.deepEqual(await tcpListeningSockets(7, { ...fake, readFile: async () => '' }), []);
  // The real table for this process, which listens on nothing.
  if (process.platform === 'linux') assert.deepEqual(await tcpListeningSockets(process.pid), []);
});

test('the private display is an Xvfb with a fresh cookie, no TCP and no abstract socket, never the person\'s display number', { skip: linuxOnly }, async t => {
  const entry = xauthorityEntry(150, Buffer.alloc(16, 7));
  assert.equal(entry.readUInt16BE(0), 0xffff);
  assert.equal(entry.readUInt16BE(2), 0, 'any address');
  assert.equal(entry.slice(6, 9).toString(), '150');
  assert.equal(entry.slice(11, 29).toString(), 'MIT-MAGIC-COOKIE-1');
  assert.equal(entry.readUInt16BE(29), 16);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-display-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const started = [];
  const spawnProgram = (file, args) => {
    const child = new EventEmitter();
    child.pid = 4242; child.exitCode = null; child.signalCode = null;
    child.stderr = new PassThrough(); child.stdio = [null, null, child.stderr, new PassThrough()];
    child.kill = () => { child.signalCode = 'SIGTERM'; setImmediate(() => child.emit('exit', null, 'SIGTERM')); };
    started.push({ file, args, child });
    setImmediate(() => child.stdio[3].write(`${args[0].slice(1)}\n`));
    return child;
  };
  const display = await startPrivateDisplay({ directory, visibleDisplay: ':199', xvfb: '/usr/bin/Xvfb', spawnProgram, exists: file => file === '/tmp/.X11-unix/X198' });
  assert.equal(display.display, ':197', 'the person\'s number and a number in use are passed over');
  const { args } = started[0];
  for (const [flag, value] of [['-nolisten', 'tcp'], ['-auth', display.xauthority], ['-displayfd', '3']]) assert.ok(args.some((arg, i) => arg === flag && args[i + 1] === value), `${flag} ${value}`);
  assert.ok(args.some((arg, i) => arg === '-nolisten' && args[i + 1] === 'local'), 'no abstract socket');
  assert.ok(args.includes('-terminate'));
  const stat = await fs.lstat(display.xauthority);
  assert.equal(stat.mode & 0o777, 0o600);
  assert.equal(stat.size, 47, 'family, empty address, display number, cookie name and 16 bytes');
  assert.equal(display.alive(), true);
  await display.close();
  assert.equal(display.alive(), false);
  await assert.rejects(fs.lstat(display.xauthority), { code: 'ENOENT' });
  await assert.rejects(startPrivateDisplay({ directory, xvfb: null, spawnProgram, exists: () => false }), /^Error: --private-display needs Xvfb \(on Debian and Ubuntu, the package xvfb\)\. The browser was not started; no visible display was used\.$/);
  // An Xvfb that refuses every number tried: the last reason is given.
  const refusing = () => {
    const child = new EventEmitter();
    child.pid = 4343; child.exitCode = null; child.signalCode = null;
    child.stderr = new PassThrough(); child.stdio = [null, null, child.stderr, new PassThrough()];
    child.kill = () => {};
    child.stderr.write('(EE) Fatal server error:\n(EE) Server is already active for display\n');
    setImmediate(() => { child.exitCode = 1; child.emit('exit', 1, null); });
    return child;
  };
  await assert.rejects(startPrivateDisplay({ directory, xvfb: '/usr/bin/Xvfb', spawnProgram: refusing, numbers: [190, 191], exists: () => false }), /could not be started \(\(EE\) Server is already active for display\)\. The browser was not started; no visible display was used\./);
  assert.deepEqual(await fs.readdir(directory), [], 'no cookie file is left behind');
  assert.equal(DISPLAY_NUMBERS[0], 199);
  assert.ok(DISPLAY_NUMBERS.every(number => number > 97));
});

test('the browser on the private display gets that display and cookie, none of the person\'s Wayland or session bus, and runs headed there', () => {
  const env = privateDisplayEnvironment({ DISPLAY: ':1', XAUTHORITY: '/home/p/.Xauthority', WAYLAND_DISPLAY: 'wayland-0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', HOME: '/home/p' }, { display: ':150', xauthority: '/w/x' });
  assert.deepEqual(env, { DISPLAY: ':150', XAUTHORITY: '/w/x', DBUS_SESSION_BUS_ADDRESS: 'disabled:', HOME: '/home/p' });
  assert.deepEqual(browserLaunchOptions({ privateDisplay: true, headless: true }), { headless: false, chromiumSandbox: true, args: [...PRIVATE_DISPLAY_BROWSER_ARGS] });
  assert.ok(PRIVATE_DISPLAY_BROWSER_ARGS.includes('--ozone-platform=x11'));
  assert.ok(PRIVATE_DISPLAY_BROWSER_ARGS.includes('--mute-audio'));
  // Without the option nothing changes.
  assert.deepEqual(browserLaunchOptions({ headless: true }), { headless: true, chromiumSandbox: true });
});

// Stand-ins for the two programs: the server makes its socket (private, as
// TigerVNC makes it) and writes what TigerVNC writes; the viewer connects.
function standIns({ serverLog = ' Main: Listening\n', viewerLog = ' CConn: Using pixel format depth 24\n', listen = true } = {}) {
  const spawned = [];
  const spawnProgram = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 5000 + spawned.length; child.exitCode = null; child.signalCode = null;
    child.stderr = new PassThrough();
    child.kill = signal => { if (child.exitCode !== null || child.signalCode !== null) return; child.signalCode = signal; child.server?.close(); setImmediate(() => child.emit('exit', null, signal)); };
    child.exitAlone = () => { child.exitCode = 0; child.server?.close(); child.emit('exit', 0, null); };
    spawned.push({ file, args, options, child });
    if (file === '/stand-in/server') {
      const socket = args[args.indexOf('-rfbunixpath') + 1];
      if (listen) {
        child.server = net.createServer();
        child.server.listen(socket, async () => { await fs.chmod(socket, 0o600); child.stderr.write(serverLog); });
      }
    } else setImmediate(() => child.stderr.write(viewerLog));
    return child;
  };
  return { spawned, spawnProgram };
}

async function viewFixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-view-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const programs = standIns(overrides.standIns);
  const asked = [];
  const view = createBrowserView({
    runtimeRoot: root,
    personDisplay: () => overrides.person ?? { display: ':171', xauthority: '/sim/user.auth' },
    privateDisplay: async () => { asked.push('private'); return { display: ':150', xauthority: '/sim/private.auth' }; },
    programs: { server: '/stand-in/server', viewer: '/stand-in/viewer', env: { LD_LIBRARY_PATH: '/stand-in/lib' } },
    spawnProgram: programs.spawnProgram, listeners: overrides.listeners ?? (async () => []),
    settleMs: 20, connectTimeoutMs: overrides.connectTimeoutMs ?? 3000, ...(overrides.view || {}),
  });
  t.after(() => view.close());
  return { view, root, asked, ...programs };
}

test('showing starts the server on the private display and the viewer on the person\'s, each with only its own display', { skip: linuxOnly }, async t => {
  const { view, spawned, asked } = await viewFixture(t);
  assert.deepEqual(view.state(), { visible: false, lastHidden: null });
  const shown = await view.show();
  assert.equal(shown.visible, true);
  assert.equal(shown.viewOnly, false);
  assert.equal(shown.personDisplay, ':171');
  assert.deepEqual(asked, ['private']);
  const [server, viewer] = spawned;
  assert.equal(server.options.env.DISPLAY, ':150');
  assert.equal(server.options.env.XAUTHORITY, '/sim/private.auth');
  assert.equal(viewer.options.env.DISPLAY, ':171');
  assert.equal(viewer.options.env.XAUTHORITY, '/sim/user.auth');
  const { folder } = view.processes();
  for (const env of [server.options.env, viewer.options.env]) {
    assert.equal(env.HOME, folder, 'a private home');
    assert.deepEqual(Object.keys(env).sort(), ['DISPLAY', 'HOME', 'LANG', 'LD_LIBRARY_PATH', 'PATH', 'XAUTHORITY']);
  }
  const passwordFile = server.args[server.args.indexOf('-PasswordFile') + 1];
  assert.equal(viewer.args[viewer.args.indexOf('-PasswordFile') + 1], passwordFile);
  assert.equal((await fs.lstat(passwordFile)).mode & 0o777, 0o600);
  assert.equal((await fs.readFile(passwordFile)).length, 8);
  // Showing again in the same way changes nothing.
  await view.show();
  assert.equal(spawned.length, 2);
  // Hiding stops both, the viewer first, and removes the folder.
  const hidden = await view.hide();
  assert.equal(hidden.visible, false);
  assert.equal(hidden.lastHidden.reason, 'browser.hide');
  assert.equal(viewer.child.signalCode, 'SIGTERM');
  assert.equal(server.child.signalCode, 'SIGTERM');
  await assert.rejects(fs.lstat(folder), { code: 'ENOENT' });
  // Showing view-only starts a new pair with the viewer's input off.
  const viewOnly = await view.show({ viewOnly: true });
  assert.equal(viewOnly.viewOnly, true);
  assert.ok(spawned[3].args.includes('-ViewOnly=1'));
  // Showing with input again replaces it.
  await view.show({ viewOnly: false });
  assert.equal(spawned.length, 6);
  assert.equal(spawned[3].child.signalCode, 'SIGTERM');
});

test('the person closing the viewer window hides the browser, and that is reported', { skip: linuxOnly }, async t => {
  const { view, spawned } = await viewFixture(t);
  await view.show();
  const [server, viewer] = spawned;
  viewer.child.exitAlone();
  for (let i = 0; i < 100 && view.state().visible; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(view.state().visible, false);
  assert.equal(view.state().lastHidden.reason, 'window-closed');
  for (let i = 0; i < 100 && server.child.signalCode === null; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(server.child.signalCode, 'SIGTERM', 'the server goes with its viewer');
  // The browser closing ends a showing at once (release), with its own reason.
  await view.show();
  await view.release('browser-closed');
  assert.equal(view.state().lastHidden.reason, 'browser-closed');
});

test('showing is refused, with the reason and nothing left running, when it cannot be done safely', { skip: linuxOnly }, async t => {
  // A server that opened a TCP port anyway is stopped.
  {
    const { view, spawned } = await viewFixture(t, { listeners: async () => ['00000000:170C'] });
    await assert.rejects(view.show(), /opened a network port \(00000000:170C\).*was stopped\. Nothing was shown/);
    assert.equal(spawned.length, 1, 'no viewer was started');
    assert.notEqual(spawned[0].child.signalCode, null);
    assert.equal(view.state().visible, false);
  }
  // A refused password.
  {
    const { view, spawned } = await viewFixture(t, { standIns: { viewerLog: ' CConn: Authentication failure: Authentication failure\n' } });
    await assert.rejects(view.show(), /could not connect: .*Authentication failure/);
    for (const { child } of spawned) assert.notEqual(child.signalCode, null);
  }
  // A viewer that cannot open the person's display.
  {
    const { view } = await viewFixture(t, { standIns: { viewerLog: " Can't open display: :171\n" } });
    await assert.rejects(view.show(), /Can't open display/);
  }
  // No person's screen, or a remote one: the browser is not even asked for.
  {
    const { view, asked, spawned } = await viewFixture(t, { person: { wayland: 'wayland-0' } });
    await assert.rejects(view.show(), /Wayland without an X11/);
    assert.deepEqual(asked, []);
    assert.equal(spawned.length, 0);
  }
  // A server that never makes its socket.
  {
    const { view } = await viewFixture(t, { standIns: { listen: false }, connectTimeoutMs: 300 });
    await assert.rejects(view.show(), /did not open its private socket/);
  }
  // TigerVNC not installed: the packages are named, installing them is the person's decision.
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-view-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const view = createBrowserView({ runtimeRoot: root, personDisplay: () => ({ display: ':171' }), privateDisplay: async () => assert.fail('not asked'),
      findPrograms: async () => ({ server: null, viewer: '/usr/bin/xtigervncviewer' }) });
    await assert.rejects(view.show(), /tigervnc-scraping-server and tigervnc-viewer\. The scraping server is not installed in \/usr\/bin, \/usr\/local\/bin, \/bin\. Nothing was shown; the browser keeps running hidden\. Installing software is the person's decision\./);
  }
  // Showing the browser to the display it is on.
  {
    const { view } = await viewFixture(t, { person: { display: ':150' } });
    await assert.rejects(view.show(), /same display/);
  }
  // After close, nothing more is shown.
  {
    const { view } = await viewFixture(t);
    await view.close();
    await assert.rejects(view.show(), /shutting down/);
  }
  // The browser closing while a showing is still starting: it does not appear afterwards.
  {
    let view;
    const fixture = await viewFixture(t, { view: { privateDisplay: async () => { await view.release('browser-closed'); return { display: ':150', xauthority: '/sim/private.auth' }; } } });
    view = fixture.view;
    await assert.rejects(view.show(), /closed while it was being shown/);
    assert.equal(view.state().visible, false);
    for (const { child } of fixture.spawned) assert.notEqual(child.signalCode, null, 'both programs were stopped');
  }
  // A program that cannot be started at all (removed after it was found): refused at once, nothing waits for it.
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-view-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const view = createBrowserView({ runtimeRoot: root, personDisplay: () => ({ display: ':171' }), privateDisplay: async () => ({ display: ':150', xauthority: '/sim/a' }),
      programs: { server: '/nonexistent/toolsengine-test/x0vncserver', viewer: '/nonexistent/toolsengine-test/vncviewer' }, connectTimeoutMs: 20000 });
    const started = Date.now();
    await assert.rejects(view.show(), /The view server stopped before it listened/);
    assert.ok(Date.now() - started < 5000, 'not left waiting for the connection timeout');
    assert.deepEqual(await fs.readdir(root), [], 'its folder was removed');
  }
});

test('TigerVNC is looked for in the system folders only, and other programs of the same name are not used', async () => {
  const seen = [];
  const found = await findViewPrograms({
    folders: ['/usr/bin', '/usr/local/bin'],
    exists: file => ['/usr/bin/x0vncserver', '/usr/local/bin/X0tigervnc', '/usr/bin/vncviewer', '/usr/local/bin/xtigervncviewer'].includes(file),
    probe: async (file, kind) => { seen.push(file); return file !== '/usr/bin/x0vncserver' && file !== '/usr/bin/vncviewer'; },
  });
  assert.deepEqual(found, { server: '/usr/local/bin/X0tigervnc', viewer: '/usr/local/bin/xtigervncviewer' });
  assert.ok(seen.every(file => !file.includes('node_modules') && /^\/usr\/(local\/)?bin\//.test(file)));
  assert.deepEqual(await findViewPrograms({ folders: ['/usr/bin'], exists: () => false }), { server: null, viewer: null });
});

test('the three tools are reviewable: show and hide change only the person\'s screen, visibility only reads', async () => {
  const calls = [];
  const view = { show: async args => { calls.push(['show', args]); return { visible: true }; }, hide: async reason => { calls.push(['hide', reason]); return { visible: false }; }, state: () => ({ visible: false, lastHidden: null }) };
  const tools = browserViewTools(view);
  assert.deepEqual(tools.map(tool => tool.name), ['browser.show', 'browser.hide', 'browser.visibility']);
  for (const tool of tools) {
    const { handler, ...descriptor } = tool;
    assertReviewable(JSON.parse(JSON.stringify(descriptor)));
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.annotations.openWorldHint, false);
  }
  assert.deepEqual(tools.map(tool => tool.annotations.readOnlyHint), [false, false, true]);
  const [show, hide, visibility] = tools;
  assert.match(show.description, /same tabs, pages, cookies and sign-ins/);
  assert.match(show.description, /no network port is opened and the clipboard is not shared/);
  assert.match(show.description, /Unix socket/);
  assert.match(hide.description, /keeps running hidden/);
  assert.deepEqual(Object.keys(show.inputSchema.properties), ['viewOnly']);
  await show.handler({ viewOnly: true }, {});
  await hide.handler({});
  assert.deepEqual(await visibility.handler({}), { visible: false, lastHidden: null });
  assert.deepEqual(calls, [['show', { viewOnly: true, signal: undefined }], ['hide', 'browser.hide']]);
  const failing = browserViewTools({ show: async () => { throw new Error('no display'); } });
  await assert.rejects(failing[0].handler({}, {}), /^Error: browser\.show: no display$/);
  assert.match(browserViewTools(view, { subject: 'the hidden Firefox window' })[1].description, /The hidden Firefox window keeps running hidden/);
});

test('--private-display is a Linux option for ToolsEngine\'s own Chromium, refused with other modes and in the plugin profile', { skip: linuxOnly }, async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-private-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const base = ['--workspace', workspace, '--private-display'];
  assert.equal((await parseConfig(base)).privateDisplay, true);
  assert.equal((await parseConfig([...base, '--browser-channel', 'chrome'])).privateDisplay, true);
  await assert.rejects(parseConfig([...base, '--headed']), /Choose --headed .* or --private-display/);
  await assert.rejects(parseConfig([...base, '--cdp-endpoint', 'http://127.0.0.1:9222']), /only to a browser that ToolsEngine starts itself/);
  await assert.rejects(parseConfig([...base, '--browser-extension']), /only to a browser that ToolsEngine starts itself/);
  await assert.rejects(parseConfig([...base, '--firefox-hidden']), /already runs Firefox on a private display/);
  await assert.rejects(parseConfig([...base, '--no-browser']), /cannot be combined/);
  assert.throws(() => assertPluginProfile({ pluginProfile: 'openai', browser: false, privateDisplay: true }), /permits only scoped files and public web/);
});

test('status says the browser is on a private display, hidden until shown, and whether it is shown now; the instructions say when to show it', { skip: linuxOnly }, async t => {
  const status = browserCapabilityStatus({ privateDisplay: true, headless: true }, true);
  assert.equal(status.headless, false);
  assert.equal(status.browserWindowMode, 'private-display');
  assert.equal(status.browserWindowVisibility, 'hidden-until-shown');
  assert.equal(status.browserUsesVisibleScreen, false);
  assert.equal(status.browserMode, 'isolated');
  assert.equal(browserCapabilityStatus({ privateDisplay: true, profileDir: 'configured' }, true).browserMode, 'dedicated-persistent');
  assert.match(serverInstructions({ browser: 'temporary', desktop: false, view: true }), new RegExp(VIEW_INSTRUCTIONS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(serverInstructions({ browser: 'temporary', desktop: false }), /browser\.show/);
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-private-engine-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  // No browser starts until a browser tool runs.
  const engine = await createToolsEngine({ workspace, headless: true, privateDisplay: true, browserExecutable: '/nonexistent/never-launch' });
  t.after(() => engine.close());
  const names = engine.tools.map(tool => tool.name);
  for (const name of ['browser.show', 'browser.hide', 'browser.visibility']) assert.ok(names.includes(name), name);
  for (const { handler, ...descriptor } of engine.tools.filter(tool => ['browser.show', 'browser.hide', 'browser.visibility'].includes(tool.name)))
    assertReviewable(JSON.parse(JSON.stringify(descriptor)));
  const reported = JSON.parse((await engine.call('system.status', {})).content[0].text);
  assert.deepEqual(reported.browserView, { visible: false, lastHidden: null });
  assert.equal(reported.browserWindowMode, 'private-display');
  const visibility = await engine.call('browser.visibility', {});
  assert.deepEqual(JSON.parse(visibility.content[0].text), { visible: false, lastHidden: null });
  // Without the option none of the three is offered.
  const plain = await createToolsEngine({ workspace, headless: true, browserExecutable: '/nonexistent/never-launch' });
  t.after(() => plain.close());
  assert.ok(!plain.tools.some(tool => /^browser\.(show|hide|visibility)$/.test(tool.name)));
  assert.equal(JSON.parse((await plain.call('system.status', {})).content[0].text).browserView, undefined);
});

test('hidden Firefox offers the three tools beside its browser tools, and shows only its own profile\'s private display', { skip: linuxOnly }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-firefox-view-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const profile = path.join(home, 'profile');
  await fs.mkdir(profile, { mode: 0o700 });
  const cookie = path.join(profile, '.toolsengine-xauthority-0123456789abcdef');
  let answer;
  const helper = new EventEmitter();
  helper.stdin = new PassThrough(); helper.stdout = new PassThrough(); helper.stderr = new PassThrough(); helper.kill = () => {};
  const ops = [];
  let buffer = '';
  helper.stdin.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))); buffer = buffer.slice(buffer.indexOf('\n') + 1);
      ops.push(request.op);
      helper.stdout.write(JSON.stringify({ id: request.id, result: request.op === 'display' ? answer : [] }) + '\n');
    }
  });
  const bridge = await createFirefoxBrowserBridge({ visibleDisplay: ':0', agentProfileDir: profile, home }, {
    spawnHelper: () => helper, personDisplay: { display: ':0', xauthority: '/sim/user.auth' },
    viewPrograms: { server: '/stand-in/server', viewer: '/stand-in/viewer' },
  });
  t.after(() => bridge.close());
  await fs.writeFile(cookie, xauthorityEntry(90, Buffer.alloc(16, 1)), { mode: 0o600 });
  // The browser tools are the same as before, none of them on the visible screen.
  assert.ok(!bridge.tools.some(tool => /^browser\.(show|hide|visibility)$/.test(tool.name)));
  assert.deepEqual(bridge.viewTools.map(tool => tool.name), ['browser.show', 'browser.hide', 'browser.visibility']);
  for (const tool of bridge.viewTools) assert.match(tool.description, /hidden Firefox window/);
  // A display the helper names must be this profile's own, not the person's.
  answer = { display: ':0', xauthority: cookie };
  const show = bridge.viewTools[0];
  // The stand-in programs are not started for a refused display.
  await assert.rejects(show.handler({}, {}), /could not be identified/);
  answer = { display: ':90', xauthority: path.join(home, 'elsewhere', '.toolsengine-xauthority-0123456789abcdef') };
  await assert.rejects(show.handler({}, {}), /could not be identified/);
  assert.deepEqual(ops, ['windows', 'display', 'windows', 'display'], 'showing starts Firefox first');
});
