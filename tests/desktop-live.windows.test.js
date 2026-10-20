// The four Windows desktop tools against real windows, through real stdio MCP.
//
// Opt-in: set TOOLSENGINE_DESKTOP_LIVE=1 on Windows. The test opens two
// native WinForms windows of its own, works only on those, and ends both processes.
// It never selects, inspects, captures or acts on any other window. Listing
// windows is how the tool works, so the list of visible windows passes through
// this process; the test reads only its own rows and prints none of the others.
// The last test moves the real mouse cursor into the test's own fixture window.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const live = process.platform === 'win32' && process.env.TOOLSENGINE_DESKTOP_LIVE === '1';
const options = { skip: live ? false : 'set TOOLSENGINE_DESKTOP_LIVE=1 on Windows to open test windows', timeout: 180000 };
// Hexadecimal, so the name cannot contain a protected word by accident.
const unique = randomBytes(4).toString('hex');
const ordinaryName = `te-probe-${unique}.txt`;
const protectedName = `te-confirm-${unique}.txt`;
const firstText = `ToolsEngine desktop probe ${unique}`;
let client, workspace, stderr = '';
const windows = [];

const textOf = result => (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const call = (name, args = {}) => client.callTool({ name, arguments: args });
async function ok(name, args = {}) {
  const result = await call(name, args);
  // On failure print the tool's own sentence only, never a window list.
  assert.notEqual(result.isError, true, `${name} ${JSON.stringify(Object.keys(args))} failed: ${textOf(result).slice(0, 300)}`);
  return result;
}
async function myWindow() {
  const listed = JSON.parse(textOf(await ok('desktop.inspect')));
  const mine = listed.windows.filter(window => window.label.includes(unique));
  return { listed, mine };
}
function powershell(script) {
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
// Moves only the window of the fixture process this test started.
function placeOwnWindow(pid, half) {
  return powershell(`$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class TestWindow { [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int height, uint flags); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command); }'
$handle = (Get-Process -Id ${pid}).MainWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'The test Notepad has no window.' }
$area = [System.Windows.Forms.Screen]::FromHandle($handle).WorkingArea
$null = [TestWindow]::ShowWindow($handle, 9)
$half = [int][Math]::Floor($area.Width / 2)
$x = if ('${half}' -eq 'right') { $area.Left + $half + 20 } else { $area.Left + 20 }
if (![TestWindow]::SetWindowPos($handle, [IntPtr]::Zero, $x, $area.Top + 20, $half - 60, [int][Math]::Floor($area.Height / 2), 0x14)) { throw 'The test Notepad could not be moved.' }
[Console]::WriteLine('placed')`);
}

before(async () => {
  if (!live) return;
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-desktop-live-')));
  const executable = path.join(workspace, 'te-desktop-fixture.exe');
  const source = fileURLToPath(new URL('./support/desktop-fixture.cs', import.meta.url));
  const literal = value => "'" + value.replaceAll("'", "''") + "'";
  powershell(`$ErrorActionPreference = 'Stop'
Add-Type -Path ${literal(source)} -ReferencedAssemblies System.Windows.Forms,System.Drawing -OutputAssembly ${literal(executable)} -OutputType WindowsApplication`);
  for (const [name, text] of [[ordinaryName, firstText], [protectedName, 'Protected title test.']]) {
    windows.push(spawn(executable, [name, text], { stdio: 'ignore' }));
  }
  // Wait until both test windows exist.
  for (const child of windows) {
    const deadline = Date.now() + 20000;
    for (;;) {
      const state = powershell(`$p = Get-Process -Id ${child.pid} -ErrorAction SilentlyContinue; if ($p -and $p.MainWindowHandle -ne [IntPtr]::Zero) { 'ready' } else { 'waiting' }`);
      if (state === 'ready') break;
      assert.ok(Date.now() < deadline, 'a test fixture window did not appear');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  // A starting window can take the keyboard focus a moment after it appears.
  await new Promise(resolve => setTimeout(resolve, 2000));
  placeOwnWindow(windows[0].pid, 'right');
  const home = os.userInfo().homedir;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--no-browser',
      '--desktop-profile-root', home, '--desktop-left-half'],
    cwd: workspace, stderr: 'pipe', env: { ...process.env, TEMP: os.tmpdir(), TMP: os.tmpdir() } });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'desktop-live-acceptance', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  for (const child of windows) { try { child.kill(); } catch {} }
  if (workspace) await fs.rm(workspace, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
});

test('the desktop tools are offered with their titles when the desktop is switched on', options, async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.filter(tool => tool.name.startsWith('desktop.')).map(tool => tool.name).sort(), ['desktop.act', 'desktop.capture', 'desktop.inspect', 'desktop.pointer']);
  for (const tool of tools) assert.ok(tool.title && tool.annotations.title === tool.title, tool.name);
  const status = JSON.parse(textOf(await ok('system.status')));
  assert.deepEqual({ desktopEnabled: status.desktopEnabled, desktopLeftHalf: status.desktopLeftHalf, browserEnabled: status.browserEnabled }, { desktopEnabled: true, desktopLeftHalf: true, browserEnabled: false });
});

