// Preserve the default protected-page rule and its redacted reporting, while
// allowing the owner's explicit browser sign-in startup choice.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import desktop from '../native/accessibility-desktop.cjs';

const { createAccessibilityDesktopAdapter, findProtectedTerm, isProtectedDesktopLabel, protectedLabel, protectedTermNames, protectedTermPatterns } = desktop;
const RULE = 'password|passcode|credential|api.?key|secret|sign.?in|log.?in|permission|confirm|approve|accessibility';
const helperPath = new URL('../native/accessibility-desktop.ps1', import.meta.url);

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

function helperAnswering(answers, requests = []) {
  return () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true;
    child.stdin = new Writable({ write(bytes, encoding, done) {
      const request = JSON.parse(bytes);
      requests.push(request);
      child.stdout.end(JSON.stringify({ ok: true, result: answers[request.command] }));
      queueMicrotask(() => { child.emit('exit', 0); child.emit('close', 0); });
      done();
    } });
    return child;
  };
}

test('the default rule is unchanged in both files and the reporting list mirrors it', async () => {
  const helper = (await fs.readFile(helperPath, 'utf8')).replace(/\r\n/g, '\n');
  const adapter = await fs.readFile(new URL('../native/accessibility-desktop.cjs', import.meta.url), 'utf8');
  assert.ok(helper.includes(`  $blockedLabels = '(?i)${RULE}'\n`), 'the PowerShell rule line was edited');
  assert.equal(protectedLabel.source, RULE);
  assert.equal(protectedLabel.flags, 'i');
  // Every place that decided before still decides, with the same pattern.
  for (const use of ['Get-RestrictedWindowState $name $title $windowLabels', '$label -match $blockedLabels',
    'Get-RestrictedControlDisposition $type $null $false $true $false $false $blockedLabels',
    'Get-RestrictedControlDisposition $type $label $info.IsEnabled $info.IsOffscreen $hasSelection $documentAncestor $blockedLabels'])
    assert.ok(helper.includes(use), `the helper no longer applies the rule at: ${use}`);
  // Patterns are never taken from a caller or the environment.
  assert.doesNotMatch(helper, /\$request\.(?:blocked|protected|rule)|\$env:[A-Za-z_]*(?:PROTECT|BLOCK|ALLOW)/i);
  assert.doesNotMatch(adapter, /process\.env\.[A-Z_]*(?:PROTECT|BLOCK|ALLOW)/);
  // The reporting list is the rule's alternatives, one by one.
  assert.equal(protectedTermPatterns.join('|'), RULE);
  assert.equal(protectedTermNames.length, protectedTermPatterns.length);
  const helperPatterns = helper.match(/\$protectedTermPatterns = @\(([^)]*)\)/)[1].split(',').map(item => item.trim().replace(/^'|'$/g, ''));
  const helperNames = helper.match(/\$protectedTermNames = @\(([^)]*)\)/)[1].split(',').map(item => item.trim().replace(/^'|'$/g, ''));
  assert.deepEqual(helperPatterns, protectedTermPatterns);
  assert.deepEqual(helperNames, protectedTermNames);
});

