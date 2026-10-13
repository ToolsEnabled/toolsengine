// Every browser tool that had no test, driven through the real stdio MCP
// interface against a site this file serves on 127.0.0.1. No public site, no
// signed-in profile: the server under test starts its own headless browser.
import test, { before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { serverBrowserSkipped } from './support/browser-under-test.js';

// A test that needs the server to start its browser. Where that browser
// cannot run on this machine the test is skipped, and the skip says why and
// which variable to set (tests/support/browser-under-test.js).
const browserTest = (name, options, run) => test(name, { ...options, skip: serverBrowserSkipped }, run);

const helpers = '<script>const q = s => document.querySelector(s);</script>';
const pages = {
  '/': '<title>Fixture home</title><h1>Fixture home</h1><a id="next" href="/second">Go to second page</a><p>Alpha beta gamma</p>',
  '/second': '<title>Second page</title><h1>Second page</h1><p>Only on the second page</p>',
  '/names': '<title>Names fixture</title><h1>Names fixture</h1><p>The page says browser_click and browser_handle_dialog</p>',
  '/cookie': `<title>Cookie fixture</title><h1>Cookie fixture</h1><p id="cookie"></p>${helpers}
    <script>
      if (document.cookie.includes('seen=yes')) q('#cookie').textContent = 'Cookie kept from before';
      else { document.cookie = 'seen=yes; max-age=3600; path=/'; q('#cookie').textContent = 'Cookie set just now'; }
    </script>`,
  '/form': `<title>Form fixture</title><h1>Form fixture</h1>
    <form id="f" onsubmit="return false">
      <label>Name <input id="name"></label>
      <label><input type="checkbox" id="agree"> Agree</label>
      <label><input type="radio" name="size" id="small" value="small"> Small</label>
      <label><input type="radio" name="size" id="large" value="large"> Large</label>
      <label>Colour <select id="colour"><option value="">Choose</option><option value="r">Red</option><option value="g">Green</option></select></label>
      <label>Volume <input type="range" id="volume" min="0" max="10" value="5"></label>
    </form><p id="state">State empty</p>${helpers}
    <script>
      const show = () => { q('#state').textContent = 'State name=' + q('#name').value + ' agree=' + q('#agree').checked
        + ' size=' + (q('[name=size]:checked')?.value || '-') + ' colour=' + q('#colour').value + ' volume=' + q('#volume').value; };
      for (const e of document.querySelectorAll('#f input, #f select')) { e.addEventListener('input', show); e.addEventListener('change', show); }
    </script>`,
  '/keys': `<title>Keys fixture</title><h1>Keys fixture</h1>
    <form id="kf"><label>Keys <input id="keys"></label></form>
    <p id="keylog">Key none</p><p id="sent">Sent nothing</p>${helpers}
    <script>
      q('#keys').addEventListener('keydown', e => { q('#keylog').textContent = 'Key ' + e.key + (e.shiftKey ? ' with shift' : ''); });
      q('#kf').addEventListener('submit', e => { e.preventDefault(); q('#sent').textContent = 'Sent ' + q('#keys').value; });
    </script>`,
  '/pointer': `<title>Pointer fixture</title><h1>Pointer fixture</h1>
    <div id="zone" style="width:160px;height:40px;background:#ccc">Hover zone</div><p id="hovered">Hovered no</p>
    <div id="card" draggable="true" style="width:80px;height:40px;background:#9cf">Card</div>
    <div id="bin" style="width:160px;height:80px;background:#fc9;margin-top:20px">Bin</div><p id="dropped">Dropped nothing</p>${helpers}
    <script>
      q('#zone').addEventListener('mouseenter', () => { q('#hovered').textContent = 'Hovered yes'; });
      q('#card').addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', 'card'));
      q('#bin').addEventListener('dragover', e => e.preventDefault());
      q('#bin').addEventListener('drop', e => { e.preventDefault(); q('#dropped').textContent = 'Dropped ' + e.dataTransfer.getData('text/plain'); });
    </script>`,
  '/dialogs': `<title>Dialog fixture</title><h1>Dialog fixture</h1>
    <button id="alert">Alert</button><button id="confirm">Ask to continue</button><button id="prompt">Ask for a word</button>
    <p id="dialog">Dialog none</p>${helpers}
    <script>
      q('#alert').onclick = () => { alert('Fixture alert'); q('#dialog').textContent = 'Dialog alert closed'; };
      q('#confirm').onclick = () => { q('#dialog').textContent = 'Dialog confirm answered ' + confirm('Fixture question?'); };
      q('#prompt').onclick = () => { q('#dialog').textContent = 'Dialog prompt answered ' + prompt('Fixture word?', 'default'); };
    </script>`,
  '/slow': `<title>Slow fixture</title><h1>Slow fixture</h1><button id="slow">Start</button><p id="slowstate">Idle</p>${helpers}
    <script>q('#slow').onclick = () => { q('#slowstate').textContent = 'Loading slowly'; setTimeout(() => { q('#slowstate').textContent = 'Finished slowly'; }, 700); };</script>`,
  '/upload': `<title>Upload fixture</title><h1>Upload fixture</h1>
    <form method="post" enctype="multipart/form-data" action="/upload"><label>Document <input type="file" id="doc" name="doc"></label><button id="send">Send</button></form>
    <label>Several <input type="file" id="docs" multiple></label><p id="picked">Picked none</p>${helpers}
    <script>q('#docs').addEventListener('change', e => { q('#picked').textContent = 'Picked ' + [...e.target.files].map(f => f.name + ':' + f.size).join(','); });</script>`,
};

let client, fixture, workspace, url, stderr = '';
const uploads = [];

before(async () => {
  workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-browser-tools-')));
  fixture = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.method === 'POST' && req.url === '/upload') {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        uploads.push({ contentType: req.headers['content-type'] || '', body });
        res.end(`<!doctype html><title>Upload received</title><h1>Upload received ${body.length} bytes</h1>`);
      });
      return;
    }
    const page = pages[req.url];
    if (!page) { res.statusCode = 404; res.end('<!doctype html><title>Missing</title><h1>Missing</h1>'); return; }
    res.end('<!doctype html><meta charset="utf-8">' + page);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${fixture.address().port}`;
});

// Each acceptance scenario is a distinct server session. The production
// queue/rate limit remains active; scenarios do not share accumulated calls.
beforeEach(async () => {
  const args = [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--headless'];
  if (process.env.TOOLSENGINE_TEST_BROWSER) args.push('--browser-executable', process.env.TOOLSENGINE_TEST_BROWSER);
  // Only for a machine where the browser under test cannot set its sandbox up
  // (see tests/browser-sandbox.integration.test.js). Never the default.
  if (process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1') args.push('--no-browser-sandbox');
  const transport = new StdioClientTransport({ command: process.execPath, args, cwd: workspace, stderr: 'pipe',
    env: { ...process.env, TEMP: os.tmpdir(), TMP: os.tmpdir() } });
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  client = new Client({ name: 'browser-tools-acceptance', version: '1.0.0' });
  await client.connect(transport);
});

afterEach(async () => { await client?.close(); client = undefined; });

after(async () => {
  fixture?.closeAllConnections();
  await new Promise(resolve => fixture ? fixture.close(resolve) : resolve());
  if (workspace) await fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const textOf = result => (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const call = (name, args = {}) => client.callTool({ name, arguments: args });
async function ok(name, args = {}) {
  const result = await call(name, args);
  assert.notEqual(result.isError, true, `${name} ${JSON.stringify(args)} -> ${textOf(result)}`);
  return textOf(result);
}
async function refused(name, args, pattern) {
  const result = await call(name, args);
  assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} should be refused, got: ${textOf(result)}`);
  assert.match(textOf(result), pattern);
  return textOf(result);
}
const open = page => ok('browser.navigate', { url: url + page });
const snapshot = () => ok('browser.snapshot');

