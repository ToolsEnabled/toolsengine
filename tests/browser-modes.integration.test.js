// Two things the tool texts say about the server's own browser, shown on the
// real server over stdio with a real browser and pages served on 127.0.0.1:
//
// - a download that a page starts is saved into artifacts/toolsengine under a
//   name derived from the site's, and replaces a file of the same name there;
// - with --profile-dir, closing the browser keeps cookies and sign-ins; with
//   the default temporary profile it discards them.
//
// The first is the behaviour of the browser dependency. It is stated, not
// changed; this test is the record of what is stated.
//
// And one about a browser that is already running and attached at startup
// (--cdp-endpoint): a download there is left to that browser. It goes where
// that browser saves its downloads, and nothing is copied into the workspace.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';
import { browserNeedsShortTemp, workspaceSocketTemp } from '../src/browser.js';
import { serverBrowserSkipped, ownBrowserSkipped } from './support/browser-under-test.js';

// attached: the server starts no browser of its own, so the options that
// choose and start one are left out. env: variables added to the environment
// the server is started with.
async function startServer(t, extraArgs = [], { attached = false, env } = {}) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-modes-')));
  const args = [process.env.TOOLSENGINE_TEST_ENTRY || fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--workspace', workspace, '--headless', ...extraArgs];
  if (process.env.TOOLSENGINE_TEST_BROWSER && !attached) args.push('--browser-executable', process.env.TOOLSENGINE_TEST_BROWSER);
  // Only for a machine where the browser under test cannot set its sandbox up.
  if (process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1' && !attached) args.push('--no-browser-sandbox');
  const client = new Client({ name: 'toolsengine-modes', version: '1.0.0' });
  // The server is stopped before its folders are removed: on Windows a running
  // browser holds its files, and removing them would wait for it.
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true; await client.close().catch(() => {}); } };
  t.after(async () => { await stop(); await fs.rm(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args, cwd: workspace, stderr: 'pipe', ...(env ? { env: { ...getDefaultEnvironment(), ...env } } : {}) }));
  const call = async (name, input = {}) => {
    const result = await client.callTool({ name, arguments: input });
    const text = (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    assert.notEqual(result.isError, true, `${name} failed: ${text.slice(0, 500)}`);
    return text;
  };
  return { workspace, call, stop };
}

async function serve(t, handler) {
  const site = http.createServer(handler);
  await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { site.closeAllConnections?.(); site.close(resolve); }));
  return `http://127.0.0.1:${site.address().port}`;
}

test('downloads use unique bounded files and preserve an existing site-named file', { timeout: 120000, skip: serverBrowserSkipped }, async t => {
  let served=0;
  const origin=await serve(t,(request,response)=>{
    if(request.url==='/file'){response.writeHead(200,{'content-type':'application/octet-stream','content-disposition':'attachment; filename="report (final).txt"'});response.end(`download number ${++served}`);}
    else {response.writeHead(200,{'content-type':'text/html'});response.end('<title>Downloads</title><a href="/file">Get the file</a>');}
  });
  const {workspace,call}=await startServer(t);await call('browser.navigate',{url:origin});
  const output=path.join(workspace,'artifacts','toolsengine'),saved=path.join(output,'report-final-.txt');await fs.writeFile(saved,'my own file');
  const reference=/link "Get the file" \[ref=([^\]]+)\]/.exec(await call('browser.snapshot'))?.[1];assert.ok(reference);
  const awaitFile=async expected=>{
    const inspect=async()=>{for(const name of await fs.readdir(output)){if(name.startsWith('download-')&&await fs.readFile(path.join(output,name),'utf8')===expected)return name;}return null;};
    const watcher=fs.watch(output);const timer=setTimeout(()=>watcher.return(),15000);
    try {let found=await inspect();if(found)return found;for await(const event of watcher){found=await inspect();if(found)return found;}throw new Error('download did not finish');}
    finally {clearTimeout(timer);await watcher.return();}
  };
  await call('browser.click',{target:reference});const first=await awaitFile('download number 1');
  await call('browser.click',{target:reference});const second=await awaitFile('download number 2');assert.notEqual(first,second);
  assert.equal(await fs.readFile(saved,'utf8'),'my own file');
  assert.equal((await fs.readdir(output)).filter(name=>name.startsWith('download-')).length,2);
});

