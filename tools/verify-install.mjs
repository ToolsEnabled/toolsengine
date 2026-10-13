// Check an installed ToolsEngine version from outside, the way a client uses
// it: start the installed server over stdio and call its tools.
//
//   node verify-install.mjs --installed DIR --cert CERT.pem --key KEY.pem [--expect-tools N] [--desktop-own-window]
//
// DIR is the installed version folder (the one holding installation.json).
// The server is started with the settings recorded there, plus
// --allow-local-network and the test certificate as a trusted authority, so
// that web.fetch can read a page this script serves on 127.0.0.1 over HTTPS.
// Nothing outside this machine is contacted.
//
// Calls made: initialize, tools/list, system.status, workspace.list,
// web.fetch (local HTTPS page), and with a browser configured
// browser.navigate + browser.snapshot (local HTTP page) and browser.close.
//
// --desktop-own-window (Windows, installed with --desktop): opens one Notepad
// window on a file this script creates, calls desktop.inspect, keeps only the
// row of that window and inspects that window alone. Listing windows is how
// the tool works, so the list of open windows passes through this process;
// rows of other windows are not printed, stored or inspected. The Notepad
// process is ended afterwards.
//
// Uses only Node.js and the installed folder's own install.mjs.
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const installed = path.resolve(value('--installed') || '');
const record = JSON.parse(fs.readFileSync(path.join(installed, 'installation.json'), 'utf8'));
const { McpProcess } = await import(pathToFileURL(path.join(installed, 'install.mjs')).href);
const certFile = path.resolve(value('--cert'));
const expectTools = value('--expect-tools') ? Number(value('--expect-tools')) : null;
const marker = `toolsengine-verify-${randomBytes(6).toString('hex')}`;
const page = `<!doctype html><html><head><title>Local test page</title></head><body><h1>Local test page</h1><p>${marker}</p></body></html>`;

const requests = [];
const serve = (label, request, response) => {
  requests.push({ server: label, method: request.method, url: request.url, userAgent: request.headers['user-agent'] });
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(page) });
  response.end(page);
};
const secure = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(path.resolve(value('--key'))) }, (q, s) => serve('https', q, s));
const plain = http.createServer((q, s) => serve('http', q, s));
const listen = server => new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', () => resolve(server.address().port)));
const securePort = await listen(secure);
const plainPort = await listen(plain);

