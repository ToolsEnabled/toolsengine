import test from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config.js';
import * as configModule from '../src/config.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('explicit workspace and bounded known configuration', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(parseConfig([]), /workspace/);
  await assert.rejects(parseConfig(['--workspace', 'relative']), /absolute/);
  await assert.rejects(parseConfig(['--unsafe']), /Unknown option/);
  const config = await parseConfig(['--workspace', workspace]);
  assert.equal(config.headless, true);
  assert.equal(config.allowLocalNetwork, false);
  await assert.rejects(parseConfig(['--workspace', workspace, '--profile-dir', path.join(workspace, 'profile'), '--cdp-endpoint', 'http://127.0.0.1:9222']), /only one/);
  await assert.rejects(parseConfig(['--extension']), /Unknown option/);
  await assert.rejects(parseConfig(['--workspace', workspace, '--no-browser', '--profile-dir', workspace]), /cannot be combined/);
  // The browser to start is named one way or the other, never both: with
  // both, the channel's executable won and the named file was ignored.
  assert.equal((await parseConfig(['--workspace', workspace, '--browser-executable', '/opt/x/browser'])).browserExecutable, '/opt/x/browser');
  assert.equal((await parseConfig(['--workspace', workspace, '--browser-channel', 'chrome'])).browserChannel, 'chrome');
  await assert.rejects(parseConfig(['--workspace', workspace, '--browser-executable', '/opt/x/browser', '--browser-channel', 'chrome']), /^Error: Choose only one of --browser-executable or --browser-channel\.$/);
});

// A browser attached with --cdp-endpoint is already running: the options that
// choose or start one are refused rather than accepted for nothing, and the
// address is checked at startup, with the reason.
test('--cdp-endpoint is checked at startup and refuses the options for a browser ToolsEngine would start', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const endpoint of ['http://127.0.0.1:9222', 'ws://127.0.0.1:9222/devtools/browser/abc', 'http://localhost:9222', 'http://[::1]:9222'])
    assert.equal((await parseConfig(['--workspace', workspace, '--cdp-endpoint', endpoint, '--headless'])).cdpEndpoint, endpoint, endpoint);
  const loopback = /^Error: A CDP endpoint must be an explicitly configured loopback HTTP or WebSocket address\./;
  for (const endpoint of ['not-a-url', '127.0.0.1:9222', 'http://10.0.0.5:9222', 'https://127.0.0.1:9222', 'http://user:secret@127.0.0.1:9222', 'file:///tmp/x'])
    await assert.rejects(parseConfig(['--workspace', workspace, '--cdp-endpoint', endpoint]), loopback, endpoint);
  await assert.rejects(parseConfig(['--workspace', workspace, '--cdp-endpoint', 'not-a-url']), /Write the full address, for example http:\/\/127\.0\.0\.1:9222\./);
  const noEffect = /^Error: --cdp-endpoint attaches to a browser that is already running: --browser-executable, --browser-channel and --headed have no effect on it\.$/;
  for (const extra of [['--browser-executable', '/opt/x/browser'], ['--browser-channel', 'chrome'], ['--headed']])
    await assert.rejects(parseConfig(['--workspace', workspace, '--cdp-endpoint', 'http://127.0.0.1:9222', ...extra]), noEffect, extra.join(' '));
  assert.equal(typeof configModule.checkCdpEndpoint, 'function');
  assert.throws(() => configModule.checkCdpEndpoint('not-a-url'), loopback);

  // The server itself says the reason, not the URL parser's "Invalid URL".
  const entry = fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url));
  const started = spawnSync(process.execPath, [entry, '--workspace', workspace, '--cdp-endpoint', 'not-a-url'], { encoding: 'utf8', timeout: 30000, input: '' });
  assert.equal(started.status, 1, started.stderr);
  assert.match(started.stderr, /^ToolsEngine: A CDP endpoint must be an explicitly configured loopback HTTP or WebSocket address\. Write the full address/);
  assert.equal(started.stdout, '');
});