test('desktop.inspect lists the test window, and withholds the one with a protected title while naming the word', options, async () => {
  const { listed, mine } = await myWindow();
  assert.equal(mine.length, 1, 'exactly one of the two test windows may be listed');
  assert.equal(mine[0].label, ordinaryName);
  assert.equal(mine[0].application.toLowerCase(), 'te-desktop-fixture');
  assert.ok(!listed.windows.some(window => window.label.includes('te-confirm-')), 'the window titled with "confirm" must not be listed');
  assert.ok(listed.withheldByProtectedRule, 'the result must say that the rule withheld a window');
  assert.ok(listed.withheldByProtectedRule.windows >= 1);
  assert.ok(listed.withheldByProtectedRule.matchedTerms.some(matched => matched.term === 'confirm' && matched.insideLongerWord === false),
    `matched words: ${JSON.stringify(listed.withheldByProtectedRule.matchedTerms)}`);
  assert.ok(!JSON.stringify(listed.withheldByProtectedRule).includes(unique), 'the withheld title must not be repeated');
});

test('desktop.inspect reads the controls and, on request, the text of the test window', options, async () => {
  const { mine } = await myWindow();
  const plain = JSON.parse(textOf(await ok('desktop.inspect', { windowId: mine[0].id })));
  assert.ok(plain.controls.length > 0);
  assert.ok(!plain.controls.some(control => Object.hasOwn(control, 'text')), 'text is returned only when asked for');
  const withText = JSON.parse(textOf(await ok('desktop.inspect', { windowId: mine[0].id, includeText: true })));
  const field = withText.controls.find(control => typeof control.text === 'string' && control.text.includes(unique));
  assert.ok(field, `no control returned the file text; control types: ${withText.types}`);
  assert.equal(field.text, firstText);
  assert.ok(field.actions.includes('type'));
});