test('closing the browser keeps cookies with --profile-dir and discards them with the temporary profile', { timeout: 180000, skip: serverBrowserSkipped }, async t => {
  const origin = await serve(t, (request, response) => {
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (request.url === '/sign-in') headers['set-cookie'] = 'session=kept-by-the-profile; Max-Age=3600; Path=/';
    response.writeHead(200, headers);
    response.end(`<!doctype html><title>Cookies</title><p>cookie header: [${request.headers.cookie || 'none'}]</p>`);
  });
  const cookieAfterClose = async extraArgs => {
    const { call, stop } = await startServer(t, extraArgs);
    await call('browser.navigate', { url: `${origin}/sign-in` });
    await call('browser.navigate', { url: `${origin}/show` });
    assert.match(await call('browser.snapshot'), /cookie header: \[session=kept-by-the-profile\]/, 'the cookie is there before the browser is closed');
    const closed = await call('browser.close');
    await call('browser.navigate', { url: `${origin}/show` });
    const page = await call('browser.snapshot');
    await stop();
    return { closed, page };
  };

  const profile = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-profile-')));
  t.after(() => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const dedicated = await cookieAfterClose(['--profile-dir', path.join(profile, 'dedicated')]);
  assert.match(dedicated.closed, /Its dedicated profile keeps its cookies and sign-ins/);
  assert.match(dedicated.page, /cookie header: \[session=kept-by-the-profile\]/, 'a dedicated profile keeps the cookie across browser.close');

  const temporary = await cookieAfterClose([]);
  assert.match(temporary.closed, /starts a new, empty browser/);
  assert.match(temporary.page, /cookie header: \[none\]/, 'the temporary profile is gone with the browser');
});

// On Linux an installed Chrome keeps its crash-report database under the
// account's configuration folder (XDG_CONFIG_HOME, ~/.config by default),
// whatever --user-data-dir says, and opens it with crash reporting switched
// off as well. The browser ToolsEngine starts is given a configuration folder
// of its own in the workspace, so it writes nothing under the account's.
test('the browser ToolsEngine starts writes nothing under the configuration folder of the environment it was started in', { timeout: 120000, skip: process.platform !== 'linux' ? 'XDG_CONFIG_HOME is a Linux convention' : serverBrowserSkipped }, async t => {
  const configHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-xdg-')));
  t.after(() => fs.rm(configHome, { recursive: true, force: true }));
  const { workspace, call } = await startServer(t, [], { env: { XDG_CONFIG_HOME: configHome } });
  await call('browser.navigate', { url: 'about:blank' });
  // The crash handler writes its database as the browser starts; a moment
  // more, for anything written after the first page.
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.deepEqual(await fs.readdir(configHome), [], 'the browser wrote into the configuration folder of the environment it was started in');
  const own = path.join(workspace, '.toolsengine-runtime', 'xdg-config');
  const stat = await fs.lstat(own);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'the browser has a configuration folder of its own in the workspace');
  assert.equal(stat.mode & 0o777, 0o700);
  // With Google Chrome under test, what it used to write under ~/.config is there instead.
  if (/\/chrome$/.test(process.env.TOOLSENGINE_TEST_BROWSER || '') && !/chromium/.test(process.env.TOOLSENGINE_TEST_BROWSER))
    assert.ok((await fs.readdir(own)).includes('google-chrome'), `Google Chrome keeps its crash-report database in the folder it was given; found ${(await fs.readdir(own)).join(', ') || 'nothing'}`);
});