browserTest('browser.navigate_back returns to the previous page, and ends on about:blank at the start of history', { timeout: 60000 }, async () => {
  await open('/');
  assert.match(await ok('browser.click', { target: '#next' }), /Page Title: Second page/);
  const back = await ok('browser.navigate_back');
  assert.match(back, /Page Title: Fixture home/);
  assert.match(await snapshot(), /Alpha beta gamma/);
  assert.match(await ok('browser.navigate_back'), /Page URL: about:blank/);
  assert.equal((await call('browser.navigate_back', { steps: 2 })).isError, true, 'unreviewed arguments must be refused');
});

browserTest('browser.find returns matching nodes with references for text and regex, and says when nothing matches', { timeout: 60000 }, async () => {
  await open('/');
  const byText = await ok('browser.find', { text: 'SECOND page' });
  assert.match(byText, /Found 1 match/);
  const reference = byText.match(/link "Go to second page" \[ref=(\w+)\]/);
  assert.ok(reference, byText);
  // The reference a find returns is usable as a target for an action.
  assert.match(await ok('browser.click', { target: reference[1], element: 'Go to second page' }), /Page Title: Second page/);
  await open('/');
  assert.match(await ok('browser.find', { regex: '/alpha\\s+BETA/i' }), /Found 1 match[\s\S]*Alpha beta gamma/);
  assert.match(await ok('browser.find', { regex: 'alpha BETA' }), /No matches found/, 'regex is case-sensitive without the i flag');
  assert.match(await ok('browser.find', { text: 'text that is nowhere on the page' }), /No matches found/);
  await refused('browser.find', {}, /text.*regex/);
  await refused('browser.find', { text: 'a', regex: 'b' }, /only one/i);
  // With a filename the matches go to a new workspace file, never over an existing one.
  assert.match(await ok('browser.find', { text: 'gamma', filename: 'found.md' }), /found\.md/);
  assert.match(await fs.readFile(path.join(workspace, 'found.md'), 'utf8'), /Alpha beta gamma/);
  await refused('browser.find', { text: 'gamma', filename: 'found.md' }, /already exists/);
  await refused('browser.find', { text: 'gamma', filename: '../outside.md' }, /inside the configured workspace/);
});

