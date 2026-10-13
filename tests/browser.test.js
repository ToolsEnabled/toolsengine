import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BROWSER_TOOLS, browserFile, checkBrowserUrl, launchDedicatedContext, publicToolNames } from '../src/browser.js';
import * as browserModule from '../src/browser.js';

test('dependency notes are translated to offered tool names; page content and unoffered names are left alone', () => {
  assert.equal(publicToolNames('### Error\nError: Tool "browser_snapshot" does not handle the modal state.\n### Modal state\n- ["alert" dialog]: can be handled by browser_handle_dialog\n'),
    '### Error\nError: Tool "browser.snapshot" does not handle the modal state.\n### Modal state\n- ["alert" dialog]: can be handled by browser.handle_dialog\n');
  const page = '### Page\n- Page Title: browser_click\n### Snapshot\n```yaml\n- paragraph: use browser_click here\n```\n### Result\nFound browser_click\n';
  assert.equal(publicToolNames(page), page);
  assert.equal(publicToolNames('### Error\nuse browser_evaluate or browser_run_code_unsafe'), '### Error\nuse browser_evaluate or browser_run_code_unsafe');
  assert.equal(publicToolNames('### Error\nuse browser_close', ['browser_tabs']), '### Error\nuse browser_close', 'a tool withheld in attached mode is not advertised');
  assert.equal(publicToolNames('plain text browser_click'), 'plain text browser_click');
  assert.equal(publicToolNames(''), '');
});

test('partial browser launch is rolled back when context creation fails', async () => {
  let closed = 0;
  const browser = { newContext: async () => { throw new Error('fixture context failure'); }, close: async () => { closed++; } };
  await assert.rejects(launchDedicatedContext({ launch: async () => browser }, {}), /fixture context failure/);
  assert.equal(closed, 1);
});

test('browser catalogue has no code execution, cookies, storage or network body tools', () => {
  for (const name of BROWSER_TOOLS) assert.doesNotMatch(name, /evaluate|run_code|cookie|storage|network_request|install/);
  assert.ok(BROWSER_TOOLS.includes('browser_navigate'));
  assert.ok(BROWSER_TOOLS.includes('browser_file_upload'));
});

test('navigation rejects executable/file URLs and embedded credentials', () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:secret@example.com'])
    assert.throws(() => checkBrowserUrl(url));
  assert.equal(checkBrowserUrl('https://example.com/'), 'https://example.com/');
  // An address without a scheme, or an empty one, is refused with the reason
  // rather than the bare "Invalid URL" of the URL parser.
  for (const url of ['', 'example.com', 'example.com/path', '//example.com', 'localhost:8080'])
    assert.throws(() => checkBrowserUrl(url), /requires an HTTP\(S\) URL/, JSON.stringify(url));
});

test('browser output and upload paths reject traversal, links and overwrites', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-paths-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'file.txt'), 'fixture');
  assert.equal(await browserFile(root, 'new.png'), path.join(root, 'new.png'));
  await assert.rejects(browserFile(root, '../escape.png'));
  await assert.rejects(browserFile(root, '.env', { input: true }));
  for (const filename of ['NUL', 'CON.png', 'COM1.txt', 'LPT9.pdf']) {
    await assert.rejects(browserFile(root, filename));
    await assert.rejects(browserFile(root, filename, { input: true }));
  }
  await assert.rejects(browserFile(root, 'file.txt'));
  assert.equal(await browserFile(root, 'file.txt', { input: true }), path.join(root, 'file.txt'));
  // A missing file is named by its workspace-relative path, without the
  // system error text and its absolute path.
  for (const [value, options, pattern] of [
    ['missing.txt', { input: true }, /^File to upload does not exist in the workspace: missing\.txt$/],
    ['nowhere/missing.txt', { input: true }, /^File to upload does not exist in the workspace: nowhere$/],
    ['nowhere/new.png', {}, /^Output directory does not exist in the workspace: nowhere$/],
  ]) await assert.rejects(browserFile(root, value, options), error => {
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(root) && !/ENOENT|lstat/.test(error.message), error.message);
    return true;
  });
  await fs.mkdir(path.join(root, 'real'));
  await fs.symlink(path.join(root, 'real'), path.join(root, 'link'), 'junction');
  await assert.rejects(browserFile(root, 'link/escape.png'));
});

test('uploads and output files stay out of a dedicated profile that lies inside the workspace', async t => {
  // --profile-dir may name a folder in the workspace: installs use that
  // layout. The profile holds the browser's cookies and sign-ins, so a file
  // from it is not handed to a page, and no output file is written into it.
  const { profileInsideWorkspace } = browserModule;
  assert.equal(typeof profileInsideWorkspace, 'function');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-profile-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = path.join(root, 'browser-profile');
  await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
  await fs.writeFile(path.join(profile, 'Default', 'Cookies'), 'the cookie store');
  await fs.writeFile(path.join(root, 'report.txt'), 'an ordinary file');

  const protectedFolders = await profileInsideWorkspace(root, profile);
  assert.deepEqual(protectedFolders, [profile]);
  for (const inside of ['browser-profile/Default/Cookies', path.join(profile, 'Default', 'Cookies'), 'browser-profile/Default/../Default/Cookies'])
    await assert.rejects(browserFile(root, inside, { input: true, protectedFolders }), /inside the browser's profile folder/, inside);
  await assert.rejects(browserFile(root, 'browser-profile/shot.png', { protectedFolders }), /inside the browser's profile folder/);
  await assert.rejects(browserFile(root, 'browser-profile/Default/new.pdf', { protectedFolders }), /inside the browser's profile folder/);
  // A file that is not there is refused in the same words: the refusal does not tell what the profile holds.
  await assert.rejects(browserFile(root, 'browser-profile/Default/Login Data', { input: true, protectedFolders }), /inside the browser's profile folder/);
  // Everything else in the workspace is as before.
  assert.equal(await browserFile(root, 'report.txt', { input: true, protectedFolders }), path.join(root, 'report.txt'));
  assert.equal(await browserFile(root, 'new.png', { protectedFolders }), path.join(root, 'new.png'));
  assert.equal(await browserFile(root, 'browser-profile-notes.txt', { protectedFolders }), path.join(root, 'browser-profile-notes.txt'), 'a name that only begins like the folder is another file');

  // A profile outside the workspace is out of reach of these paths anyway, and none at all is the default.
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-profile-')));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  assert.deepEqual(await profileInsideWorkspace(root, outside), [outside]);
  assert.deepEqual(await profileInsideWorkspace(root, undefined), []);
  assert.deepEqual(await profileInsideWorkspace(root, path.join(root, 'not created yet')), [path.join(root, 'not created yet')]);
});