test('desktop.act types into the test window and the new text can be read back', options, async () => {
  const locate = async () => {
    const { mine } = await myWindow();
    const inspected = JSON.parse(textOf(await ok('desktop.inspect', { windowId: mine[0].id, includeText: true })));
    return { mine, field: inspected.controls.find(control => typeof control.text === 'string' && control.text.includes(unique)) };
  };
  let { mine, field } = await locate();
  const typed = `Typed through desktop.act ${unique} `;
  // The ordinary value field replaces its contents through UI Automation.
  // Any focus refusal must leave its previous text intact.
  let result = await call('desktop.act', { kind: 'type', targetId: field.id, text: typed });
  if (result.isError) {
    assert.match(textOf(result), /^(?:Focus changed before input\. Nothing was sent\.|Windows did not focus the confirmed window\. No text was sent\.|The confirmed field did not receive focus\. No text was sent\.|\[FOCUS_[A-Z_]+\] [^\r\n]*No text was sent\.(?: Capture the confirmed window again; if unobscured, choose a neutral point from the new image with desktop\.pointer click, then verify focus\.)?(?: HRESULT 0x[0-9A-F]{8}\.)?)$/);
    ({ mine, field } = await locate());
    assert.equal(field.text, firstText, 'a refused attempt must leave the text alone');
    result = await call('desktop.act', { kind: 'type', targetId: field.id, text: typed });
  }
  assert.notEqual(result.isError, true, `desktop.act type failed twice: ${textOf(result).slice(0, 200)}`);
  assert.equal(JSON.parse(textOf(result)).status, 'completed');
  // The fixture marks an edited field with "*" in its title. A window whose title
  // changed is a different target: the old id is refused, with the reason,
  // and the window must be listed again.
  const old = await call('desktop.inspect', { windowId: mine[0].id, includeText: true });
  const renamed = (await myWindow()).mine;
  assert.equal(renamed.length, 1);
  if (renamed[0].label !== mine[0].label) {
    assert.equal(old.isError, true);
    assert.equal(textOf(old), 'The window changed, closed or is not permitted. Inspect again.');
  }
  const again = JSON.parse(textOf(await ok('desktop.inspect', { windowId: renamed[0].id, includeText: true })));
  const current = again.controls.find(control => typeof control.text === 'string' && control.text.includes(typed));
  assert.ok(current, 'the typed text was not found in the window');
  assert.equal(current.text, typed, 'typing into a value field replaces its content');
  // A stale control id and a filesystem path as text are refused.
  const stale = await call('desktop.act', { kind: 'type', targetId: field.id, text: 'second' });
  assert.equal(stale.isError, true);
  const refused = await call('desktop.act', { kind: 'type', targetId: current.id, text: 'C:\\Windows\\System32' });
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Filesystem paths/);
});

test('desktop.capture returns a picture of the test window', options, async () => {
  const { mine } = await myWindow();
  const result = await ok('desktop.capture', { windowId: mine[0].id });
  const image = result.content.find(part => part.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const size = JSON.parse(textOf(result));
  assert.deepEqual({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, size);
  assert.ok(size.width > 50 && size.width <= 1280 && size.height > 50 && size.height <= 1280);
});

test('desktop.pointer is refused, with the reason, while the window is outside the left half', options, async () => {
  placeOwnWindow(windows[0].pid, 'right');
  const { mine } = await myWindow();
  await ok('desktop.capture', { windowId: mine[0].id });
  const refused = await call('desktop.pointer', { windowId: mine[0].id, kind: 'click', x: 60, y: 120 });
  assert.equal(refused.isError, true);
  assert.equal(textOf(refused), '[WINDOW_OUTSIDE_LEFT_HALF] The window is outside the left half. Use desktop.act with kind focus on this window, then desktop.capture. Choose coordinates from the new image before trying again. No pointer input was sent.');
  // The picture is spent by the refused attempt.
  const second = await call('desktop.pointer', { windowId: mine[0].id, kind: 'click', x: 60, y: 120 });
  assert.equal(second.isError, true);
  assert.match(textOf(second), /Capture this window again/);
});

test('desktop.act focus places the test window in the left half, and desktop.pointer then clicks inside it', options, async () => {
  let { mine } = await myWindow();
  const focused = JSON.parse(textOf(await ok('desktop.act', { kind: 'focus', windowId: mine[0].id })));
  assert.equal(focused.status, 'completed');
  ({ mine } = await myWindow());
  const captured = await ok('desktop.capture', { windowId: mine[0].id });
  const size = JSON.parse(textOf(captured));
  // The middle of the window is its text area.
  const clicked = JSON.parse(textOf(await ok('desktop.pointer', { windowId: mine[0].id, kind: 'click', x: Math.floor(size.width / 2), y: Math.floor(size.height / 2) })));
  assert.equal(clicked.status, 'completed');
});

test('the server wrote nothing to stderr during the desktop calls', options, () => {
  assert.equal(stderr, '');
});