browserTest('browser.fill_form sets a text box, checkbox, radio button, drop-down and slider in one call', { timeout: 60000 }, async () => {
  await open('/form');
  await ok('browser.fill_form', { fields: [
    { target: '#name', name: 'Name', type: 'textbox', value: 'Ada Lovelace' },
    { target: '#agree', name: 'Agree', type: 'checkbox', value: 'true' },
    { target: '#large', name: 'Large', type: 'radio', value: 'true' },
    { target: '#colour', name: 'Colour', type: 'combobox', value: 'Green' },
    { target: '#volume', name: 'Volume', type: 'slider', value: '8' },
  ] });
  assert.match(await snapshot(), /State name=Ada Lovelace agree=true size=large colour=g volume=8/);
  await ok('browser.fill_form', { fields: [{ target: '#agree', name: 'Agree', type: 'checkbox', value: 'false' }] });
  assert.match(await snapshot(), /State name=Ada Lovelace agree=false size=large colour=g volume=8/);
  for (const fields of [undefined, 'name', [{ target: '#name', name: 'Name', type: 'textbox' }],
    [{ target: '#name', name: 'Name', type: 'script', value: 'x' }],
    [{ target: '#name', name: 'Name', type: 'textbox', value: 'x', code: 'alert(1)' }]]) {
    await refused('browser.fill_form', fields === undefined ? {} : { fields }, /Invalid arguments/);
  }
  assert.match(await snapshot(), /State name=Ada Lovelace/, 'refused calls must not change the form');
});