test('persistent profiles must be dedicated and paths reject directory links', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const profile = path.join(base, 'dedicated');
  const args = ['--workspace', base, '--profile-dir', profile];
  assert.equal((await parseConfig(args)).profileDir, profile);
  await parseConfig(args);
  const ordinary = path.join(base, 'ordinary');
  await fs.mkdir(ordinary);
  await fs.writeFile(path.join(ordinary, 'ordinary-browser-data'), 'fixture');
  await assert.rejects(parseConfig(['--workspace', base, '--profile-dir', ordinary]), /dedicated/);
  const linked = path.join(base, 'link');
  await fs.symlink(profile, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(parseConfig(['--workspace', linked]), /links or junctions/);
});

// With SELENIUM_REMOTE_URL in its environment the browser library starts the
// browser on a remote Selenium grid: on another machine, outside the sandbox
// and the profile this server arranges, while system.status would still
// describe a local sandboxed browser.
test('a server that offers browser tools does not start with SELENIUM_REMOTE_URL in its environment', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const grid = { SELENIUM_REMOTE_URL: 'http://grid.example.invalid:4444' };
  assert.equal(typeof configModule.refuseRemoteGrid, 'function');
  for (const args of [[], ['--browser-channel', 'chrome'], ['--profile-dir', path.join(workspace, 'profile')], ['--cdp-endpoint', 'http://127.0.0.1:9222'], ['--no-browser-sandbox']])
    await assert.rejects(parseConfig(['--workspace', workspace, ...args], { env: grid }), /SELENIUM_REMOTE_URL is set in the environment ToolsEngine was started with/, args.join(' '));
  // Without browser tools the variable has nothing to act on.
  assert.equal((await parseConfig(['--workspace', workspace, '--no-browser'], { env: grid })).browser, false);
  assert.equal((await parseConfig(['--workspace', workspace], { env: {} })).browser, true);
  assert.equal((await parseConfig(['--workspace', workspace], { env: { SELENIUM_REMOTE_URL: '' } })).browser, true);

  // The server itself: it stops at once, with the reason and what to do, and starts nothing.
  const entry = fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url));
  const started = spawnSync(process.execPath, [entry, '--workspace', workspace], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...grid }, input: '' });
  assert.equal(started.status, 1, started.stderr);
  assert.match(started.stderr, /^ToolsEngine: SELENIUM_REMOTE_URL is set in the environment ToolsEngine was started with\./);
  assert.match(started.stderr, /Remove the variable from this server's environment, or start ToolsEngine with --no-browser\./);
  assert.equal(started.stdout, '');
  assert.deepEqual(await fs.readdir(workspace), [], 'nothing was created in the workspace');
});

// The assistant can write anywhere in the workspace. A workspace that holds
// the program folder would let workspace.write_file rewrite the server's own
// code and the Windows helper, and so would a workspace inside that folder.
test('a --workspace that does not exist is refused in plain words, not with the system error', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const missing = path.join(base, 'nope', 'deeper');
  await assert.rejects(parseConfig(['--workspace', missing, '--no-browser']), error => {
    assert.match(error.message, /^--workspace must name an existing absolute directory\./);
    assert.ok(error.message.includes(missing), error.message);
    assert.doesNotMatch(error.message, /ENOENT|lstat/);
    return true;
  });
  const program = fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url));
  const started = spawnSync(process.execPath, [program, '--workspace', missing, '--no-browser'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /^ToolsEngine: --workspace must name an existing absolute directory\./);
  assert.doesNotMatch(started.stderr, /ENOENT|lstat/);
});

