// A refusal the Windows helper raises itself must reach the assistant with its
// reason ("Window is outside the left half..."), and nothing Windows or an
// application says may ride along.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { userInfo, tmpdir } from 'node:os';
import { createAccessibilityDesktopAdapter } from '../native/accessibility-desktop.cjs';

const helperPath = new URL('../native/accessibility-desktop.ps1', import.meta.url);
const GENERIC = /^Windows could not safely complete this request\. Inspect before retrying\. Helper line: \d+$/;

function withMockWindows(callback) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const systemRoot = process.env.SystemRoot;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
  process.env.SystemRoot = 'C:\\Windows';
  return Promise.resolve().then(callback).finally(() => {
    Object.defineProperty(process, 'platform', platform);
    if (systemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = systemRoot;
  });
}

test('helper source: every refusal is a fixed sentence, and only refusals leave the catch block', async () => {
  const source = await fs.readFile(helperPath, 'utf8');
  // All raised text remains helper-owned. Stage guards and provider rethrows
  // are rendered only through the tested allowlisted formatters.
  const raises = source.match(/\bthrow\b[^\n]*/g) || [];
  const powershellRaises = raises.filter(line => !/^throw new AccessibilityRefusal\("[^"\\$]+"\);/.test(line)).map(line => line.trim());
  const fixedRaises = new Set(['throw $reason }', 'throw }', 'throw', "throw 'Focus guard declined.' }"]);
  for (const raised of powershellRaises) assert.ok(fixedRaises.has(raised), `untrusted raise: ${raised}`);
  assert.ok(powershellRaises.includes("throw 'Focus guard declined.' }"));
  const refusals = [...source.matchAll(/\bRefuse (\S[^\n]*?)(?= \}|$)/gm)].map(match => match[1]);
  assert.ok(refusals.length >= 36, `found ${refusals.length} refusals`);
  for (const argument of refusals) {
    // A single-quoted literal cannot interpolate.
    assert.ok(/^'[^'$]+'$/.test(argument), `not a fixed sentence: Refuse ${argument}`);
  }
  assert.doesNotMatch(source, /\$geometryDiagnostic/, 'raw rectangles are not returned as diagnostics');
  // Catch block: new stage diagnostics precede the preserved trusted refusal path.
  const handler = source.slice(source.lastIndexOf('} catch {'));
  assert.match(handler, /New-SafeFocusFailure \$script:desktopFailureCode \$script:desktopFailureHResult/);
  assert.match(handler, /New-SafeDesktopFailure \$script:desktopFailureCode/);
  assert.match(handler, /\$cause\.GetType\(\)\.FullName -ceq 'AccessibilityRefusal'/);
  assert.match(handler, /\$_\.Exception\.Message -ceq \$script:refusal/);
  assert.match(handler, /Windows could not safely complete this request\. Inspect before retrying\. Helper line: /);
  assert.doesNotMatch(handler, /error = \$_\.Exception/, 'a raw exception message must never be written out');
  assert.equal((handler.match(/error = /g) || []).length, 2, 'preserved refusal and generic answers do not serialize provider content');
});