browserTest('browser.press_key sends characters, combinations and named keys to the focused element; Enter submits the form', { timeout: 60000 }, async () => {
  await open('/keys');
  await ok('browser.click', { target: '#keys' });
  await ok('browser.press_key', { key: 'a' });
  await ok('browser.press_key', { key: 'Shift+B' });
  assert.match(await snapshot(), /Key B with shift/);
  await ok('browser.press_key', { key: 'ArrowLeft' });
  assert.match(await snapshot(), /Key ArrowLeft/);
  await ok('browser.press_key', { key: 'Enter' });
  assert.match(await snapshot(), /Sent aB/, 'Enter in a text field submits its form');
  await refused('browser.press_key', { key: 'NotAKey' }, /Unknown key/);
  await refused('browser.press_key', {}, /Invalid arguments/);
});

browserTest('browser.select_option selects by value and by visible label, and fails for an option that does not exist', { timeout: 60000 }, async () => {
  await open('/form');
  await ok('browser.select_option', { target: '#colour', values: ['r'] });
  assert.match(await snapshot(), /colour=r /);
  await ok('browser.select_option', { target: '#colour', values: ['Green'] });
  assert.match(await snapshot(), /colour=g /);
  const started = Date.now();
  await refused('browser.select_option', { target: '#colour', values: ['no such option'] }, /did not find some options|Timeout/);
  assert.ok(Date.now() - started < 30000, 'a missing option must fail within the action timeout');
  assert.match(await snapshot(), /colour=g /, 'a failed selection leaves the previous choice');
  await refused('browser.select_option', { target: '#colour' }, /Invalid arguments/);
});

browserTest('browser.hover moves the pointer over an element so the page reacts; an unknown reference is refused', { timeout: 60000 }, async () => {
  await open('/pointer');
  assert.match(await snapshot(), /Hovered no/);
  await ok('browser.hover', { target: '#zone' });
  assert.match(await snapshot(), /Hovered yes/);
  await refused('browser.hover', { target: 'e99999' }, /not found/);
  await refused('browser.hover', {}, /Invalid arguments/);
});

browserTest('browser.drag drops one element on another', { timeout: 60000 }, async () => {
  await open('/pointer');
  assert.match(await snapshot(), /Dropped nothing/);
  await ok('browser.drag', { startTarget: '#card', endTarget: '#bin' });
  assert.match(await snapshot(), /Dropped card/);
  await refused('browser.drag', { startTarget: '#card' }, /Invalid arguments/);
});

browserTest('browser.handle_dialog accepts an alert, dismisses a confirm and answers a prompt; other tools wait for the answer', { timeout: 60000 }, async () => {
  await open('/dialogs');
  await refused('browser.handle_dialog', { accept: true }, /modal state/);
  assert.match(await ok('browser.click', { target: '#alert' }), /"alert" dialog with message "Fixture alert"/);
  await refused('browser.snapshot', {}, /modal state/);
  await ok('browser.handle_dialog', { accept: true });
  assert.match(await snapshot(), /Dialog alert closed/);
  assert.match(await ok('browser.click', { target: '#confirm' }), /"confirm" dialog with message "Fixture question\?"/);
  await ok('browser.handle_dialog', { accept: false });
  assert.match(await snapshot(), /Dialog confirm answered false/);
  await ok('browser.click', { target: '#confirm' });
  await ok('browser.handle_dialog', { accept: true });
  assert.match(await snapshot(), /Dialog confirm answered true/);
  assert.match(await ok('browser.click', { target: '#prompt' }), /"prompt" dialog/);
  await ok('browser.handle_dialog', { accept: true, promptText: 'typed answer' });
  assert.match(await snapshot(), /Dialog prompt answered typed answer/);
  await ok('browser.click', { target: '#prompt' });
  await ok('browser.handle_dialog', { accept: false });
  assert.match(await snapshot(), /Dialog prompt answered null/);
  await refused('browser.handle_dialog', {}, /Invalid arguments/);
});