test('the workspace and the program folder may not contain one another', async t => {
  const { PROGRAM_FOLDER, foldersOverlap } = configModule;
  assert.equal(typeof foldersOverlap, 'function', 'src/config.js must refuse a workspace that overlaps the program folder');
  const program = await fs.realpath(PROGRAM_FOLDER);
  assert.equal(program, await fs.realpath(fileURLToPath(new URL('..', import.meta.url))));
  // The program folder itself, the folder above it, and folders inside it.
  for (const workspace of [program, path.dirname(program), path.join(program, 'src'), path.join(program, 'node_modules')])
    await assert.rejects(parseConfig(['--workspace', workspace]), /must not contain one another/, workspace);
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  assert.equal((await parseConfig(['--workspace', outside])).workspace, outside);

  // The server itself refuses to start that way, with the reason.
  const started = spawnSync(process.execPath, [path.join(program, 'bin', 'toolsengine.js'), '--workspace', path.dirname(program)], { encoding: 'utf8', timeout: 30000 });
  assert.equal(started.status, 1);
  assert.match(started.stderr, /^ToolsEngine: --workspace and the ToolsEngine program folder must not contain one another/);

  const at = (...parts) => path.join(path.parse(program).root, ...parts);
  assert.equal(await foldersOverlap(at('home', 'a', 'work'), at('home', 'a', 'ToolsEngine', '1.0', 'app')), false);
  assert.equal(await foldersOverlap(at('home', 'a'), at('home', 'a', 'ToolsEngine', '1.0', 'app')), true);
  assert.equal(await foldersOverlap(at('home', 'a', 'ToolsEngine', '1.0', 'app', 'src'), at('home', 'a', 'ToolsEngine', '1.0', 'app')), true);
  assert.equal(await foldersOverlap(at('home', 'a', 'ToolsEngine', '1.0', 'app'), at('home', 'a', 'ToolsEngine', '1.0', 'app')), true);
  // A folder whose name only begins like the program folder's is another folder.
  assert.equal(await foldersOverlap(at('home', 'a', 'ToolsEngine', '1.0', 'application'), at('home', 'a', 'ToolsEngine', '1.0', 'app')), false);
});

