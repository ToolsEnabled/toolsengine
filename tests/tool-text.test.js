// What the tool descriptions and the server instructions say has to be true
// in the mode the server was started in: its own browser with a temporary
// profile, its own browser with a dedicated profile (--profile-dir), a
// browser attached at startup (--cdp-endpoint), or no browser at all; with
// and without the Windows desktop tools.
//
// No browser is started here: descriptors are built without one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createToolsEngine } from '../src/server.js';
import * as serverModule from '../src/server.js';
import * as desktopModule from '../src/desktop.js';
import * as browserModule from '../src/browser.js';

async function toolsFor(t, extra) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-text-')));
  const engine = await createToolsEngine({ workspace, headless: true, ...(extra.profileDir === true ? { ...extra, profileDir: path.join(workspace, 'profile') } : extra) });
  t.after(async () => { await engine.close(); await fs.rm(workspace, { recursive: true, force: true }); });
  return new Map(engine.tools.map(tool => [tool.name, tool]));
}
const browserTools = tools => [...tools.values()].filter(tool => tool.name.startsWith('browser.'));

test('browser tools say which browser they act in, and with which profile', async t => {
  const temporary = await toolsFor(t, {});
  const dedicated = await toolsFor(t, { profileDir: true });
  const attached = await toolsFor(t, { cdpEndpoint: 'http://127.0.0.1:9' });

  for (const tool of browserTools(temporary)) {
    assert.match(tool.description, /ToolsEngine's own browser with a temporary profile, separate from the person's everyday browser and its sign-ins\.$/, tool.name);
  }
  // A dedicated profile is kept and holds the sign-ins made in it: the text
  // for a temporary profile would be false there.
  for (const tool of browserTools(dedicated)) {
    assert.match(tool.description, /dedicated profile chosen at startup: cookies and sign-ins made in it are kept between sessions/, tool.name);
    assert.doesNotMatch(tool.description, /temporary profile|separate from the person's everyday browser and its sign-ins/, tool.name);
  }
  for (const tool of browserTools(attached)) {
    assert.match(tool.description, /already-running browser chosen at startup: it acts in that browser's open tabs with its signed-in sessions\.$/, tool.name);
    assert.doesNotMatch(tool.description, /temporary profile|dedicated profile|ToolsEngine's own browser/, tool.name);
  }
});

test('browser.close says what becomes of cookies and sign-ins in each mode, in its text and in its answer', async t => {
  const temporary = await toolsFor(t, {});
  const dedicated = await toolsFor(t, { profileDir: true });
  const attached = await toolsFor(t, { cdpEndpoint: 'http://127.0.0.1:9' });
  assert.match(temporary.get('browser.close').description, /discards the session's cookies and sign-ins\. The next browser tool call starts a new, empty browser\./);
  assert.match(dedicated.get('browser.close').description, /The dedicated profile keeps its cookies and sign-ins: the next browser tool call starts the browser again with them\./);
  assert.doesNotMatch(dedicated.get('browser.close').description, /discards|new, empty browser/);
  assert.equal(attached.has('browser.close'), false);
  // Closing before anything was opened starts no browser; the answer is the tool's own sentence.
  const said = async tools => (await tools.get('browser.close').handler({})).content[0].text;
  assert.match(await said(temporary), /The next browser tool call starts a new, empty browser\.$/);
  assert.match(await said(dedicated), /Its dedicated profile keeps its cookies and sign-ins; the next browser tool call starts the browser again with them\.$/);
  assert.doesNotMatch(await said(dedicated), /empty browser/);
});

test('downloads are stated where a download can start: what is saved, where, and that a same-named file is replaced', async t => {
  const stated = /A download that the page starts is saved into artifacts\/toolsengine in the workspace with a unique name; existing files are preserved\./;
  // Every tool that loads a page or gives the page input: the page decides
  // what that leads to. A new tab at an address, Enter after typing, going
  // back, a changed option and an answered dialog can start a download as
  // well as a click can.
  const canStart = ['browser.navigate', 'browser.navigate_back', 'browser.click', 'browser.type', 'browser.fill_form', 'browser.press_key',
    'browser.select_option', 'browser.hover', 'browser.drag', 'browser.tabs', 'browser.handle_dialog', 'browser.file_upload'];
  assert.deepEqual(browserModule.CAN_START_DOWNLOAD?.map(name => name.replace('browser_', 'browser.')), canStart);
  // The ones that only read, wait, save what is shown or resize, and browser.close.
  const cannot = ['browser.snapshot', 'browser.find', 'browser.wait_for', 'browser.take_screenshot', 'browser.pdf_save', 'browser.resize', 'browser.close'];
  for (const mode of [{}, { profileDir: true }]) {
    const tools = await toolsFor(t, mode);
    assert.deepEqual(browserTools(tools).map(tool => tool.name).sort(), [...canStart, ...cannot].sort(), 'every browser tool is on one of the two lists');
    for (const name of canStart) assert.match(tools.get(name).description, stated, name);
    for (const name of cannot) assert.doesNotMatch(tools.get(name).description, /download/i, name);
  }
  // An attached browser keeps its own way with downloads, and the text says
  // so: where the download goes, and that nothing is copied into the
  // workspace. tests/browser-modes.integration.test.js shows that it is true.
  const attached = await toolsFor(t, { cdpEndpoint: 'http://127.0.0.1:9' });
  for (const tool of browserTools(attached)) assert.doesNotMatch(tool.description, /saved into artifacts\/toolsengine/, tool.name);
  for (const name of canStart)
    assert.match(attached.get(name).description, /A download that the page starts is left to that browser: it goes where that browser saves its downloads, as if the person had started it, and nothing is copied into the workspace\./, name);
});

test('attaching leaves the running browser\'s own download behaviour alone', () => {
  // The option of the pinned browser library that keeps it from telling an
  // attached browser where to save downloads.
  assert.deepEqual(browserModule.ATTACH_OPTIONS, { noDefaults: true });
  assert.ok(Object.isFrozen(browserModule.ATTACH_OPTIONS));
});

test('capability.find names only tools that this connection offers', async t => {
  for (const mode of [{}, { profileDir: true }, { cdpEndpoint: 'http://127.0.0.1:9' }, { browser: false }]) {
    const tools = await toolsFor(t, mode);
    const find = tools.get('capability.find');
    const named = JSON.stringify([find.description, find.inputSchema]).match(/\b(?:browser|workspace|web|system|capability|desktop)\.[a-z_]+\b/g) || [];
    assert.ok(named.length > 0, 'the text gives an example');
    for (const name of named) assert.ok(tools.has(name), `capability.find names ${name}, which is not offered with ${JSON.stringify(mode)}`);
  }
});

test('the server instructions describe the connection as it is', async t => {
  const { serverInstructions } = serverModule;
  assert.equal(typeof serverInstructions, 'function', 'src/server.js must build the instructions from the mode');
  const all = {};
  for (const browser of ['temporary', 'dedicated', 'attached', 'none']) for (const desktop of [false, true]) all[`${browser}/${desktop}`] = serverInstructions({ browser, desktop });
  for (const [mode, text] of Object.entries(all)) {
    assert.ok(text.length > 200 && text.length < 2400, `${mode}: ${text.length} characters`);
    assert.match(text, /untrusted data/, mode);
    assert.match(text, /system\.status/, mode);
    // Names that mean nothing outside the place this was built.
    assert.doesNotMatch(text, /Fleet|LIVE/, mode);
    // Underscore names of the browser dependency are not offered.
    assert.doesNotMatch(text, /\bbrowser_[a-z_]+\b/, mode);
  }
  assert.match(all['temporary/false'], /own browser with a temporary profile: it has none of the person's ordinary browser sign-ins/);
  assert.match(all['dedicated/false'], /dedicated profile that is kept between sessions: sign-ins made in it earlier are still there/);
  assert.match(all['attached/false'], /already-running browser chosen at startup, in its open tabs and with its signed-in sessions/);
  assert.match(all['none/false'], /No browser tools are offered in this connection\./);
  // "Does not inherit ordinary browser logins" was sent in every mode. It is false for two of them.
  for (const mode of ['dedicated/false', 'attached/false', 'attached/true', 'none/false'])
    assert.doesNotMatch(all[mode], /none of the person's ordinary browser sign-ins|do not inherit/, mode);
  // Downloads only where the server's own browser saves them.
  for (const mode of ['temporary/false', 'dedicated/true']) assert.match(all[mode], /downloads use unique names and preserve existing files/, mode);
  // An attached browser keeps its downloads to itself, and that is said.
  for (const mode of ['attached/false', 'attached/true']) {
    assert.match(all[mode], /A download that a page starts there is left to that browser and is not copied into the workspace\./, mode);
    assert.doesNotMatch(all[mode], /saved there too/, mode);
  }
  for (const mode of ['none/false', 'none/true']) assert.doesNotMatch(all[mode], /download/, mode);
  // Desktop tools and their rule are described only when they are offered.
  for (const browser of ['temporary', 'none']) {
    assert.match(all[`${browser}/true`], /protected word such as password, sign in or confirm/);
    assert.doesNotMatch(all[`${browser}/false`], /desktop|protected word/i);
  }
  assert.throws(() => serverInstructions({ browser: 'something else', desktop: false }));
  const signIn = serverInstructions({ browser: 'dedicated', desktop: true, desktopAllowSignIn: true });
  assert.match(signIn, /Owner-enabled browser sign-in is active/);
  assert.match(signIn, /Other protected words and password-field exclusions still apply/);
  assert.doesNotMatch(signIn, /there is no setting|does not sign in/);

  // A browser that was started without its sandbox is said to be so: no
  // tool description shows it, and the assistant decides which pages to open.
  for (const browser of ['temporary', 'dedicated']) {
    const off = serverInstructions({ browser, desktop: false, sandbox: false });
    assert.match(off, /started with --no-browser-sandbox, by the person's choice: its browser runs without Chromium's sandbox, so a page that exploits a fault in the browser can act as the person's account\./, browser);
    assert.match(off, /Open only addresses the person asked for or that their task needs\./, browser);
    assert.equal(serverInstructions({ browser, desktop: false, sandbox: true }), all[`${browser}/false`], 'with the sandbox on, nothing is added');
  }
  for (const text of Object.values(all)) assert.doesNotMatch(text, /sandbox/);
  // Not said of a browser the server did not start, or with no browser.
  for (const browser of ['attached', 'none']) assert.doesNotMatch(serverInstructions({ browser, desktop: false, sandbox: false }), /sandbox/, browser);
  const unsandboxed = serverInstructions({ browser: 'temporary', desktop: false, sandbox: false });

  // What a client actually receives at the handshake, with and without a browser.
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-text-')));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  for (const [args, expected] of [[[], all['temporary/false']], [['--no-browser'], all['none/false']], [['--profile-dir', path.join(workspace, 'profile')], all['dedicated/false']],
    [['--no-browser-sandbox'], unsandboxed]]) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, ...args], cwd: workspace, stderr: 'pipe' });
    const client = new Client({ name: 'toolsengine-text', version: '1.0.0' });
    await client.connect(transport);
    try { assert.equal(client.getInstructions(), expected, args.join(' ') || 'default'); }
    finally { await client.close(); }
  }
});

test('desktop.inspect names the programs it leaves out, and the helper leaves out exactly those', async () => {
  const { EXCLUDED_PROGRAMS, desktopToolDescriptors } = desktopModule;
  assert.ok(Array.isArray(EXCLUDED_PROGRAMS), 'src/desktop.js must list the excluded programs');
  const helper = await fs.readFile(new URL('../native/accessibility-desktop.ps1', import.meta.url), 'utf8');
  const pattern = /\$blockedNames = '\^\(([^']+)\)\$'/.exec(helper)?.[1];
  assert.ok(pattern, 'the excluded-program rule was not found in the helper');
  // The text and the guard are the same list.
  assert.deepEqual(pattern.split('|'), EXCLUDED_PROGRAMS.map(program => program.pattern));
  // PowerShell matches names without regard to letter case.
  const excluded = name => new RegExp(`^(${pattern})$`, 'i').test(name);
  for (const name of ['cmd', 'powershell', 'powershell_ise', 'PowerShell_ISE', 'pwsh', 'wt', 'WindowsTerminal', 'conhost', 'explorer', 'TOTALCMD64', 'regedit', 'mmc', 'Taskmgr',
    'consent', 'CredentialUIBroker', 'LogonUI', 'electron', 'ToolsEnabled', 'toolsenabled-live'])
    assert.ok(excluded(name), `${name} must be left out`);
  // Other terminal programs are not covered by this rule, and the text must not say they are.
  for (const name of ['mintty', 'Code', 'ConEmu64', 'putty', 'alacritty', 'notepad', 'chrome', 'powershell_ise_2']) assert.ok(!excluded(name), name);

  const inspect = desktopToolDescriptors().find(tool => tool.name === 'desktop.inspect').description;
  assert.doesNotMatch(inspect, /never listed/, '"never" promised more than a list of program names can keep');
  assert.match(inspect, /Windows of these programs are not listed/);
  for (const program of EXCLUDED_PROGRAMS) assert.ok(inspect.includes(program.name), `${program.name} is excluded but not named`);
  assert.match(inspect, /PowerShell ISE/);
  assert.match(inspect, /Other terminal programs, for example mintty, ConEmu, PuTTY or the terminal inside an editor, are listed like any other app/);
  // The same for the note that comes back with every window list.
  const adapter = await fs.readFile(new URL('../native/accessibility-desktop.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(adapter, /terminals, file managers and Windows security prompts are never listed/);
  // "System tools and prompts" promised a kind of window. The rule is a list
  // of program names: a system or settings window of any other program is
  // listed and can be acted on, and the note must say that.
  const note = /limitations: '(Same-account visible windows only\.[^']*)'/.exec(adapter)?.[1];
  assert.ok(note, 'the note that comes with a window list was not found');
  assert.doesNotMatch(note, /system tools and prompts/);
  assert.match(note, /a list of program names \(/);
  assert.match(note, /a window of any other program is listed and can be acted on, other terminal programs and other system and settings windows included/);
  // Each excluded program is covered by the note's summary, by its name or by its group.
  const groups = { 'Windows PowerShell': 'the PowerShells', 'PowerShell ISE': 'the PowerShells', 'PowerShell 7': 'the PowerShells',
    'the elevation prompt': 'the elevation, credential and sign-in prompts', 'the Windows credential prompt': 'the elevation, credential and sign-in prompts', 'the sign-in screen': 'the elevation, credential and sign-in prompts' };
  for (const program of EXCLUDED_PROGRAMS) assert.ok(note.includes(groups[program.name] || program.name), `${program.name} is excluded but the note's summary leaves it out`);
});

test('desktop.act says that --desktop-left-half also resizes the window', () => {
  const act = desktopModule.desktopToolDescriptors().find(tool => tool.name === 'desktop.act').description;
  assert.match(act, /--desktop-left-half/);
  assert.match(act, /restored if it was minimised or maximised/);
  assert.match(act, /resized to half the width and the full height of its monitor's work area/);
  assert.doesNotMatch(act, /the window is first moved to the left half of its monitor\./);
});