test('in an attached browser a download is left to that browser: it is saved where that browser saves downloads, and nothing is copied into the workspace', { timeout: 120000, skip: ownBrowserSkipped }, async t => {
  const name = `toolsengine-attached-${randomBytes(5).toString('hex')}.txt`;
  const body = `download in the attached browser ${randomBytes(5).toString('hex')}`;
  const origin = await serve(t, (request, response) => {
    if (request.url === '/file') {
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` });
      response.end(body);
    } else {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><title>Downloads</title><a href="/file">Get the file</a>');
    }
  });

  // A browser that is already running, as the person's own would be, with its
  // own setting for where downloads go. It is started here, not by the server.
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'toolsengine-running-browser-')));
  const profile = path.join(root, 'profile');
  const ownDownloads = path.join(root, 'its own downloads');
  await fs.mkdir(path.join(profile, 'Default'), { recursive: true });
  await fs.mkdir(ownDownloads);
  await fs.writeFile(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ download: { default_directory: ownDownloads, prompt_for_download: false } }));
  // Like an installed Chrome it opens a socket in its temporary directory.
  const fixtureSocket = process.platform==='linux' ? await workspaceSocketTemp(root) : null;
  const shortTemp=fixtureSocket?.envPath;
  const running = spawn(process.env.TOOLSENGINE_TEST_BROWSER || chromium.executablePath(),
    // Match Playwright's fixture defaults: this empty synthetic profile must
    // not wait for the desktop's real password store before navigation.
    ['--headless', '--no-sandbox', '--password-store=basic', '--use-mock-keychain', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'],
    // The home is the test's folder too: should the setting above not be read, the file still lands inside it.
    { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, env: { ...process.env, HOME: root, ...(shortTemp ? { TMPDIR: shortTemp } : {}) } });
  let server;
  t.after(async () => {
    await server?.stop();
    if (running.exitCode === null && running.signalCode === null) {
      const gone = new Promise(resolve => running.once('close', resolve));
      running.kill();
      await Promise.race([gone, new Promise(resolve => setTimeout(resolve, 5000))]);
      if (running.exitCode === null && running.signalCode === null) running.kill('SIGKILL');
    }
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fixtureSocket?.close();
  });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`the browser did not announce its debugging address: ${output.slice(0, 400)}`)), 20000);
    running.once('error', error => { clearTimeout(timer); reject(error); });
    running.stderr.on('data', chunk => {
      output += chunk.toString();
      const match = output.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });

  server = await startServer(t, ['--cdp-endpoint', endpoint], { attached: true });
  const { workspace, call } = server;
  await call('browser.navigate', { url: origin });
  const reference = /link "Get the file" \[ref=([^\]]+)\]/.exec(await call('browser.snapshot'))?.[1];
  assert.ok(reference, 'the link was not found in the snapshot');
  const clicked = await call('browser.click', { target: reference });

  // Every file under a folder, with its content when it is small.
  const filesUnder = async folder => {
    const found = [];
    for (const entry of await fs.readdir(folder, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      found.push({ file, content: stat && stat.size < 4096 ? await fs.readFile(file, 'utf8').catch(() => '') : '' });
    }
    return found;
  };
  // Wait until the download has arrived somewhere: in the browser's own
  // folder, as it should, or in the workspace, as it did before.
  let own = [], copied = [];
  for (let waited = 0; waited < 20000 && !own.length && !copied.length; waited += 250) {
    await new Promise(resolve => setTimeout(resolve, 250));
    own = (await filesUnder(ownDownloads)).filter(item => item.content === body);
    copied = (await filesUnder(workspace)).filter(item => item.content === body);
  }
  // A moment more, for a copy that follows the download.
  await new Promise(resolve => setTimeout(resolve, 1500));
  own = (await filesUnder(ownDownloads)).filter(item => item.content === body);
  copied = (await filesUnder(workspace)).filter(item => item.content === body);
  assert.deepEqual(copied.map(item => path.relative(workspace, item.file)), [], 'the download was copied into the workspace');
  assert.deepEqual(own.map(item => path.basename(item.file)), [name], 'the download is where the running browser saves its downloads, under the name the site gave');
  assert.doesNotMatch(clicked, /Download(?:ing|ed) file/, 'the result must not speak of a file saved by ToolsEngine');
  assert.doesNotMatch(await call('browser.snapshot'), /Download(?:ing|ed) file/, 'nor the result of the next call');
  assert.deepEqual((await fs.readdir(path.join(workspace, 'artifacts', 'toolsengine'))).filter(item => !/^page-.*\.yml$/.test(item)), [], 'only page snapshots are in the output folder');
});