// Comparing paths as text is not enough where one folder has two spellings
// that resolving links does not bring together: a mount that ignores the
// case of letters (a Windows drive seen from Linux, a case-folding or FAT
// file system, a network share), or a second mount of the same folder. The
// folders are also compared by what the file system says they are.
test('a workspace that is the program folder under another spelling, or holds it through a second mount, is refused', async t => {
  const { foldersOverlap } = configModule;
  const at = (...parts) => path.join(path.parse(process.cwd()).root, ...parts);
  // A file system as it would answer: each folder has one identity, whatever it is called.
  const fileSystem = identities => async folder => identities[folder] ?? `distinct:${folder}`;

  // 1. A mount that ignores case: /mnt/c/Tools and /mnt/c/tools are one folder.
  const program = at('mnt', 'c', 'Tools', 'ToolsEngine', '1.0', 'app');
  const sameFolderOtherCase = at('mnt', 'c', 'tools', 'toolsengine', '1.0', 'app');
  const aboveInOtherCase = at('mnt', 'c', 'tools');
  const caseless = fileSystem({
    [at('mnt', 'c')]: 'c:1', [at('mnt', 'c', 'Tools')]: 'c:2', [at('mnt', 'c', 'tools')]: 'c:2',
    [at('mnt', 'c', 'Tools', 'ToolsEngine')]: 'c:3', [at('mnt', 'c', 'tools', 'toolsengine')]: 'c:3',
    [at('mnt', 'c', 'Tools', 'ToolsEngine', '1.0')]: 'c:4', [at('mnt', 'c', 'tools', 'toolsengine', '1.0')]: 'c:4',
    [program]: 'c:5', [sameFolderOtherCase]: 'c:5',
    [at('mnt', 'c', 'Tools', 'ToolsEngine', '1.0', 'app', 'src')]: 'c:6', [at('mnt', 'c', 'tools', 'toolsengine', '1.0', 'app', 'SRC')]: 'c:6',
    [at('mnt', 'c', 'work')]: 'c:7',
  });
  assert.equal(await foldersOverlap(sameFolderOtherCase, program, { identify: caseless }), true, 'the program folder itself, spelled in another case');
  assert.equal(await foldersOverlap(aboveInOtherCase, program, { identify: caseless }), true, 'a folder above it, spelled in another case');
  assert.equal(await foldersOverlap(at('mnt', 'c', 'tools', 'toolsengine', '1.0', 'app', 'SRC'), program, { identify: caseless }), true, 'a folder inside it, spelled in another case');
  assert.equal(await foldersOverlap(at('mnt', 'c', 'work'), program, { identify: caseless }), false, 'another folder of that mount is fine');
  // As text, none of these three has anything to do with the program folder.
  const textOnly = { identify: async () => null };
  for (const workspace of [sameFolderOtherCase, aboveInOtherCase, at('mnt', 'c', 'tools', 'toolsengine', '1.0', 'app', 'SRC')])
    if (process.platform === 'win32') assert.equal(await foldersOverlap(workspace, program, textOnly), true); else await assert.rejects(foldersOverlap(workspace, program, textOnly), /identity/);

  // 2. A second mount: /srv/tools shows the same folder as /opt/tools.
  const mounted = fileSystem({
    [at('opt', 'tools')]: 'd:10', [at('srv', 'tools')]: 'd:10', [at('opt', 'tools', 'app')]: 'd:11', [at('srv', 'tools', 'app')]: 'd:11',
    [at('opt')]: 'd:1', [at('srv')]: 'd:2', [at('srv', 'elsewhere')]: 'd:12',
  });
  assert.equal(await foldersOverlap(at('srv', 'tools'), at('opt', 'tools', 'app'), { identify: mounted }), true, 'the workspace holds the program through the other mount');
  assert.equal(await foldersOverlap(at('srv', 'tools', 'app'), at('opt', 'tools', 'app'), { identify: mounted }), true);
  assert.equal(await foldersOverlap(at('srv', 'elsewhere'), at('opt', 'tools', 'app'), { identify: mounted }), false);
  // A file system that numbers nothing must not make every folder the same folder.
  await assert.rejects(foldersOverlap(at('a', 'work'), at('b', 'app'), { identify: async () => null }), /identity/);

  // 3. On the real file system: two folders side by side are apart, and each is itself.
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, 'one', 'inner'), { recursive: true });
  await fs.mkdir(path.join(base, 'two'));
  assert.equal(await foldersOverlap(path.join(base, 'one'), path.join(base, 'two')), false);
  assert.equal(await foldersOverlap(path.join(base, 'one', 'inner'), path.join(base, 'two')), false);
  assert.equal(await foldersOverlap(path.join(base, 'one'), path.join(base, 'one', 'inner')), true);
});

// --profile-dir inside the workspace is an accepted layout: installs use it.
// What is refused is reaching into that folder with the file tools (tests/workspace.test.js)
// and with uploads and output files (tests/browser.test.js).
test('browser sign-in requires explicit desktop startup selection', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await assert.rejects(parseConfig(['--workspace', workspace, '--desktop-allow-sign-in']), /requires --desktop-profile-root/);
  assert.equal((await parseConfig(['--workspace', workspace])).desktopAllowSignIn, undefined);
  if (process.platform === 'win32') {
    const { userInfo } = await import('node:os');
    const config = await parseConfig(['--workspace', workspace, '--desktop-profile-root', userInfo().homedir, '--desktop-allow-sign-in']);
    assert.equal(config.desktopAllowSignIn, true);
  }
});

test('a dedicated profile inside the workspace is accepted', async t => {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-config-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const config = await parseConfig(['--workspace', workspace, '--profile-dir', path.join(workspace, 'browser-profile')]);
  assert.equal(config.profileDir, path.join(workspace, 'browser-profile'));
});