test('adapter passes a helper refusal on with its reason, and drops anything that is not one short sentence', async () => {
  await withMockWindows(async () => {
    let answer;
    const spawnProcess = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
      child.stdin = new Writable({ write(bytes, encoding, done) {
        const request = JSON.parse(bytes);
        const body = request.command === 'windows' ? { ok: true, result: [{ handle: '9', pid: 1, start: '1', name: 'fixture', title: 'Fixture' }] }
          : request.command === 'capture' ? { ok: true, result: { png: 'x', width: 100, height: 80, geometry: { left: 0, top: 0, right: 100, bottom: 80 } } }
          : answer;
        child.stdout.end(JSON.stringify(body));
        const code = body.ok ? 0 : 1;
        queueMicrotask(() => { child.emit('exit', code); child.emit('close', code); });
        done();
      } });
      return child;
    };
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess });
    const mode = { scope: 'desktop', controller: new AbortController() };
    const point = async () => {
      const { windows } = await adapter.inspect({}, mode);
      await adapter.capture({ windowId: windows[0].id }, mode);
      return adapter.pointer({ windowId: windows[0].id, kind: 'click', x: 5, y: 5 }, mode, true);
    };
    const leftHalf = 'Window is outside the left half of its monitor. desktop.pointer does not move windows. Use desktop.act with kind focus on this window, capture it again, then point.';
    answer = { ok: false, refusal: true, error: leftHalf };
    await assert.rejects(point(), error => { assert.equal(error.message, leftHalf); return true; });
    answer = { ok: false, error: 'Windows could not safely complete this request. Inspect before retrying. Helper line: 431' };
    await assert.rejects(point(), error => { assert.match(error.message, GENERIC); return true; });
    for (const unusable of ['x'.repeat(401), 'first line\nC:\\Users\\Someone\\private.txt', 42, { text: 'object' }, '']) {
      answer = { ok: false, refusal: true, error: unusable };
      await assert.rejects(point(), error => { assert.equal(error.message, 'Windows control failed. Inspect before retrying.'); return true; });
    }
  });
});

function runHelper(line) {
  const windowsRoot = process.env.SystemRoot;
  const home = userInfo().homedir;
  // Honor the test caller's effective native TEMP instead of deriving another account-home path.
  const temp = tmpdir();
  assert.ok(path.isAbsolute(temp), 'Absolute helper temporary directory required');
  const result = spawnSync(path.join(windowsRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(import.meta.dirname, '..', 'native', 'accessibility-desktop.ps1')],
    { input: line + '\n', encoding: 'utf8', timeout: 60000, windowsHide: true,
      env: { SystemRoot: windowsRoot, WINDIR: windowsRoot, USERPROFILE: home, TEMP: temp, TMP: temp } });
  return { status: result.status, answer: JSON.parse(result.stdout.trim().replace(/^\uFEFF/, '')) };
}

test('the real helper returns the reason for its own refusals and hides system errors', { skip: process.platform !== 'win32', timeout: 180000 }, () => {
  const base = { profileRoot: userInfo().homedir, appPid: process.pid };
  // Refused before any window is touched.
  assert.deepEqual(runHelper(JSON.stringify({ ...base, command: 'shell' })),
    { status: 1, answer: { ok: false, refusal: true, error: 'Unsupported desktop request.' } });
  assert.deepEqual(runHelper(JSON.stringify({ ...base, command: 'inspect', includeText: 'yes', window: {} })),
    { status: 1, answer: { ok: false, refusal: true, error: 'Invalid text inspection option.' } });
  // A window that does not exist: no window of anyone is read or changed.
  for (const command of ['capture', 'inspect', 'position-left', 'pointer']) {
    assert.deepEqual(runHelper(JSON.stringify({ ...base, command, window: { handle: '1', pid: 1, start: '0', name: 'none', title: 'none' } })),
      { status: 1, answer: { ok: false, refusal: true, error: 'The window changed, closed or is not permitted. Inspect again.' } }, command);
  }
  // Not a refusal: the JSON parser's own message must not come back.
  const broken = runHelper('{ this is not json');
  assert.equal(broken.status, 1);
  assert.deepEqual(Object.keys(broken.answer).sort(), ['error', 'ok']);
  assert.match(broken.answer.error, GENERIC);
});

test('compiled input helpers refuse with the dedicated refusal type and a fixed sentence', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const source = await fs.readFile(helperPath, 'utf8');
  const classBody = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/);
  assert.ok(classBody);
  const script = `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${classBody[1]}\n'@\n`
    + `try { $null = [AccessibilityNative]::BuildInputs($false, $null, 0); throw 'accepted' } catch {\n`
    + `  $cause = $_.Exception.InnerException\n`
    + `  [Console]::WriteLine($cause.GetType().FullName + '|' + $cause.Message)\n}\n`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(result.stdout.trim(), 'AccessibilityRefusal|Key input requires a nonzero virtual key.');
});