const results = [];
const note = (name, ok, detail) => { results.push({ check: name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail?.summary ? `  ${detail.summary}` : ''}`); };
const browserOn = !record.serverArgs.includes('--no-browser');
const began = Date.now();
const server = new McpProcess(record.node, [record.entry, ...record.serverArgs, '--allow-local-network'],
  { cwd: record.workspace, env: { ...process.env, NODE_EXTRA_CA_CERTS: certFile } });
let notepad;
try {
  const hello = await server.initialize('toolsengine-verify');
  note('handshake', hello.serverInfo?.name === 'toolsengine', { summary: `${hello.serverInfo?.name} ${hello.serverInfo?.version}, protocol ${hello.protocolVersion}, ${Date.now() - began} ms after start` });

  const listed = await server.request('tools/list', {});
  const names = listed.tools.map(tool => tool.name).sort();
  note('tools/list', expectTools === null || names.length === expectTools, { summary: `${names.length} tools${expectTools === null ? '' : ` (${expectTools} expected)`}`, names });

  const status = await server.callTool('system.status');
  const parsed = JSON.parse(status.text);
  // What the installer registers never switches the browser's sandbox off.
  const sandboxAsInstalled = !browserOn || parsed.browserSandbox === true;
  note('system.status', !status.isError && parsed.workspace === record.workspace && parsed.tools.length === names.length && sandboxAsInstalled,
    { summary: `version ${parsed.version}, ${parsed.platform}, node ${parsed.node}, browser ${parsed.browserEnabled ? `${parsed.browserSession}, sandbox ${parsed.browserSandbox === true ? 'on' : parsed.browserSandbox === false ? 'OFF' : 'not reported'}` : 'off'}, desktop ${parsed.desktopEnabled ? 'on' : 'off'}`, status: { ...parsed, tools: `${parsed.tools.length} names` } });

  const probe = `verify-${marker}.txt`;
  fs.writeFileSync(path.join(record.workspace, probe), 'placed by verify-install');
  const list = await server.callTool('workspace.list', {});
  const entries = JSON.parse(list.text);
  const listedNames = (entries.entries || []).map(entry => entry.name);
  note('workspace.list', !list.isError && listedNames.includes(probe), { summary: `${listedNames.length} entries, the probe file among them: ${listedNames.includes(probe)}`, entries: listedNames });
  fs.unlinkSync(path.join(record.workspace, probe));

  const fetched = await server.callTool('web.fetch', { url: `https://127.0.0.1:${securePort}/page` });
  const body = fetched.isError ? {} : JSON.parse(fetched.text);
  note('web.fetch (local HTTPS page)', !fetched.isError && String(body.body).includes(marker),
    { summary: fetched.isError ? fetched.text.slice(0, 200) : `status ${body.status}, ${body.bytes ?? String(body.body).length} bytes, marker found`, seenByTestServer: requests.filter(request => request.server === 'https') });

  if (browserOn) {
    const opened = await server.callTool('browser.navigate', { url: `http://127.0.0.1:${plainPort}/page` }, 90000);
    const snapshot = opened.isError ? opened : await server.callTool('browser.snapshot', {}, 60000);
    note('browser.navigate + browser.snapshot (local HTTP page)', !snapshot.isError && snapshot.text.includes(marker),
      { summary: snapshot.isError ? snapshot.text.split('\n').slice(0, 2).join(' ').slice(0, 300) : `page read through ${record.browser.id}, marker found`, seenByTestServer: requests.filter(request => request.server === 'http').length });
    await server.callTool('browser.close', {}, 30000).catch(() => {});
  }

  if (args.includes('--desktop-own-window')) {
    const token = randomBytes(4).toString('hex');
    const file = path.join(record.workspace, `te-own-${token}.txt`);
    fs.writeFileSync(file, `ToolsEngine install check ${token}`);
    notepad = spawn(path.join(process.env.SystemRoot, 'System32', 'notepad.exe'), [file], { stdio: 'ignore' });
    let mine = [];
    let total = 0;
    for (let attempt = 0; attempt < 20 && mine.length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const all = await server.callTool('desktop.inspect', {}, 60000);
      if (all.isError) { note('desktop.inspect (window list)', false, { summary: all.text.slice(0, 200) }); break; }
      const windows = JSON.parse(all.text).windows || [];
      total = windows.length;
      // Only the row of the window opened above is kept.
      mine = windows.filter(window => String(window.label).includes(token)).map(window => ({ id: window.id, label: window.label, application: window.application }));
    }
    note('desktop.inspect (own Notepad window found)', mine.length === 1, { summary: mine.length === 1 ? `"${mine[0].label}" (${mine[0].application}); ${total} windows were listed, the others were not kept` : `own window not found among ${total}` });
    if (mine.length === 1) {
      const inside = await server.callTool('desktop.inspect', { windowId: mine[0].id, includeText: true }, 60000);
      const controls = inside.isError ? [] : JSON.parse(inside.text).controls || [];
      const readBack = controls.some(control => typeof control.text === 'string' && control.text.includes(token));
      note('desktop.inspect (controls of the own window)', !inside.isError && controls.length > 0 && readBack, { summary: inside.isError ? inside.text.slice(0, 200) : `${controls.length} controls, the file text read back: ${readBack}` });
    }
    try { notepad.kill(); } catch { /* already gone */ }
    notepad = null;
    await new Promise(resolve => setTimeout(resolve, 500));
    try { fs.unlinkSync(file); } catch { /* left in the scratch workspace */ }
  }
} catch (error) {
  note('run', false, { summary: String(error.message || error).slice(0, 400) });
} finally {
  if (notepad) try { notepad.kill(); } catch { /* already gone */ }
  const closed = await server.close();
  note('server stopped when its input closed', !closed.forced, { summary: closed.forced ? 'had to be ended' : `exit ${closed.code}` });
  if (server.stderr.trim()) console.log(`server stderr: ${server.stderr.trim().slice(0, 600)}`);
  secure.close();
  plain.close();
}
const failed = results.filter(result => !result.ok);
console.log(JSON.stringify({ installed, version: record.version, serverArgs: [...record.serverArgs, '--allow-local-network'], passed: results.length - failed.length, failed: failed.length, results }, null, 1));
process.exitCode = failed.length ? 1 : 0;