test('owner sign-in choice affects only Chrome and Edge and keeps sensitive terms protected', async () => {
  for (const app of ['chrome', 'msedge', 'notepad', 'fixture']) {
    for (const label of ['Sign in', 'Log in', 'Signing in to Google']) {
      assert.equal(isProtectedDesktopLabel(label, app), true);
      assert.equal(isProtectedDesktopLabel(label, app, true), !['chrome', 'msedge'].includes(app));
    }
    for (const label of ['Password', 'Secret', 'API key', 'Confirm access', 'Permission', 'Credential', 'Approve'])
      assert.equal(isProtectedDesktopLabel(label, app, true), true, `${app}: ${label}`);
  }
  assert.deepEqual(findProtectedTerm('Sign in password', true), { term: 'password', insideLongerWord: false });
  await withMockWindows(async () => {
    for (const allowSignIn of [false, true]) {
      const requests = [];
      const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', allowSignIn, spawnProcess: helperAnswering({
        windows: [
          { handle: '1', pid: 1, start: '1', name: 'chrome', title: 'Sign in to Google' },
          { handle: '2', pid: 2, start: '2', name: 'notepad', title: 'Log in details' },
          { diagnostics: { visibleWindows: 2, inspectionErrors: 0, outsideProfile: 'private-title', secret: 'never-return' } },
        ],
      }, requests) });
      // A tool argument cannot override the owner-selected startup value.
      const mode = { scope: 'desktop', controller: new AbortController() };
      await assert.rejects(adapter.inspect({ allowSignIn: !allowSignIn }, mode), /only a window id/);
      assert.equal(requests.length, 0);
      const result = await adapter.inspect({}, mode);
      assert.equal(requests[0].allowSignIn, allowSignIn);
      assert.equal(result.windows.length, allowSignIn ? 1 : 0);
      assert.equal(result.diagnostics.browserSignInEnabled, allowSignIn);
      assert.equal(result.diagnostics.visibleWindows, 2);
      assert.equal(result.diagnostics.inspectionErrors, 0);
      assert.doesNotMatch(JSON.stringify(result), /private-title|never-return|Log in details/);
    }
  });
});

test('the reporter names the word and says when it sits inside a longer word, and agrees with the rule on every title', () => {
  const cases = [
    ['Confirm access - Google Chrome', 'confirm', false],
    ['Sign in to GitHub', 'sign in', false],
    ['Sign-in required', 'sign in', false],
    ['LOGIN', 'log in', false],
    ['My API_KEY store', 'api key', false],
    ['Edit permission', 'permission', false],
    ['Designing a logo', 'sign in', true],
    ['Blogging tips', 'log in', true],
    ['Catalog index', 'log in', true],
    ['Passwords and passkeys', 'password', true],
    ['Confirm your password', 'confirm', false],
  ];
  for (const [title, term, insideLongerWord] of cases) {
    assert.ok(protectedLabel.test(title), title);
    assert.deepEqual(findProtectedTerm(title), { term, insideLongerWord }, title);
  }
  for (const title of ['Course home', 'Notes', 'Design review', 'Logs', 'Signal', '']) {
    assert.equal(protectedLabel.test(title), false, title);
    assert.equal(findProtectedTerm(title), null, title);
  }
  assert.equal(findProtectedTerm(undefined), null);
});

test('a withheld browser window says which word matched, in the listing and in every refusal', async () => {
  await withMockWindows(async () => {
    const requests = [];
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess: helperAnswering({
      windows: [{ handle: '42', pid: 7, start: '100', name: 'chrome', title: 'Restricted browser tabs', titleToken: 'a'.repeat(64),
        restricted: 'browser-tabs', protectedTerm: { term: 'confirm', insideLongerWord: false } }],
      inspect: { controls: [{ runtimeId: '1.2', label: 'Course home', type: 'TabItem', actions: ['select'], textMode: null, restrictedBrowserTab: true }],
        windowActions: [], visited: 3, hiddenDisabledOrPassword: 0, types: ['TabItem'] },
    }, requests) });
    const mode = { scope: 'desktop', controller: new AbortController() };
    const listed = await adapter.inspect({}, mode);
    const [window] = listed.windows;
    assert.deepEqual(window.protectedTerm, { term: 'confirm', insideLongerWord: false });
    assert.match(window.diagnostic, /^Protected browser page detected: the active tab title contains the protected word "confirm"\. Only existing non-sensitive browser tabs may be inspected and selected\. Page content, screenshots, pointer input and other actions are blocked\./);
    assert.match(window.diagnostic, /Only the owner startup option/);
    assert.equal(window.restrictedState, 'browser-tabs-only');
    const named = /protected word "confirm"/;
    const before = requests.length;
    await assert.rejects(adapter.capture({ windowId: window.id }, mode), named);
    await assert.rejects(adapter.pointer({ windowId: window.id, kind: 'click', x: 1, y: 1 }, mode, false), named);
    await assert.rejects(adapter.positionForAction({ windowId: window.id }, mode), named);
    await assert.rejects(adapter.inspect({ windowId: window.id, includeText: true }, mode), named);
    assert.throws(() => adapter.plan({ kind: 'focus', windowId: window.id }, mode), named);
    assert.equal(requests.length, before, 'the refusals happen before the helper is asked, as they did');
    const tabs = await adapter.inspect({ windowId: window.id }, mode);
    assert.match(tabs.diagnostic, named);
    assert.throws(() => adapter.plan({ kind: 'click', targetId: tabs.controls[0].id }, mode), named);
    // Selecting another tab is still the one thing allowed.
    assert.equal(adapter.plan({ kind: 'select', targetId: tabs.controls[0].id }, mode).summary, 'Select Course home in Restricted browser tabs');
  });
});

