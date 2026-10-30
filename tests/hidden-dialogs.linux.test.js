import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// The --firefox-hidden browser keeps its dialogs and notifications in the
// agent's hidden session: the upload file chooser, a download, print, a
// desktop notification and links that would open another application. This
// drives the real stdio MCP server as an agent would, with MCP tools that
// earlier builds also offer. Run it inside a stand-in desktop session (a
// private display and session bus, such as the lead's decoy session) to see
// that nothing reaches that session's bus or screen; the test also checks
// that the hidden Firefox is on neither.

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const FIREFOX = ['/snap/firefox/current/usr/lib/firefox/firefox', '/usr/bin/firefox', '/usr/bin/firefox-esr'];
function unavailable() {
  if (process.platform !== 'linux') return 'Firefox mode requires Linux';
  if (!FIREFOX.some(file => existsSync(file))) return 'needs Firefox';
  for (const program of ['Xvfb', 'xauth', 'xdotool', 'dbus-daemon'])
    if (spawnSync('sh', ['-c', 'command -v "$0"', program]).status !== 0) return `needs ${program}`;
  if (spawnSync('/usr/bin/python3', ['-c', "import gi;gi.require_version('Atspi','2.0');from gi.repository import Atspi"]).status !== 0)
    return 'needs AT-SPI for Python (python3-gi, gir1.2-atspi-2.0)';
  return false;
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>Hidden dialogs fixture</title>
<p><label for="attachment">Attachment</label> <input id="attachment" type="file"></p>
<p id="chosen">No file chosen yet</p>
<p><a href="/hidden-report.bin">Download report</a></p>
<p><button onclick="print()">Print page</button></p>
<p><button onclick="new Notification('Fixture notice',{body:'From the hidden browser'});document.getElementById('notified').textContent='Notification sent'">Notify me</button> <span id="notified"></span></p>
<p><a href="mailto:fixture@example.invalid">Email the fixture</a></p>
<p><a href="te-fixture-app://open">Open the fixture app</a></p>
<script>document.getElementById('attachment').onchange=e=>document.getElementById('chosen').textContent='Chosen: '+e.target.files[0].name</script>`;

const argsOf = async pid => (await fs.readFile(`/proc/${pid}/cmdline`).catch(() => Buffer.from(''))).toString().split('\0');
const envOf = async pid => Object.fromEntries((await fs.readFile(`/proc/${pid}/environ`).catch(() => Buffer.from(''))).toString()
  .split('\0').filter(item => item.includes('=')).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]));
async function firefoxOf(profile) {
  const found = [];
  for (const entry of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const args = await argsOf(entry);
    if (args.some((value, index) => value === '--profile' && args[index + 1] === profile) && !args.includes('-contentproc')) found.push(Number(entry));
  }
  return found;
}
const receipt = async (profile, name) => JSON.parse(await fs.readFile(path.join(profile, name), 'utf8').catch(() => 'null'));

test('hidden Firefox keeps its file chooser, download, print, notification and external links in its hidden session', {
  timeout: 420000, skip: unavailable(),
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'te-hidden-dialogs-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace'), uploads = path.join(root, 'uploads');
  const profile = path.join(home, '.local', 'share', 'toolsengine', 'agent-firefox');
  await fs.mkdir(profile, { recursive: true, mode: 0o700 });
  await fs.mkdir(workspace); await fs.mkdir(uploads);
  // The fixture page may show notifications without a permission prompt.
  await fs.writeFile(path.join(profile, '.toolsengine-agent-firefox'), 'ToolsEngine dedicated Firefox profile v1\n', { mode: 0o600 });
  await fs.writeFile(path.join(profile, 'user.js'), 'user_pref("permissions.default.desktop-notification", 1);\n', { mode: 0o600 });
  const upload = path.join(uploads, 'hidden-upload.txt');
  await fs.writeFile(upload, 'uploaded from the hidden session\n');

  const site = http.createServer((req, res) => {
    if (req.url === '/hidden-report.bin') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="hidden-report.bin"' });
      return res.end(Buffer.alloc(4096, 7));
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(PAGE);
  });
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;

  const transport = new StdioClientTransport({
    command: process.execPath, cwd: workspace, stderr: 'pipe', env: { ...process.env, HOME: home },
    args: [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--firefox-hidden'],
  });
  let errors = '';
  transport.stderr?.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  const client = new Client({ name: 'toolsengine-hidden-dialogs', version: '1.0.0' });
  t.after(async () => {
    await client.close().catch(() => {});
    await new Promise(resolve => site.close(resolve));
    // Retire only what bears this fixture's own profile: its Firefox, its
    // private display and its private session bus.
    for (const pid of await firefoxOf(profile)) try { process.kill(pid, 'SIGTERM'); } catch {}
    await sleep(1000);
    const display = await receipt(profile, '.toolsengine-display.json');
    if (display && (await argsOf(display.pid)).includes(path.join(profile, display.auth))) try { process.kill(display.pid, 'SIGTERM'); } catch {}
    const buses = await receipt(profile, '.toolsengine-bus.json');
    for (const bus of [buses?.session, buses?.accessibility])
      if (bus && (await argsOf(bus.pid)).includes('--address=' + bus.address)) try { process.kill(bus.pid, 'SIGTERM'); } catch {}
    await fs.rm(root, { recursive: true, force: true });
  });
  await client.connect(transport);

  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
    const text = result.content?.map(part => part.text ?? '').join('\n') ?? '';
    assert.notEqual(result.isError, true, `${name}: ${text}\n${errors}`);
    return text;
  };
  const snapshot = () => call('browser.snapshot', { depth: 40 });
  const ref = (text, pattern) => {
    const found = pattern.exec(text)?.[1];
    assert.ok(found, `${pattern} is not in the snapshot:\n${text}`);
    return found;
  };
  const until = async (check, what, seconds = 20) => {
    for (const end = Date.now() + seconds * 1000; Date.now() < end; await sleep(500)) if (await check()) return;
    assert.fail(`${what} within ${seconds} seconds`);
  };

  await call('browser.tabs', { action: 'new', url });
  // A fresh profile may select its first-run tab: navigate the selected tab too.
  await call('browser.navigate', { url });
  await until(async () => /Hidden dialogs fixture/.test(await snapshot()), 'the fixture page did not load');

  // The upload file chooser: it opens in the hidden session and
  // browser.file_upload answers it there.
  let page = await snapshot();
  await call('browser.click', { ref: ref(page, /(?:push )?button "(?:Browse|Attachment)[^"\n]*"[^\n]*\[ref=([^\]]+)\]/) });
  assert.match(await call('browser.file_upload', { paths: [upload] }), /accepted "hidden-upload\.txt"/);
  await until(async () => /Chosen: hidden-upload\.txt/.test(await snapshot()), 'the page did not receive the chosen file');

  // A download is saved without a prompt.
  page = await snapshot();
  await call('browser.click', { ref: ref(page, /link "Download report"[^\n]*\[ref=([^\]]+)\]/) });
  await until(() => fs.stat(path.join(home, 'Downloads', 'hidden-report.bin')).then(info => info.size === 4096, () => false), 'the download was not saved');
  await call('browser.press_key', { key: 'Escape' });

  // Print: the print preview, and from there the system print dialog,
  // which Escape cancels.
  page = await snapshot();
  await call('browser.click', { ref: ref(page, /(?:push )?button "Print page"[^\n]*\[ref=([^\]]+)\]/) });
  await until(async () => /dialog "Print"/.test(page = await snapshot()), 'the print preview did not open');
  await call('browser.click', { ref: ref(page, /link "Print using the system dialog[^"\n]*"[^\n]*\[ref=([^\]]+)\]/) });
  await sleep(3000);
  await call('browser.press_key', { key: 'Escape' });
  await until(async () => !/dialog "Print"/.test(await snapshot()), 'the print dialog did not close');

  // A desktop notification.
  page = await snapshot();
  await call('browser.click', { ref: ref(page, /(?:push )?button "Notify me"[^\n]*\[ref=([^\]]+)\]/) });
  await until(async () => /Notification sent/.test(await snapshot()), 'the page did not send its notification');
  await sleep(2000);

  // Links that would open another application.
  for (const name of ['Email the fixture', 'Open the fixture app']) {
    await call('browser.navigate', { url });
    await until(async () => /Hidden dialogs fixture/.test(page = await snapshot()), 'the fixture page did not load again');
    await call('browser.click', { ref: ref(page, new RegExp(`link "${name}"[^\\n]*\\[ref=([^\\]]+)\\]`)) });
    await sleep(3000);
  }

  // The hidden Firefox is on neither the session's display nor its bus.
  const [pid] = await firefoxOf(profile);
  assert.ok(pid, 'the hidden Firefox is running');
  const env = await envOf(pid);
  const desktopBus = process.env.DBUS_SESSION_BUS_ADDRESS || `unix:path=/run/user/${process.getuid()}/bus`;
  assert.ok(env.DBUS_SESSION_BUS_ADDRESS, 'the hidden Firefox names its session bus');
  assert.notEqual(env.DBUS_SESSION_BUS_ADDRESS, desktopBus);
  assert.ok(!env.DBUS_SESSION_BUS_ADDRESS.includes(`/run/user/${process.getuid()}/bus`), env.DBUS_SESSION_BUS_ADDRESS);
  assert.notEqual(env.DISPLAY, process.env.DISPLAY);
  for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS'])
    if (env[name]) assert.notEqual(env[name], process.env[name], name);
  assert.ok(!String(env.AT_SPI_BUS_ADDRESS).includes(`/run/user/${process.getuid()}/at-spi/`), env.AT_SPI_BUS_ADDRESS);
});