browserTest('browser.wait_for waits for text to appear, for text to go, and for a bounded time', { timeout: 90000 }, async () => {
  await open('/slow');
  await ok('browser.click', { target: '#slow' });
  assert.match(await ok('browser.wait_for', { text: 'Finished slowly' }), /Waited for Finished slowly/);
  assert.match(await snapshot(), /Finished slowly/);
  await ok('browser.click', { target: '#slow' });
  await ok('browser.wait_for', { textGone: 'Loading slowly' });
  assert.doesNotMatch(await snapshot(), /Loading slowly/);
  const started = Date.now();
  assert.match(await ok('browser.wait_for', { time: 0.3 }), /Waited for 0\.3 seconds/);
  assert.ok(Date.now() - started >= 250, 'a timed wait must really wait');
  await refused('browser.wait_for', { time: 31 }, /Invalid arguments/);
  await refused('browser.wait_for', { time: -1 }, /Invalid arguments/);
  await refused('browser.wait_for', {}, /time, text or textGone/);
  const waiting = Date.now();
  await refused('browser.wait_for', { text: 'text that never appears' }, /Timeout/);
  assert.ok(Date.now() - waiting < 30000, 'waiting for text must give up within the action timeout');
});

function onlyFilePart(upload) {
  const boundary = upload.contentType.match(/boundary=(.+)$/)[1];
  const head = upload.body.indexOf('\r\n\r\n');
  const end = upload.body.lastIndexOf(`\r\n--${boundary}--`);
  return { headers: upload.body.subarray(0, head).toString('latin1'), bytes: upload.body.subarray(head + 4, end) };
}

browserTest('browser.file_upload hands workspace files to the page and the site receives their exact bytes', { timeout: 90000 }, async () => {
  // Every byte value, so an encoding mistake anywhere on the way would show.
  const content = Buffer.concat([Buffer.from('ToolsEngine upload check\n'), Buffer.from(Array.from({ length: 256 }, (_, i) => i))]);
  await fs.writeFile(path.join(workspace, 'upload-me.bin'), content);
  await fs.writeFile(path.join(workspace, 'one.txt'), 'first file\n');
  await fs.writeFile(path.join(workspace, 'two.txt'), 'second file, longer\n');
  await fs.writeFile(path.join(workspace, '.hidden.txt'), 'hidden\n');
  await open('/upload');

  await refused('browser.file_upload', { paths: ['upload-me.bin'] }, /modal state/);
  assert.match(await ok('browser.click', { target: '#doc' }), /File chooser/);
  await ok('browser.file_upload', { paths: ['upload-me.bin'] });
  assert.equal(uploads.length, 0, 'choosing a file does not send it until the page submits');
  assert.match(await ok('browser.click', { target: '#send' }), /Page Title: Upload received/);
  assert.equal(uploads.length, 1);
  const part = onlyFilePart(uploads[0]);
  assert.match(part.headers, /name="doc"; filename="upload-me\.bin"/);
  assert.ok(part.bytes.equals(content), `site received ${part.bytes.length} bytes, expected ${content.length}`);
  assert.match(await snapshot(), new RegExp(`Upload received ${uploads[0].body.length} bytes`));

  // Several files, by workspace-relative and by absolute path inside the workspace.
  await open('/upload');
  await ok('browser.click', { target: '#docs' });
  await ok('browser.file_upload', { paths: ['one.txt', path.join(workspace, 'two.txt')] });
  assert.match(await snapshot(), /Picked one\.txt:11,two\.txt:20/);

  // Omitting paths cancels the chooser and gives the page back.
  await ok('browser.click', { target: '#doc' });
  await refused('browser.snapshot', {}, /modal state/);
  await ok('browser.file_upload', {});
  assert.match(await snapshot(), /Upload fixture/);

  // Refusals happen before the browser is asked, so nothing reaches the page.
  await ok('browser.click', { target: '#doc' });
  const outside = path.join(os.tmpdir(), `toolsengine-outside-${process.pid}.txt`);
  await fs.writeFile(outside, 'outside the workspace\n');
  try {
    await refused('browser.file_upload', { paths: [outside] }, /inside the configured workspace/);
    await refused('browser.file_upload', { paths: ['../' + path.basename(outside)] }, /inside the configured workspace/);
  } finally { await fs.rm(outside, { force: true }); }
  await refused('browser.file_upload', { paths: ['.hidden.txt'] }, /Hidden/);
  const missing = await refused('browser.file_upload', { paths: ['no-such-file.txt'] }, /does not exist in the workspace: no-such-file\.txt/);
  assert.ok(!missing.includes(workspace) && !/ENOENT|lstat/.test(missing), `a refusal must not carry the system error text: ${missing}`);
  await refused('browser.file_upload', { paths: ['artifacts'] }, /regular/);
  let linked = false;
  try { await fs.symlink(path.join(workspace, 'one.txt'), path.join(workspace, 'link.txt')); linked = true; }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; } // Windows without the symlink privilege
  if (linked) await refused('browser.file_upload', { paths: ['link.txt'] }, /links/);
  await refused('browser.file_upload', { paths: 'one.txt' }, /Invalid arguments/);
  await ok('browser.file_upload', {});
  await ok('browser.click', { target: '#send' });
  assert.equal(uploads.length, 2, 'the form was submitted');
  assert.equal(onlyFilePart(uploads[1]).bytes.length, 0, 'a refused or cancelled upload must not attach any file');
});

