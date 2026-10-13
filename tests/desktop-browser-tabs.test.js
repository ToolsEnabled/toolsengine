import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createAccessibilityDesktopAdapter } from '../native/accessibility-desktop.cjs';

const restrictedMessage = /Protected browser page.*tab/i;

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

function fixtureSpawner(requests) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes);
      requests.push(request);
      let result;
      if (request.command === 'windows') {
        result = [{ handle: '42', pid: 7, start: '100', name: 'chrome', title: 'Restricted browser tabs',
          titleToken: 'a'.repeat(64), restricted: 'browser-tabs' }];
      } else if (request.command === 'inspect') {
        result = { controls: [{ runtimeId: '1.2.3', label: 'Course home', type: 'TabItem', actions: ['select'],
          textMode: null, restrictedBrowserTab: true }], windowActions: [], visited: 12,
          hiddenDisabledOrPassword: 1, types: ['TabItem'], restrictedState: 'browser-tabs-only' };
      } else result = { status: 'completed' };
      child.stdout.end(JSON.stringify({ ok: true, result }));
      queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); });
      done();
    } });
    return child;
  };
}

test('restricted browser recovery exposes select-only tabs and refuses every broader action before dispatch', async () => {
  await withMockWindows(async () => {
    let clock = 1000;
    const requests = [];
    const adapter = createAccessibilityDesktopAdapter({
      profileRoot: 'C:\\Users\\ToolsEnabled-Dev',
      spawnProcess: fixtureSpawner(requests),
      now: () => clock,
    });
    const mode = { scope: 'desktop', controller: new AbortController() };

    const listed = await adapter.inspect({}, mode);
    assert.equal(listed.windows.length, 1);
    assert.equal(listed.windows[0].label, 'Restricted browser tabs');
    assert.equal(listed.windows[0].application, 'chrome');
    assert.equal(listed.windows[0].restrictedState, 'browser-tabs-only');
    assert.match(listed.windows[0].diagnostic, restrictedMessage);
    assert.doesNotMatch(JSON.stringify(listed), /a{64}|titleToken/);
    const windowId = listed.windows[0].id;

    const beforeText = requests.length;
    await assert.rejects(adapter.inspect({ windowId, includeText: true }, mode), restrictedMessage);
    assert.equal(requests.length, beforeText, 'includeText refusal must happen before native dispatch');

    const inspected = await adapter.inspect({ windowId }, mode);
    assert.equal(inspected.restrictedState, 'browser-tabs-only');
    assert.deepEqual(inspected.windowActions, []);
    assert.deepEqual(inspected.controls.map(({ label, type, actions }) => ({ label, type, actions })),
      [{ label: 'Course home', type: 'TabItem', actions: ['select'] }]);
    assert.equal(Object.hasOwn(inspected.controls[0], 'restrictedBrowserTab'), false);
    assert.equal(Object.hasOwn(inspected.controls[0], 'text'), false);
    const targetId = inspected.controls[0].id;

    const dispatchesBeforeRefusals = requests.length;
    await assert.rejects(adapter.capture({ windowId }, mode), restrictedMessage);
    await assert.rejects(adapter.pointer({ windowId, kind: 'click', x: 0, y: 0 }, mode, false), restrictedMessage);
    await assert.rejects(adapter.positionForAction({ windowId }, mode), restrictedMessage);
    for (const action of [
      { kind: 'focus', windowId },
      { kind: 'window', windowId, value: 'close' },
      { kind: 'click', targetId },
      { kind: 'toggle', targetId, value: 'on' },
      { kind: 'expand', targetId, value: 'open' },
      { kind: 'scroll', targetId, value: 'down' },
      { kind: 'type', targetId, text: 'ordinary text' },
      { kind: 'key', targetId, value: 'Enter' },
    ]) assert.throws(() => adapter.plan(action, mode), restrictedMessage);
    assert.equal(requests.length, dispatchesBeforeRefusals, 'blocked actions must not reach the native helper');

    assert.throws(() => adapter.plan({ kind: 'select', targetId, windowId: 'different-window' }, mode), /does not match/);
    const selection = adapter.plan({ kind: 'select', targetId }, mode);
    assert.match(selection.summary, /^Select Course home in Restricted browser tabs$/);
    assert.equal(selection.foregroundRequired, false);
    await selection.execute(mode.controller.signal);
    const delivered = requests.at(-1);
    assert.equal(delivered.command, 'action');
    assert.equal(delivered.kind, 'select');
    assert.equal(delivered.control.type, 'TabItem');
    assert.equal(delivered.control.restrictedBrowserTab, true);
    assert.equal(delivered.window.title, 'Restricted browser tabs');
    assert.equal(delivered.window.titleToken, 'a'.repeat(64));

    clock += 90001;
    assert.throws(() => adapter.plan({ kind: 'select', targetId }, mode), /Inspect again/);
    await assert.rejects(adapter.capture({ windowId }, mode), /Inspect the desktop again/);
  });
});