test('the word comes from the fixed list or not at all: nothing from a title can travel in that field', async () => {
  await withMockWindows(async () => {
    for (const protectedTerm of [undefined, null, 'confirm', { term: 'Quarterly results - confidential', insideLongerWord: false },
      { term: 'confirm' }, { term: 'confirm', insideLongerWord: 'no' }, { term: ['confirm'], insideLongerWord: false }]) {
      const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess: helperAnswering({
        windows: [{ handle: '42', pid: 7, start: '100', name: 'msedge', title: 'Restricted browser tabs', titleToken: 'b'.repeat(64), restricted: 'browser-tabs', protectedTerm },
          { withheld: 'protected-title', protectedTerm }, { withheld: 'protected-title', title: 'Quarterly results', name: 'excel', protectedTerm }],
      }) });
      const listed = await adapter.inspect({}, { scope: 'desktop', controller: new AbortController() });
      assert.equal(listed.windows.length, 1);
      assert.equal(Object.hasOwn(listed.windows[0], 'protectedTerm'), false);
      assert.equal(listed.windows[0].diagnostic, 'Protected browser page detected. Only existing non-sensitive browser tabs may be inspected and selected. Page content, screenshots, pointer input and other actions are blocked.');
      assert.equal(listed.withheldByProtectedRule.windows, 2, 'withheld windows are still counted');
      assert.deepEqual(listed.withheldByProtectedRule.matchedTerms, []);
      assert.doesNotMatch(JSON.stringify(listed), /Quarterly|confidential|excel/);
    }
  });
});

test('windows withheld from the list are counted with their words, and are still not listed', async () => {
  await withMockWindows(async () => {
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess: helperAnswering({
      windows: [
        { handle: '1', pid: 1, start: '1', name: 'notepad', title: 'Shopping list' },
        { withheld: 'protected-title', protectedTerm: { term: 'log in', insideLongerWord: true } },
        { withheld: 'protected-title', protectedTerm: { term: 'confirm', insideLongerWord: false } },
        { withheld: 'protected-title', protectedTerm: { term: 'confirm', insideLongerWord: false } },
        // A title the helper let through is caught by the same rule on this side.
        { handle: '2', pid: 2, start: '2', name: 'winword', title: 'Designing the brochure' },
      ],
    }) });
    const listed = await adapter.inspect({}, { scope: 'desktop', controller: new AbortController() });
    assert.deepEqual(listed.windows.map(({ label, application }) => ({ label, application })), [{ label: 'Shopping list', application: 'notepad' }]);
    assert.equal(listed.withheldByProtectedRule.windows, 4);
    assert.deepEqual(listed.withheldByProtectedRule.matchedTerms, [
      { term: 'log in', insideLongerWord: true }, { term: 'confirm', insideLongerWord: false }, { term: 'sign in', insideLongerWord: true }]);
    assert.match(listed.withheldByProtectedRule.note, /not listed and cannot be inspected, captured or acted on.*owner startup option/);
    assert.doesNotMatch(JSON.stringify(listed), /Designing|brochure|winword/, 'a withheld window gives away its word, not its title or application');
  });
  await withMockWindows(async () => {
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess: helperAnswering({
      windows: [{ handle: '1', pid: 1, start: '1', name: 'notepad', title: 'Shopping list' }] }) });
    const listed = await adapter.inspect({}, { scope: 'desktop', controller: new AbortController() });
    assert.equal(Object.hasOwn(listed, 'withheldByProtectedRule'), false, 'nothing is reported when nothing was withheld');
  });
});