browserTest('browser.tabs opens, lists, selects and closes tabs', { timeout: 60000 }, async () => {
  await open('/');
  const tabLines = text => text.split('\n').filter(line => /^- \d+:/.test(line));
  assert.equal(tabLines(await ok('browser.tabs', { action: 'list' })).length, 1);
  const opened = await ok('browser.tabs', { action: 'new', url: url + '/second' });
  assert.match(opened, /- 1: \(current\) \[Second page\]/);
  let lines = tabLines(await ok('browser.tabs', { action: 'list' }));
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^- 0: \[Fixture home\]/);
  assert.match(lines[1], /^- 1: \(current\) \[Second page\]/);
  assert.match(await snapshot(), /Only on the second page/, 'the new tab is the one browser tools act on');

  assert.match(await ok('browser.tabs', { action: 'select', index: 0 }), /- 0: \(current\) \[Fixture home\]/);
  assert.match(await snapshot(), /Alpha beta gamma/, 'after select, browser tools act on the selected tab');

  await ok('browser.tabs', { action: 'close', index: 1 });
  lines = tabLines(await ok('browser.tabs', { action: 'list' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^- 0: \(current\) \[Fixture home\]/);
  assert.match(await snapshot(), /Alpha beta gamma/, 'closing another tab leaves the current page alone');

  await refused('browser.tabs', { action: 'select', index: 7 }, /not found/);
  await refused('browser.tabs', { action: 'select' }, /index is required/);
  await refused('browser.tabs', { action: 'new', url: 'file:///etc/hosts' }, /HTTP\(S\)/);
  await refused('browser.tabs', { action: 'new', url: 'javascript:alert(1)' }, /HTTP\(S\)/);
  await refused('browser.tabs', { action: 'new', url: '' }, /HTTP\(S\)/);
  await refused('browser.navigate', { url: '' }, /requires an HTTP\(S\) URL/);
  await refused('browser.navigate', { url: 'example.invalid/page' }, /starting with http:\/\/ or https:\/\//);
  await refused('browser.tabs', { action: 'reload' }, /Invalid arguments/);
  await refused('browser.tabs', {}, /Invalid arguments/);
  assert.equal(tabLines(await ok('browser.tabs', { action: 'list' })).length, 1, 'refused calls must not open tabs');

  // A blank new tab, then close the current tab without naming it.
  await ok('browser.tabs', { action: 'new' });
  lines = tabLines(await ok('browser.tabs', { action: 'list' }));
  assert.equal(lines.length, 2);
  assert.match(lines[1], /^- 1: \(current\) \[\]\(about:blank\)/);
  await ok('browser.tabs', { action: 'close' });
  lines = tabLines(await ok('browser.tabs', { action: 'list' }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /Fixture home/);
});

browserTest('notes added to a result name tools this server offers, never the unoffered upstream names', { timeout: 60000 }, async () => {
  const offered = new Set((await client.listTools()).tools.map(tool => tool.name));
  const check = text => {
    for (const name of text.match(/\bbrowser[._][a-z_]+\b/g) || [])
      assert.ok(offered.has(name), `a result tells the assistant to use "${name}", which is not an offered tool:\n${text}`);
    return text;
  };
  await open('/dialogs');
  check(await refused('browser.handle_dialog', { accept: true }, /modal state/));
  assert.match(check(await ok('browser.click', { target: '#alert' })), /can be handled by browser\.handle_dialog/);
  check(await refused('browser.snapshot', {}, /modal state/));
  await ok('browser.handle_dialog', { accept: true });
  await open('/upload');
  check(await refused('browser.file_upload', { paths: [] }, /modal state/));
  assert.match(check(await ok('browser.click', { target: '#doc' })), /can be handled by browser\.file_upload/);
  check(await refused('browser.pdf_save', {}, /modal state/));
  await ok('browser.file_upload', {});
  // Page content is data and is never rewritten.
  await open('/names');
  assert.match(await snapshot(), /The page says browser_click and browser_handle_dialog/);
  assert.match(await ok('browser.find', { text: 'browser_click' }), /The page says browser_click and browser_handle_dialog/);
});

browserTest('an action the browser reports nothing about still returns a confirmation, never an empty result', { timeout: 60000 }, async () => {
  await open('/keys');
  await ok('browser.click', { target: '#keys' });
  const pressed = await call('browser.press_key', { key: 'a' });
  assert.notEqual(pressed.isError, true);
  assert.match(textOf(pressed), /^Done\./, `press_key returned ${JSON.stringify(pressed.content)}`);
  await open('/form');
  const filled = await call('browser.fill_form', { fields: [{ target: '#name', name: 'Name', type: 'textbox', value: 'Grace' }] });
  assert.notEqual(filled.isError, true);
  assert.match(textOf(filled), /^Done\./, `fill_form returned ${JSON.stringify(filled.content)}`);
  assert.match(await snapshot(), /State name=Grace/);
  // An error is never turned into a confirmation.
  assert.doesNotMatch(await refused('browser.press_key', { key: 'NotAKey' }, /Unknown key/), /Done\./);
});

test('capability.find over MCP returns only offered tools and refuses malformed queries', { timeout: 30000 }, async () => {
  const offered = new Set((await client.listTools()).tools.map(tool => tool.name));
  const find = async query => JSON.parse(await ok('capability.find', { query })).tools;
  const upload = await find('upload');
  assert.ok(upload.some(tool => tool.name === 'browser.file_upload'), JSON.stringify(upload));
  for (const query of ['browser', 'file', 'page', 'workspace']) {
    const found = await find(query);
    assert.ok(found.length > 0 && found.length <= 10, `${query}: ${found.length}`);
    for (const tool of found) {
      assert.ok(offered.has(tool.name), `not offered: ${tool.name}`);
      assert.deepEqual(Object.keys(tool).sort(), ['description', 'name']);
    }
  }
  assert.deepEqual(await find('zzzzqqqq'), []);
  // The tool asked for by name comes first, however the name is written.
  for (const query of ['browser.close', 'browser_close', 'close browser', 'BROWSER.CLOSE'])
    assert.equal((await find(query))[0]?.name, 'browser.close', query);
  assert.equal((await find('upload a file to the page'))[0].name, 'browser.file_upload');
  assert.equal((await find('write file'))[0].name, 'workspace.write_file');
  const broad = JSON.parse(await ok('capability.find', { query: 'browser' }));
  assert.deepEqual({ shown: broad.tools.length, truncated: broad.truncated }, { shown: 10, truncated: true });
  assert.ok(broad.matched >= 19, `only ${broad.matched} tools matched "browser"`);
  const none = JSON.parse(await ok('capability.find', { query: 'zzzzqqqq' }));
  assert.equal(none.matched, 0);
  assert.match(none.note, /system\.status/);
  for (const args of [{}, { query: '' }, { query: 'x'.repeat(201) }, { query: 7 }, { query: 'upload', limit: 50 }])
    await refused('capability.find', args, /Invalid arguments/);
  for (const hidden of ['evaluate', 'run_code', 'cookies', 'storage_state', 'desktop.pointer'])
    assert.ok(!(await find(hidden)).some(tool => tool.name.includes(hidden)), `${hidden} must not be discoverable here`);
});

browserTest('tools/list over stdio carries a title, every hint and an accurate account of browser.close', { timeout: 30000 }, async () => {
  const { tools } = await client.listTools();
  assert.equal(tools.length, 27);
  for (const tool of tools) {
    assert.ok(typeof tool.title === 'string' && tool.title.length >= 5, `${tool.name} has no title`);
    assert.equal(tool.annotations.title, tool.title);
    for (const hint of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'])
      assert.equal(typeof tool.annotations[hint], 'boolean', `${tool.name} leaves ${hint} unstated`);
  }
  // The description is checked against what the tool then does.
  assert.match(tools.find(tool => tool.name === 'browser.close').description, /whole browser.*every tab.*discards the session's cookies/);
  await open('/cookie');
  assert.match(await snapshot(), /Cookie set just now/);
  await open('/cookie');
  assert.match(await snapshot(), /Cookie kept from before/, 'the session keeps cookies while the browser stays open');
  await ok('browser.tabs', { action: 'new', url: url + '/second' });
  assert.match(await ok('browser.close'), /whole browser was closed, with every tab/);
  const after = await ok('browser.tabs', { action: 'list' });
  assert.deepEqual(after.split('\n').filter(line => /^- \d+:/.test(line)), ['- 0: (current) [](about:blank)'], 'both tabs are gone and a new empty browser started');
  await open('/cookie');
  assert.match(await snapshot(), /Cookie set just now/, 'closing the browser discarded the session cookies');
});

browserTest('browser.type replaces the content of a field by default, and types at the caret with slowly', { timeout: 60000 }, async () => {
  const description = (await client.listTools()).tools.find(tool => tool.name === 'browser.type').description;
  assert.match(description, /By default the text replaces what the field holds; slowly instead types it key by key/);
  await open('/form');
  await ok('browser.type', { target: '#name', text: 'First' });
  await ok('browser.type', { target: '#name', text: 'Second' });
  assert.match(await snapshot(), /State name=Second agree/, 'the second text replaced the first');
  await ok('browser.type', { target: '#name', text: '!', slowly: true });
  const typed = (await snapshot()).match(/State name=(\S+) agree/)[1];
  assert.ok(typed.includes('Second') && typed.includes('!') && typed.length === 7, `slowly typed into the existing text, giving "${typed}"`);
  // submit presses Enter, which submits the form the field belongs to.
  await open('/keys');
  await ok('browser.type', { target: '#keys', text: 'typed and sent', submit: true });
  assert.match(await snapshot(), /Sent typed and sent/);
});

test('the server wrote nothing to stderr during the browser tool calls', () => {
  assert.equal(stderr, '');
});