test('restricted inspection fails closed if native output contains page or non-tab controls', async () => {
  await withMockWindows(async () => {
    const requests = [];
    const spawnProcess = fixtureSpawner(requests);
    let calls = 0;
    const adapter = createAccessibilityDesktopAdapter({
      profileRoot: 'C:\\Users\\ToolsEnabled-Dev',
      spawnProcess: (...args) => {
        const child = spawnProcess(...args);
        calls++;
        if (calls === 2) {
          child.stdin = new Writable({ write(bytes, encoding, done) {
            requests.push(JSON.parse(bytes));
            child.stdout.end(JSON.stringify({ ok: true, result: { controls: [{ runtimeId: '9', label: 'Page field',
              type: 'Edit', actions: ['type'], textMode: 'replace', text: 'page content' }], windowActions: ['close'] } }));
            queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); });
            done();
          } });
        }
        return child;
      },
    });
    const mode = { scope: 'desktop', controller: new AbortController() };
    const listed = await adapter.inspect({}, mode);
    await assert.rejects(adapter.inspect({ windowId: listed.windows[0].id }, mode), /unsafe control shape/);
  });
});

test('native restricted policy distinguishes browser login windows and prunes document controls', { skip: process.platform !== 'win32' }, async () => {
  const source = await fs.readFile(new URL('../native/accessibility-desktop.ps1', import.meta.url), 'utf8');
  const helpers = source.match(/# RESTRICTED_BROWSER_HELPERS_START\r?\n([\s\S]*?)\r?\n\s*# RESTRICTED_BROWSER_HELPERS_END/);
  assert.ok(helpers, 'restricted policy helpers must be extractable for isolated native testing');
  const assertions = `$ErrorActionPreference = 'Stop'\n${helpers[1]}\n`
    + `$pattern = '(?i)password|passcode|credential|api.?key|secret|sign.?in|log.?in|permission|confirm|approve|accessibility'\n`
    + `if ((Get-RestrictedWindowState 'chrome' 'Sign in' $pattern) -cne 'browser-tabs') { throw 'Chrome protected title was not restricted.' }\n`
    + `if ((Get-RestrictedWindowState 'msedge' 'Login' $pattern) -cne 'browser-tabs') { throw 'Edge protected title was not restricted.' }\n`
    + `if ((Get-RestrictedWindowState 'notepad' 'Login notes' $pattern) -cne 'excluded') { throw 'Non-browser protected window was exposed.' }\n`
    + `if ((Get-RestrictedWindowState 'chrome' 'Course home' $pattern) -cne 'normal') { throw 'Ordinary browser title was restricted.' }\n`
    + `$token = Get-TitleToken 'private protected page title'\n`
    + `if ($token.Length -ne 64 -or $token -match 'private|protected|title' -or $token -cne (Get-TitleToken 'private protected page title') -or $token -ceq (Get-TitleToken 'different title')) { throw 'Title token was not deterministic and opaque.' }\n`
    + `if ((Get-RestrictedControlDisposition 'Document' 'ignored' $true $false $true $false $pattern) -cne 'prune') { throw 'Document was not pruned.' }\n`
    + `if ((Get-RestrictedControlDisposition 'TabItem' 'Course home' $true $false $true $false $pattern) -cne 'tab') { throw 'Safe browser tab was not exposed.' }\n`
    + `if ((Get-RestrictedControlDisposition 'TabItem' 'Sign in' $true $false $true $false $pattern) -cne 'exclude') { throw 'Protected tab label was exposed.' }\n`
    + `if ((Get-RestrictedControlDisposition 'TabItem' 'Course home' $true $false $true $true $pattern) -cne 'exclude') { throw 'Tab under Document was exposed.' }\n`
    + `if ((Get-RestrictedControlDisposition 'Edit' 'Page field' $true $false $false $false $pattern) -cne 'continue') { throw 'Non-tab chrome node did not remain traversal-only.' }\n`
    + `[Console]::WriteLine('restricted-browser-policy-ok')\n`;
  const encoded = Buffer.from(assertions, 'utf16le').toString('base64');
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', timeout: 30000, windowsHide: true,
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /restricted-browser-policy-ok/);
});