test('controls withheld by their label are counted with their words, and are still not listed', async () => {
  await withMockWindows(async () => {
    const answers = {
      windows: [{ handle: '1', pid: 1, start: '1', name: 'fixture', title: 'Order form' }],
      inspect: { controls: [{ runtimeId: '5', label: 'Cancel', type: 'Button', actions: ['click'], textMode: null }], windowActions: ['close'], visited: 9,
        hiddenDisabledOrPassword: 1, types: ['Button'], protectedLabels: { count: 2, terms: ['approve', 'confirm', 'Order 4411 for A. Customer'] } },
    };
    const adapter = createAccessibilityDesktopAdapter({ profileRoot: 'C:\\Users\\Fixture', spawnProcess: helperAnswering(answers) });
    const mode = { scope: 'desktop', controller: new AbortController() };
    const { windows } = await adapter.inspect({}, mode);
    const inspected = await adapter.inspect({ windowId: windows[0].id }, mode);
    assert.deepEqual(inspected.controls.map(control => control.label), ['Cancel']);
    assert.equal(inspected.withheldByProtectedRule.controls, 2);
    assert.deepEqual(inspected.withheldByProtectedRule.matchedTerms, ['confirm', 'approve']);
    assert.doesNotMatch(JSON.stringify(inspected), /4411|Customer/);
    answers.inspect.protectedLabels = { count: 0, terms: [] };
    const again = await adapter.inspect({ windowId: (await adapter.inspect({}, mode)).windows[0].id }, mode);
    assert.equal(Object.hasOwn(again, 'withheldByProtectedRule'), false);
  });
});

test('the real helper functions report the same words as the Node side', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const source = await fs.readFile(helperPath, 'utf8');
  const helpers = source.match(/# RESTRICTED_BROWSER_HELPERS_START\r?\n([\s\S]*?)\r?\n\s*# RESTRICTED_BROWSER_HELPERS_END/);
  assert.ok(helpers);
  const signInRule = source.match(/\$signInAllowedLabels = '([^']+)'/)[1];
  const titles = ['Confirm access - Google Chrome', 'Sign in to GitHub', 'Sign-in required', 'LOGIN', 'My API_KEY store', 'Designing a logo',
    'Blogging tips', 'Catalog index', 'Passwords and passkeys', 'Confirm your password', 'Course home', 'Design review'];
  const script = `$ErrorActionPreference = 'Stop'\n${helpers[1]}\n`
    + `$rule = '(?i)${RULE}'\n`
    + titles.map(title => `$matched = Get-ProtectedTerm '${title}'\n`
      + `[Console]::WriteLine('${title}|' + [bool]('${title}' -match $rule) + '|' + $(if ($matched) { $matched.term + '|' + $matched.insideLongerWord } else { 'none' }))\n`).join('')
    + `if ((Get-RestrictedWindowState 'chrome' 'Confirm access' $rule) -cne 'browser-tabs') { throw 'browser window no longer restricted' }\n`
    + `if ((Get-RestrictedWindowState 'notepad' 'Catalog index' $rule) -cne 'excluded') { throw 'other window no longer excluded' }\n`
    + `if ((Get-RestrictedWindowState 'chrome' 'Sign in' '${signInRule}') -cne 'normal') { throw 'owner browser sign-in refused' }\n`
    + `if ((Get-RestrictedWindowState 'msedge' 'Sign in password' '${signInRule}') -cne 'browser-tabs') { throw 'password restriction removed' }\n`
    + `if ((Get-ProtectedTerm 'Sign in password' $true).term -cne 'password') { throw 'wrong opt-in refusal reason' }\n`;
  const result = spawnSync(path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  const lines = result.stdout.trim().split(/\r?\n/);
  assert.equal(lines.length, titles.length);
  for (const [index, title] of titles.entries()) {
    const expected = findProtectedTerm(title);
    assert.equal(lines[index], `${title}|${protectedLabel.test(title) ? 'True' : 'False'}|${expected ? `${expected.term}|${expected.insideLongerWord ? 'True' : 'False'}` : 'none'}`);
  }
});
