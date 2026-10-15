// The installer of the release archive (installer/install.mjs).
//
// The end-to-end tests build a small stand-in archive in a temporary folder:
// the real installer, a stand-in server that speaks just enough MCP, and
// stand-in "claude" and "codex" commands that record how they were called.
// The folder names contain a space and brackets on purpose. No real client,
// no real client configuration and no network are involved, and nothing is
// written outside the temporary folder.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, browserCandidates, browserPlan, pickBrowser, displayCommand, clientCommands,
  compareWithRelease, readRelease, sha256, findOnPath, browserFailure, Stop,
} from '../installer/install.mjs';
// Functions added after the first version are taken from here, so that a test
// of one of them fails on its own against an installer that lacks it.
import * as installerModule from '../installer/install.mjs';

const INSTALLER = fileURLToPath(new URL('../installer/install.mjs', import.meta.url));
const HARNESS = fileURLToPath(new URL('../tools/install-with-profile.mjs', import.meta.url));
const VERSION = '9.9.9-test.1';
const windows = process.platform === 'win32';

// --- pure functions ---------------------------------------------------------

test('command line: commands, client lists in every spelling, and refusals', () => {
  assert.equal(parseArgs([]).command, 'install');
  assert.deepEqual(parseArgs([]).register, []);
  assert.equal(parseArgs([]).desktop, false, 'desktop tools are off unless asked for');
  assert.equal(parseArgs([]).browser, 'auto');
  assert.deepEqual(parseArgs(['--register', 'claude,codex']).register, ['claude', 'codex']);
  // PowerShell splits "claude,codex" into two words before the program sees it.
  assert.deepEqual(parseArgs(['--register', 'claude', 'codex', '--dry-run']).register, ['claude', 'codex']);
  assert.deepEqual(parseArgs(['--register', 'all']).register, ['claude', 'codex']);
  assert.deepEqual(parseArgs(['--register', 'Codex']).register, ['codex']);
  assert.deepEqual(parseArgs(['register', 'codex', 'claude', '--replace']).register, ['codex', 'claude']);
  assert.equal(parseArgs(['install', '--no-check']).check, false);
  assert.equal(parseArgs([]).headed, false, 'the browser is hidden unless asked for');
  assert.equal(parseArgs(['--headed']).headed, true);
  assert.equal(parseArgs(['uninstall', '--version', '0.1.3-rc.1']).version, '0.1.3-rc.1');
  assert.ok(path.isAbsolute(parseArgs(['--workspace', 'relative/folder']).workspace));
  for (const bad of [['--register'], ['--register', 'cursor'], ['frobnicate'], ['--unknown'], ['--workspace'], ['--name', 'has space'],
    ['--desktop-left-half'], ['--replace'], ['register'], ['uninstall', '--version', '../x'], ['stray-word-after', 'x'], ['--register', 'claude', '--workspace'],
    ['--headed', '--browser', 'none'],
    // --version chooses an installed version to act on; an install is always this installer's version.
    ['--version', '9.9.9'], ['install', '--version', '9.9.9'],
    // An empty value must not turn into the folder the installer was started in.
    ['--workspace', ''], ['--home', ''], ['--install-root', '  '], ['--name', ''], ['--browser', ''], ['uninstall', '--version', '']])
    assert.throws(() => parseArgs(bad), Stop, `accepted: ${bad.join(' ')}`);
  // On the install command the refusal explains itself whether or not a value
  // follows: a bare --version used to be answered with "needs a value".
  for (const args of [['--version'], ['--version', '9.9.9'], ['--dry-run', '--version'], ['install', '--version'], ['install', '--version', '9.9.9']])
    assert.throws(() => parseArgs(args), error => error instanceof Stop && /^--version is for register, check, list and uninstall\./.test(error.message), `wrong refusal: ${args.join(' ')}`);
  assert.throws(() => parseArgs(['uninstall', '--version']), error => error instanceof Stop && /^--version needs a value\./.test(error.message));
});

test('browser search: Chrome before Edge, in the places Playwright looks', () => {
  const present = list => file => list.includes(file);
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
  const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.deepEqual(browserCandidates({ platform: 'win32', env, profile: 'C:\\Users\\a', exists: present([chrome, edge]) }), [
    { id: 'chrome', path: chrome, args: ['--browser-executable', chrome] },
    { id: 'msedge', path: edge, args: ['--browser-executable', edge] },
  ]);
  assert.deepEqual(browserCandidates({ platform: 'win32', env, profile: 'C:\\Users\\a', exists: present([edge]) }).map(c => c.id), ['msedge']);
  // A per-user Chrome is looked for under the given profile, not under an
  // environment variable that another account's launcher may have set.
  const perUser = 'C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
  assert.deepEqual(browserCandidates({ platform: 'win32', env: { ...env, LOCALAPPDATA: 'C:\\Users\\other\\AppData\\Local' }, profile: 'C:\\Users\\a', exists: present([perUser]) }).map(c => c.path), [perUser]);
  assert.deepEqual(browserCandidates({ platform: 'win32', env, profile: 'C:\\Users\\a', exists: () => false }), []);
  assert.deepEqual(browserCandidates({ platform: 'linux', env: {}, profile: '/home/a', exists: present(['/opt/google/chrome/chrome', '/usr/bin/chromium']) }), [
    { id: 'chrome', path: '/opt/google/chrome/chrome', args: ['--browser-executable', '/opt/google/chrome/chrome'] },
    { id: 'chromium', path: '/usr/bin/chromium', args: ['--browser-executable', '/usr/bin/chromium'] },
  ]);
});

test('browser search: Playwright\'s Chromium counts only as the exact, completely downloaded build', () => {
  const cache = '/home/a/.cache/ms-playwright';
  const binary = `${cache}/chromium-1247/chrome-linux64/chrome`;
  const complete = [binary, `${cache}/chromium-1247/INSTALLATION_COMPLETE`, `${cache}/chromium_headless_shell-1247/INSTALLATION_COMPLETE`];
  const search = files => browserCandidates({ platform: 'linux', env: {}, profile: '/home/a', chromiumRevision: '1247', exists: file => files.includes(file) });
  assert.deepEqual(search(complete), [{ id: 'playwright', path: binary, args: ['--browser-executable',binary] }]);
  assert.deepEqual(search(complete.slice(0, 1)), [], 'half a download is not a browser');
  assert.deepEqual(search([`${cache}/chromium-1243/INSTALLATION_COMPLETE`, `${cache}/chromium_headless_shell-1243/INSTALLATION_COMPLETE`]), [], 'another build is not the tested one');
  // Installed browsers come first.
  assert.deepEqual(search([...complete, '/opt/google/chrome/chrome']).map(c => c.id), ['chrome', 'playwright']);
});

test('browser choice: auto, none, by name, by path', () => {
  const chrome = { id: 'chrome', path: '/opt/google/chrome/chrome', args: ['--browser-channel', 'chrome'] };
  const edge = { id: 'msedge', path: '/opt/microsoft/msedge/msedge', args: ['--browser-channel', 'msedge'] };
  assert.deepEqual(browserPlan('auto', [chrome, edge]).tryInOrder, [chrome, edge]);
  assert.deepEqual(browserPlan('auto', []).tryInOrder, []);
  assert.deepEqual(browserPlan('none', [chrome]).tryInOrder, []);
  assert.deepEqual(browserPlan('msedge', [chrome, edge]).tryInOrder, [edge]);
  // Named but not found: the request is kept and marked.
  assert.deepEqual(browserPlan('msedge', [chrome]).tryInOrder, [{ id: 'msedge', path: null, args: ['--browser-channel', 'msedge'], notFound: true }]);
  assert.deepEqual(browserPlan('playwright', []).tryInOrder, [{ id: 'playwright', path: null, args: [], notFound: true }]);
  const own = windows ? 'C:\\Browsers\\own.exe' : '/opt/own/browser';
  assert.deepEqual(browserPlan(own, [], { exists: () => true }).tryInOrder, [{ id: 'custom', path: own, args: ['--browser-executable', own] }]);
  assert.throws(() => browserPlan(own, [], { exists: () => false }), Stop);
  assert.throws(() => browserPlan('firefox', [chrome]), Stop);
  assert.throws(() => browserPlan('chromium', [chrome]), Stop);
});

test('browser check: the first browser that starts is kept', async () => {
  const chrome = { id: 'chrome' }, edge = { id: 'msedge' };
  const good = { ok: true, browser: 'started' }, noBrowser = { ok: true, browser: 'failed', browserProblem: 'did not start' }, noServer = { ok: false, browser: 'not tried' };
  const run = answers => { const seen = []; return [seen, async candidate => { seen.push(candidate?.id ?? null); return answers[candidate?.id ?? 'none']; }]; };

  let [seen, check] = run({ chrome: good, msedge: good });
  let picked = await pickBrowser([chrome, edge], check);
  assert.deepEqual([picked.chosen, seen], [chrome, ['chrome']]);

  [seen, check] = run({ chrome: noBrowser, msedge: good });
  picked = await pickBrowser([chrome, edge], check);
  assert.deepEqual([picked.chosen, seen, picked.check.candidate], [edge, ['chrome', 'msedge'], 'msedge']);
  assert.equal(picked.attempts[0].browserProblem, 'did not start');

  // None starts: the first stays configured and its failure is reported.
  [seen, check] = run({ chrome: noBrowser, msedge: noBrowser });
  picked = await pickBrowser([chrome, edge], check);
  assert.deepEqual([picked.chosen, picked.check.candidate, picked.check.browser], [chrome, 'chrome', 'failed']);

  // The server itself does not start: no second browser is tried.
  [seen, check] = run({ chrome: noServer, msedge: good });
  picked = await pickBrowser([chrome, edge], check);
  assert.deepEqual([picked.chosen, seen, picked.check.ok], [chrome, ['chrome'], false]);

  // No browser at all: one check, without a browser.
  [seen, check] = run({ none: { ok: true, browser: 'off' } });
  picked = await pickBrowser([], check);
  assert.deepEqual([picked.chosen, seen], [undefined, [null]]);
});

test('client commands are each client\'s own, and print so that they can be pasted', () => {
  const server = ['/usr/bin/node', '/home/a/ToolsEngine/1.0.0/app/bin/toolsengine.js', '--workspace', '/home/a/My Files'];
  assert.deepEqual(clientCommands('claude', 'toolsengine', server), {
    add: ['mcp', 'add', '--scope', 'user', 'toolsengine', '--', ...server],
    remove: ['mcp', 'remove', 'toolsengine', '--scope', 'user'],
    show: ['mcp', 'get', 'toolsengine'],
  });
  assert.deepEqual(clientCommands('codex', 'toolsengine', server), {
    add: ['mcp', 'add', 'toolsengine', '--', ...server],
    remove: ['mcp', 'remove', 'toolsengine'],
    show: ['mcp', 'get', 'toolsengine'],
  });
  assert.equal(displayCommand(['claude', ...clientCommands('claude', 'toolsengine', server).add], 'linux'),
    `claude mcp add --scope user toolsengine -- /usr/bin/node /home/a/ToolsEngine/1.0.0/app/bin/toolsengine.js --workspace '/home/a/My Files'`);
  assert.equal(displayCommand(['a', `it's`], 'linux'), `a 'it'\\''s'`);
  // On Windows the bare "--" is printed quoted: PowerShell takes a bare one away
  // when the command is one of the .ps1 launchers npm writes.
  assert.equal(displayCommand(['codex.cmd', 'mcp', 'add', 'toolsengine', '--', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\a\\ToolsEngine\\1.0.0\\app\\bin\\toolsengine.js', '--workspace', 'C:\\Users\\a\\My Files\\'], 'win32'),
    'codex.cmd mcp add toolsengine "--" "C:\\Program Files\\nodejs\\node.exe" C:\\Users\\a\\ToolsEngine\\1.0.0\\app\\bin\\toolsengine.js --workspace "C:\\Users\\a\\My Files\\\\"');
  assert.equal(displayCommand(['claude', 'mcp', 'add', 'x', '--', 'node'], 'linux'), 'claude mcp add x -- node', 'elsewhere it stays as it is');
});

test('printed commands on Windows: what PowerShell would split or read into is quoted, and what no quoting can fix is said', () => {
  const { pasteNote } = installerModule;
  assert.equal(typeof pasteNote, 'function');
  // A comma makes two words of one in PowerShell.
  assert.equal(displayCommand(['claude.cmd', 'mcp', 'add', 'C:\\Users\\a\\Smith,John\\x.js'], 'win32'), 'claude.cmd mcp add "C:\\Users\\a\\Smith,John\\x.js"');
  assert.equal(displayCommand(['a', '--register', 'claude,codex'], 'win32'), 'a --register "claude,codex"');
  assert.equal(displayCommand(['a', 'b,c'], 'linux'), 'a b,c');
  // Nothing to say about ordinary paths, with or without spaces and brackets.
  assert.equal(pasteNote(['claude.cmd', 'mcp', 'add', '--', 'C:\\Program Files (x86)\\nodejs\\node.exe', 'C:\\Users\\a b\\x.js'], 'win32'), null);
  // $ and a backtick are read by PowerShell, % by Command Prompt, inside double quotes too.
  for (const word of ['C:\\Users\\a\\$HOME\\x.js', 'C:\\Users\\a\\back`tick\\x.js', 'C:\\Users\\a\\100%\\x.js', 'say "hi"']) {
    const note = pasteNote(['claude.cmd', 'mcp', 'add', word], 'win32');
    assert.ok(note && note.includes(word), `no note for ${word}`);
    assert.match(note, /Command Prompt and PowerShell read differently/);
  }
  // & | < > and ^ are plain characters to Command Prompt inside the quotes the
  // line is printed with. A client installed through npm is a .cmd launcher,
  // though, and started from PowerShell such a word reaches Command Prompt
  // without its quotes: "C:\R&D\ws" would be cut at the &. The note says which
  // terminal the line is right for.
  for (const word of ['C:\\R&D\\ws', 'C:\\either|or', 'C:\\a<b', 'C:\\a>b', 'C:\\up^side']) {
    assert.equal(displayCommand(['claude.cmd', 'mcp', 'add', word], 'win32'), `claude.cmd mcp add "${word}"`, 'the word is quoted, which is all Command Prompt needs');
    for (const launcher of ['claude.cmd', 'C:\\Users\\a\\AppData\\Roaming\\npm\\codex.CMD', 'tool.bat', 'claude']) {
      const note = pasteNote([launcher, 'mcp', 'add', 'toolsengine', '--', 'C:\\Program Files\\nodejs\\node.exe', '--workspace', word], 'win32');
      assert.ok(note && note.includes(`(${word})`), `no note for ${word} with ${launcher}`);
      assert.match(note, /In Command Prompt the line is right as it stands\. In PowerShell it is not/);
      assert.match(note, /Paste it into Command Prompt, or choose a folder without such a character\./);
    }
    // A client that is a real program is handed the word by PowerShell itself.
    assert.equal(pasteNote(['C:\\Tools\\claude.exe', 'mcp', 'add', word], 'win32'), null, word);
    assert.equal(pasteNote(['claude', 'mcp', 'add', word], 'linux'), null);
  }
  // The character in the name of the launcher itself is not a word handed to it.
  assert.match(pasteNote(['C:\\R&D\\claude.exe', 'mcp', 'add', 'x'], 'win32'), /invocation operator/);
  // Outside Windows single quotes settle it.
  assert.equal(pasteNote(['claude', 'mcp', 'add', '/home/a/$HOME/100%'], 'linux'), null);
  assert.equal(displayCommand(['claude', '/home/a/$HOME/100%'], 'linux'), "claude '/home/a/$HOME/100%'");
});

test('a release description that names a path outside its own folder is not accepted', t => {
  // release.json decides which files are copied at install and removed at
  // uninstall. Each path has to stay inside the folder it sits in.
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsengine-release-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const describe = (files, entry = 'app/bin/toolsengine.js') => {
    fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify({ name: 'ToolsEngine', version: '1.0.0', entry, files: files.map(name => ({ path: name, size: 1, sha256: 'x', mode: '644' })) }));
    return readRelease(folder);
  };
  assert.equal(describe(['app/bin/toolsengine.js', 'install.mjs']).files.length, 2);
  for (const hostile of ['../outside.txt', 'app/../../outside.txt', '/etc/passwd', 'C:/Windows/win.ini', 'C:\\Windows\\win.ini', 'app\\..\\..\\outside.txt', 'app//x', 'app/./x', './x', 'app/', '', 'app/x\0y', 'D:x', 'stream.txt:hidden'])
    assert.throws(() => describe(['install.mjs', hostile]), Stop, `accepted: ${JSON.stringify(hostile)}`);
  assert.throws(() => describe(['install.mjs'], '../../somewhere/else.js'), Stop, 'the entry point is held to the same rule');
  // And what does not describe this program at all.
  for (const other of [{ name: 'Something', version: '1.0.0', entry: 'a', files: [{ path: 'a' }] }, { name: 'ToolsEngine', version: '../1.0.0', entry: 'a', files: [{ path: 'a' }] },
    { name: 'ToolsEngine', version: '1.0.0', entry: 'a', files: [] }, { name: 'ToolsEngine', version: '1.0.0', files: [{ path: 'a' }] }]) {
    fs.writeFileSync(path.join(folder, 'release.json'), JSON.stringify(other));
    assert.throws(() => readRelease(folder), Stop, JSON.stringify(other));
  }
});

test('the check knows the one file its blank page left, by the name the server gives it', () => {
  const { snapshotFileOf } = installerModule;
  assert.equal(typeof snapshotFileOf, 'function');
  assert.equal(snapshotFileOf('### Page\n- Page URL: about:blank\n### Snapshot\n- [Snapshot](artifacts/toolsengine/page-2026-10-10T18-43-44-742Z.yml)'), 'page-2026-10-10T18-43-44-742Z.yml');
  // The real server on Windows writes the link with backslashes (seen by running it there).
  assert.equal(snapshotFileOf('### Snapshot\n- [Snapshot](artifacts\\toolsengine\\page-2026-10-10T18-56-03-831Z.yml)'), 'page-2026-10-10T18-56-03-831Z.yml');
  // Nothing that is not a plain snapshot name in that folder.
  for (const text of ['', 'ok', '- [Snapshot](artifacts/toolsengine/../../notes.yml)', '- [Snapshot](artifacts/toolsengine/report.pdf)', '- [Snapshot](artifacts/toolsengine/sub/page-1.yml)',
    '- [Snapshot](/etc/page-1.yml)', '- [Snapshot](artifacts/toolsengine/page-1.yml.exe)', '- [Download](artifacts/toolsengine/page-1.yml)',
    '- [Snapshot](artifacts\\toolsengine\\..\\page-1.yml)', '- [Snapshot](artifacts\\toolsengine\\sub\\page-1.yml)'])
    assert.equal(snapshotFileOf(text), null, text);
});

test('a failed browser start is reported with the line that says why', () => {
  const text = ['### Error', 'Error: browserType.launch: Target page, context or browser has been closed', 'Browser logs:', '',
    '<launching> /opt/google/chrome/chrome --disable-field-trial-config --no-startup-window', '<launched> pid=1612857',
    '[pid=1612857][err] [1010/080608.436394:WARNING:chrome/app/chrome_main_linux.cc:84] Read channel stable from /opt/google/chrome/CHROME_VERSION_EXTRA',
    '[pid=1612857][err] [1612857:1612857:1010/080611.248599:FATAL:chrome/browser/process_singleton_posix.cc:313] Socket path too long: /a/long/path/SingletonSocket.',
    'Call log:', '  - <launching> /opt/google/chrome/chrome'].join('\n');
  assert.equal(browserFailure(text), 'Socket path too long: /a/long/path/SingletonSocket. (Error: browserType.launch: Target page, context or browser has been closed)');
  assert.equal(browserFailure("### Error\nError: browserType.launch: Executable doesn't exist at /x/chrome\n"), "Error: browserType.launch: Executable doesn't exist at /x/chrome");
  assert.equal(browserFailure(''), 'The browser did not start.');
  // The server's refusal for want of the sandbox is passed on, however long,
  // in the words for a person: the server writes it for the assistant that
  // gets it as a tool result. The sentences for the assistant are left out.
  const refusal = `The browser did not start, because its sandbox could not be set up. It keeps a web page from acting as the person's account. ${'A long sentence about the browser that failed. '.repeat(30)}`
    + 'What the person can do: repair or reinstall that browser. There is also a startup option, --no-browser-sandbox; a page can then change whatever the person\'s account can. '
    + 'For the assistant reading this: whether to switch the sandbox off is the person\'s decision. Tell them what this message says, and do not change ToolsEngine\'s configuration or registration yourself.';
  const shown = browserFailure(refusal);
  assert.match(shown, /^The browser did not start, because its sandbox could not be set up\. It keeps a web page from acting as your account\./);
  assert.match(shown, /What you can do: repair or reinstall that browser\. There is also a startup option, --no-browser-sandbox; a page can then change whatever your account can\.$/);
  assert.doesNotMatch(shown, /the person|assistant|Tell them/);
  assert.ok(shown.length > 1400, 'nothing of the explanation is cut off');
});

// --- end to end, on a stand-in archive ---------------------------------------

const STAND_IN_SERVER = `#!/usr/bin/env node
import readline from 'node:readline';
import fs from 'node:fs';
const args = process.argv.slice(2);
const value = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const browser = !args.includes('--no-browser');
const desktop = args.includes('--desktop-profile-root');
const names = ['workspace.list', 'system.status', 'capability.find', ...(browser ? ['browser.navigate', 'browser.close'] : []), ...(desktop ? ['desktop.inspect'] : [])];
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const text = value => ({ content: [{ type: 'text', text: value }] });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  // To stand for a person pressing Ctrl+C while the installer checks the server.
  if (message.method === 'initialize' && process.env.STAND_IN_KILL_INSTALLER === '1') { process.kill(process.ppid); process.exit(0); }
  if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'toolsengine', version: '${VERSION}' } });
  else if (message.method === 'tools/list') reply(message.id, { tools: names.map(name => ({ name, inputSchema: { type: 'object' } })) });
  else if (message.params.name === 'system.status') reply(message.id, text(JSON.stringify({ version: '${VERSION}', platform: process.platform, node: process.version, workspace: value('--workspace'), browserEnabled: browser, desktopEnabled: desktop })));
  else if (message.params.name === 'browser.navigate' && value('--browser-executable')?.includes('broken')) reply(message.id, { isError: true, ...text('The stand-in browser does not start.') });
  else if (message.params.name === 'browser.navigate') {
    fs.mkdirSync('artifacts/toolsengine', { recursive: true });
    fs.writeFileSync('artifacts/toolsengine/page-2026-01-01T00-00-00-000Z.yml', '');
    // Files that another server, working in the same workspace, saves at this very moment.
    if (process.env.STAND_IN_OTHER_ARTIFACTS === '1') for (const name of ['page-2026-01-01T00-00-00-001Z.yml', 'screenshot.png', 'report.pdf', 'downloaded-invoice.txt']) fs.writeFileSync('artifacts/toolsengine/' + name, 'saved by another server');
    // As in the real server, the last of --headed and --headless counts.
    if (args.lastIndexOf('--headed') > args.lastIndexOf('--headless')) fs.writeFileSync('a-window-was-opened.txt', 'visible');
    // The real server's answer for a blank page.
    reply(message.id, text('### Page\\n- Page URL: about:blank\\n### Snapshot\\n- [Snapshot](artifacts/toolsengine/page-2026-01-01T00-00-00-000Z.yml)'));
  }
  else reply(message.id, text('ok'));
}).on('close', () => process.exit(0));
`;

// Stands in for "claude" and "codex": it records how it was called and keeps
// a list of registered servers. Like Claude Code it refuses to add a name that
// exists and keeps its user-scope servers in CLAUDE_CONFIG_DIR/.claude.json.
// Like Codex it replaces an entry of the same name without a word.
// STAND_IN_REFUSE_ADD_CONTAINING makes it refuse an add whose server command
// holds that text.
const STAND_IN_CLIENT = `import fs from 'node:fs';
import path from 'node:path';
const [client, ...words] = process.argv.slice(2);
const file = process.env.STAND_IN_CLIENT_STATE;
const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { calls: [], registered: {}, settings: {} };
state.settings ||= {};
let code = 0;
const key = name => client + ':' + name;
if (words[0] !== 'write-configuration') state.calls.push([client, ...words]);
if (words[1] === 'get') { if (!state.registered[key(words[2])]) { console.error("Error: No MCP server named '" + words[2] + "' found."); code = 1; } }
else if (words[1] === 'add') {
  const separator = words.indexOf('--');
  const name = client === 'claude' ? words[4] : words[2];
  const refused = process.env.STAND_IN_REFUSE_ADD_CONTAINING;
  if (refused && words.slice(separator + 1).join(' ').includes(refused)) { console.log('error: the stand-in client refuses this command'); code = 1; }
  else if (client === 'claude' && state.registered[key(name)]) { console.log('MCP server ' + name + ' already exists in user config'); code = 1; }
  else {
    state.registered[key(name)] = words.slice(separator + 1);
    state.settings[key(name)] = words.includes('-e') && words.indexOf('-e') < separator ? words.slice(words.indexOf('-e') + 1, separator) : [];
    console.log('Added ' + name);
  }
} else if (words[1] === 'remove') {
  if (state.registered[key(words[2])]) { delete state.registered[key(words[2])]; delete state.settings[key(words[2])]; }
  else if (client === 'claude') { console.log('No MCP server named "' + words[2] + '" in user scope'); code = 1; }
}
fs.writeFileSync(file, JSON.stringify(state));
if (client === 'claude') {
  const mcpServers = Object.assign({}, state.otherClaudeServers);
  for (const [name, command] of Object.entries(state.registered)) if (name.startsWith('claude:'))
    mcpServers[name.slice(7)] = { type: 'stdio', command: command[0], args: command.slice(1),
      env: Object.fromEntries((state.settings[name] || []).map(pair => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])) };
  fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ userID: 'stand-in', mcpServers }));
}
process.exit(code);
`;

let base, bundle, bin, home, stateFile, environment, emptyFolder;

function makeBundle(directory) {
  fs.mkdirSync(path.join(directory, 'app', 'bin'), { recursive: true });
  fs.copyFileSync(INSTALLER, path.join(directory, 'install.mjs'));
  fs.copyFileSync(new URL('../installer/windows-security.ps1', import.meta.url), path.join(directory, 'windows-security.ps1'));
  fs.writeFileSync(path.join(directory, 'app', 'bin', 'toolsengine.js'), STAND_IN_SERVER);
  fs.writeFileSync(path.join(directory, 'app', 'README.md'), '# stand-in\n');
  fs.writeFileSync(path.join(directory, 'app', 'package.json'), JSON.stringify({ name: 'stand-in', version: VERSION, type: 'module' }));
  const files = ['install.mjs', 'windows-security.ps1', 'app/bin/toolsengine.js', 'app/README.md', 'app/package.json'].map(name => {
    const data = fs.readFileSync(path.join(directory, ...name.split('/')));
    return { path: name, size: data.length, sha256: sha256(data), mode: name.endsWith('toolsengine.js') ? '755' : '644' };
  });
  fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify({
    name: 'ToolsEngine', version: VERSION, commit: '0123456789abcdef', target: `${windows ? 'windows' : process.platform}-x64`, node: '>=22.14.0',
    entry: 'app/bin/toolsengine.js', tools: { core: 5, withoutBrowser: 3, windowsDesktop: 1 }, browser: { bundled: false, chromiumRevision: '1' }, files,
  }));
}

// Every run goes through tools/install-with-profile.mjs, which tells the
// installer which folder is this account's own profile: the home of the test,
// not the profile of whoever runs the tests. That harness refuses an
// installer that cannot be told, so nothing is ever installed into a real
// profile from here. The installer is not given --home: where it installs and
// whose client configuration it changes both follow from the profile.
// profile: null starts the installer by itself, with the profile the
// operating system records; the one test that does so names the test's
// folder with --home.
function run(script, args, extraEnv = {}, { profile = home } = {}) {
  assertSealed({ ...environment, ...extraEnv });
  const command = profile === null ? [script, ...args] : [HARNESS, profile, script, ...args];
  const result = spawnSync(process.execPath, command, { encoding: 'utf8', env: { ...environment, ...extraEnv }, timeout: 120000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}
const installer = (args, extraEnv, how) => run(path.join(bundle, 'install.mjs'), args, extraEnv, how);
const installed = (...parts) => path.join(home, 'ToolsEngine', VERSION, ...parts);
// The installed copy's own installer.
const fromInstalled = (args, extraEnv, how) => run(installed('install.mjs'), args, extraEnv, how);
const clientState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { calls: [], registered: {} };
const record = () => JSON.parse(fs.readFileSync(installed('installation.json'), 'utf8'));
const reset = () => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(stateFile, { force: true });
  fs.rmSync(environment.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
};
// Give the stand-in clients earlier registrations, and no recorded calls. The
// stand-in Claude Code then writes its configuration file from them.
function seedClients(registered, settings = {}, otherClaudeServers = {}) {
  fs.writeFileSync(stateFile, JSON.stringify({ calls: [], registered, settings, otherClaudeServers }));
  const written = spawnSync(process.execPath, [path.join(bin, 'stand-in-client.mjs'), 'claude', 'write-configuration'], { encoding: 'utf8', env: environment });
  assert.equal(written.status, 0, written.stderr);
}

before(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'toolsengine installer (test) ')));
  bundle = path.join(base, 'extracted archive');
  bin = path.join(base, 'client commands');
  home = path.join(base, 'home of (a) person');
  stateFile = path.join(base, 'client-state.json');
  makeBundle(bundle);
  emptyFolder = path.join(base, 'an empty folder');
  fs.mkdirSync(emptyFolder);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'stand-in-client.mjs'), STAND_IN_CLIENT);
  for (const client of ['claude', 'codex']) {
    // The same shape as the launchers npm writes: a .cmd on Windows that
    // passes its arguments on with %*, a script elsewhere.
    if (windows) fs.writeFileSync(path.join(bin, `${client}.cmd`), `@ECHO off\r\n"${process.execPath}" "%~dp0stand-in-client.mjs" ${client} %*\r\n`);
    else fs.writeFileSync(path.join(bin, client), `#!/bin/sh\nexec "${process.execPath}" "${path.join(bin, 'stand-in-client.mjs')}" ${client} "$@"\n`, { mode: 0o755 });
  }
  // Only the stand-in clients are reachable. PATH holds their folder and
  // nothing else: not Node's own folder and not a system folder, because a
  // real client can sit in either. Node is started by its full path
  // everywhere. The home and every place a client keeps configuration are
  // folders inside the test folder; the two configuration folders lie inside
  // the home, as a person's own do.
  environment = { ...process.env, PATH: bin, STAND_IN_CLIENT_STATE: stateFile,
    HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'), CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude configuration') };
  for (const name of Object.keys(environment)) if (name !== 'PATH' && name.toUpperCase() === 'PATH') delete environment[name];
  assertSealed(environment);
});
after(() => { if (base) fs.rmSync(base, { recursive: true, force: true }); });

// The installer runs client commands and clients write configuration. These
// tests must not be able to reach a real client or a real configuration,
// whatever is installed on the machine that runs them: a client can sit in
// Node's own folder (nvm, a tarball in /usr/local) or in /usr/bin.
function assertSealed(env) {
  const inside = value => { const relative = path.relative(base, path.resolve(value)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); };
  for (const entry of String(env.PATH).split(path.delimiter)) assert.ok(inside(entry), `PATH reaches outside the test folder: ${entry}`);
  assert.equal(env.Path, undefined, 'a second PATH variable would reach outside the test folder');
  for (const name of ['HOME', 'USERPROFILE', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME'])
    assert.ok(env[name] && inside(env[name]), `${name} must name a folder inside the test folder, not ${env[name]}`);
}

test('the tests cannot reach a real client or a real client configuration', () => {
  assertSealed(environment);
  assert.equal(path.dirname(findOnPath('claude', { env: environment })), bin);
  assert.equal(path.dirname(findOnPath('codex', { env: environment })), bin);
  assert.equal(findOnPath('claude', { env: { ...environment, PATH: emptyFolder } }), null);
  assert.equal(findOnPath('codex', { env: { ...environment, PATH: emptyFolder } }), null);
});

test('install: versioned folder, checked copy, new workspace, start-up check, printed commands, no client touched', () => {
  reset();
  const result = installer(['--browser', 'none']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(compareWithRelease(readRelease(installed()), installed()), []);
  assert.ok(fs.statSync(path.join(home, 'ToolsEngine', 'workspace')).isDirectory());
  assert.match(result.out, /directly under your profile, and not under AppData, on purpose/);
  assert.match(result.out, /3 tools offered \(3 expected\)/);
  assert.match(result.out, /Network connections opened by the installer: none\./);
  assert.match(result.out, /Not registered with any client \(no --register\)/);
  // With the person's own home the installer can run the clients itself, and says so.
  assert.match(result.out, /Or let the installer run them:/);
  const saved = record();
  assert.deepEqual(saved.serverArgs, ['--workspace', path.join(home, 'ToolsEngine', 'workspace'), '--no-browser']);
  assert.equal(saved.entry, installed('app', 'bin', 'toolsengine.js'));
  assert.equal(saved.desktop, false);
  assert.deepEqual(saved.registrations.map(item => item.status), ['printed', 'printed']);
  // The printed commands are the exact ones, quoted for this system's shell.
  const server = [saved.node, saved.entry, ...saved.serverArgs];
  assert.ok(result.out.includes(displayCommand([path.basename(findOnPath('claude', { env: environment })), ...clientCommands('claude', 'toolsengine', server).add])), result.out);
  assert.ok(result.out.includes(displayCommand([path.basename(findOnPath('codex', { env: environment })), ...clientCommands('codex', 'toolsengine', server).add])), result.out);
  assert.deepEqual(clientState().calls, [], 'no client command may run without --register');
  assert.equal(fs.readFileSync(installed('install-log.txt'), 'utf8').trim(), result.out.trim(), 'the log file holds what was printed');
});

test('install: an installed version is never written over', () => {
  const stamp = fs.readFileSync(installed('installation.json'), 'utf8');
  fs.writeFileSync(installed('app', 'README.md'), 'changed by the person');
  const result = installer(['--browser', 'none']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /is already installed in .*An installed version is never written over\./s);
  assert.match(result.out, /install\.mjs["']? uninstall/);
  assert.equal(fs.readFileSync(installed('app', 'README.md'), 'utf8'), 'changed by the person');
  assert.equal(fs.readFileSync(installed('installation.json'), 'utf8'), stamp);
});

test('check: reports a changed file and still starts the server', () => {
  const result = fromInstalled(['check']);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /1 differ from release\.json/);
  assert.match(result.out, /changed: app\/README\.md/);
  assert.match(result.out, /3 tools offered \(3 expected\)/);
});

test('install: a damaged archive installs nothing', () => {
  reset();
  const damaged = path.join(base, 'damaged archive');
  fs.cpSync(bundle, damaged, { recursive: true });
  fs.appendFileSync(path.join(damaged, 'app', 'bin', 'toolsengine.js'), '\n// one more line\n');
  const result = run(path.join(damaged, 'install.mjs'), ['--browser', 'none']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /app\/bin\/toolsengine\.js does not match release\.json/);
  assert.match(result.out, /Nothing was installed/);
  assert.ok(!fs.existsSync(home), 'nothing at all may be created from a damaged archive: no version folder, no half-copied folder, no workspace');
});

test('install: dry run changes nothing', () => {
  reset();
  const result = installer(['--dry-run', '--register', 'claude']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Dry run: nothing is changed/);
  assert.ok(!fs.existsSync(home));
  assert.deepEqual(clientState().calls, []);
});

test('install: the workspace and the program folder may not contain one another', () => {
  reset();
  const result = installer(['--browser', 'none', '--workspace', path.join(home, 'ToolsEngine')]);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /must not contain one another/);
  assert.ok(!fs.existsSync(path.join(home, 'ToolsEngine', VERSION)));
});

test('install: a workspace that only looks apart from the program folder is refused once the real folders are known', () => {
  reset();
  // A link beside the home whose real place is the folder that holds the
  // installed versions. As written, the two paths have nothing in common.
  const root = path.join(home, 'ToolsEngine');
  fs.mkdirSync(root, { recursive: true });
  const link = path.join(base, 'a link to somewhere');
  fs.symlinkSync(root, link, windows ? 'junction' : 'dir');
  try {
    const result = installer(['--browser', 'none', '--workspace', link]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /They must not contain one another/);
    assert.ok(result.out.includes(fs.realpathSync.native(root)), 'the real folder is named');
    assert.ok(!fs.existsSync(installed()), 'nothing may be installed');
    assert.deepEqual(fs.readdirSync(root), [], 'and nothing half-copied may be left');
  } finally {
    // Remove the link itself, never what it points to.
    if (windows) fs.rmdirSync(link); else fs.unlinkSync(link);
  }
  assert.ok(fs.existsSync(root));
});

test('the workspace and the program folder are also compared by what the file system says they are', () => {
  // One folder can have two spellings that resolving links does not bring
  // together: on a mount that ignores the case of letters, or on a second
  // mount of the same folder. Text alone would let such a workspace through.
  const { foldersOverlap } = installerModule;
  assert.equal(typeof foldersOverlap, 'function');
  const at = (...parts) => path.join(path.parse(base).root, ...parts);
  const identify = identities => folder => identities[folder] ?? `distinct:${folder}`;
  const caseless = identify({
    [at('mnt', 'c', 'Tools')]: 'c:2', [at('mnt', 'c', 'tools')]: 'c:2',
    [at('mnt', 'c', 'Tools', 'ToolsEngine')]: 'c:3', [at('mnt', 'c', 'tools', 'toolsengine')]: 'c:3',
    [at('mnt', 'c', 'Tools', 'ToolsEngine', '1.0')]: 'c:4', [at('mnt', 'c', 'work')]: 'c:7',
  });
  const program = at('mnt', 'c', 'Tools', 'ToolsEngine', '1.0');
  assert.equal(foldersOverlap(at('mnt', 'c', 'tools', 'toolsengine'), program, { identify: caseless }), true, 'the install root in another case holds the program folder');
  assert.equal(foldersOverlap(at('mnt', 'c', 'tools'), program, { identify: caseless }), true);
  assert.equal(foldersOverlap(at('mnt', 'c', 'work'), program, { identify: caseless }), false);
  // As text they are apart (outside Windows, where path comparison ignores case anyway).
  if(windows)assert.equal(foldersOverlap(at('mnt','c','tools','toolsengine'),program,{identify:()=>null}),true);else assert.throws(()=>foldersOverlap(at('mnt','c','tools','toolsengine'),program,{identify:()=>null}),/identity/);
  // The ordinary cases, on the real file system of the test folder.
  const one = path.join(base, 'overlap one'), two = path.join(base, 'overlap two');
  fs.mkdirSync(path.join(one, 'inner'), { recursive: true });
  fs.mkdirSync(two, { recursive: true });
  assert.equal(foldersOverlap(one, two), false);
  assert.equal(foldersOverlap(path.join(one, 'inner'), two), false);
  assert.equal(foldersOverlap(one, path.join(one, 'inner')), true);
  assert.equal(foldersOverlap(path.join(one, 'not there yet'), one), true);
  assert.equal(foldersOverlap(path.join(one, 'not there yet'), two), false);
});

test('the folders the installer makes are for this account only, whatever the umask',
  { skip: windows ? 'Windows does not use these modes' : false }, () => {
    const mode = folder => (fs.statSync(folder).mode & 0o777).toString(8);
    const before = process.umask(0);   // the most permissive setting there is
    try {
      reset();
      const result = installer(['--browser', 'none']);
      assert.equal(result.status, 0, result.out);
      assert.equal(mode(path.join(home, 'ToolsEngine')), '700', 'the folder that holds the versions');
      assert.equal(mode(installed()), '700', 'the program folder');
      assert.equal(mode(path.join(home, 'ToolsEngine', 'workspace')), '700', 'the workspace');
      assert.doesNotMatch(result.out, /Note: .*may write into/);

      // Folders that were there before are used as they are, and pointed out.
      reset();
      const workspace = path.join(base, 'a shared folder');
      fs.mkdirSync(path.join(home, 'ToolsEngine'), { recursive: true });
      fs.mkdirSync(workspace, { recursive: true });
      fs.chmodSync(path.join(home, 'ToolsEngine'), 0o775);
      fs.chmodSync(workspace, 0o777);
      const second = installer(['--browser', 'none', '--workspace', workspace]);
      assert.equal(second.status, 0, second.out);
      assert.equal(mode(path.join(home, 'ToolsEngine')), '775');
      assert.equal(mode(workspace), '777');
      assert.match(second.out, /Note: .*ToolsEngine was there already, and accounts other than yours may write into it \(mode 775\)/);
      assert.match(second.out, /Note: accounts other than yours may write into this folder \(mode 777\)/);
      assert.equal(mode(installed()), '700', 'the program folder itself is still made for this account only');
    } finally { process.umask(before); }
  });

test('install --register: each client\'s own command receives the exact server command', () => {
  reset();
  const workspace = path.join(base, 'my work (files)');
  const result = installer(['--browser', 'none', '--workspace', workspace, '--register', 'claude', 'codex']);
  assert.equal(result.status, 0, result.out);
  assert.ok(fs.statSync(workspace).isDirectory(), 'a named workspace that does not exist is created');
  const saved = record();
  const server = [saved.node, saved.entry, '--workspace', workspace, '--no-browser'];
  const state = clientState();
  assert.deepEqual(state.calls, [
    ['claude', 'mcp', 'add', '--scope', 'user', 'toolsengine', '--', ...server],
    ['codex', 'mcp', 'get', 'toolsengine'],
    ['codex', 'mcp', 'add', 'toolsengine', '--', ...server],
  ]);
  assert.deepEqual(state.registered, { 'claude:toolsengine': server, 'codex:toolsengine': server });
  assert.deepEqual(saved.registrations.map(item => [item.client, item.status]), [['claude', 'registered'], ['codex', 'registered']]);
  assert.match(result.out, /Claude Code: registered as "toolsengine" with its own command/);
  assert.match(result.out, /Codex: registered as "toolsengine" with its own command/);
});

test('register: an existing registration is left alone unless --replace is given', () => {
  // Both clients hold a "toolsengine" registration from the test before.
  seedClients(clientState().registered);
  const earlier = clientState().registered;
  let result = fromInstalled(['register', 'claude', 'codex']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Claude Code: not changed\. A server named "toolsengine" is already registered/);
  assert.match(result.out, /Codex: not changed\. A server named "toolsengine" is already registered/);
  let state = clientState();
  assert.deepEqual(state.registered, earlier);
  assert.ok(!state.calls.some(call => call[0] === 'codex' && call[2] === 'add'), 'Codex replaces silently, so its add command must not be run');
  assert.deepEqual(record().registrations.map(item => item.status), ['kept-existing', 'kept-existing']);

  seedClients({ 'claude:toolsengine': ['old'], 'codex:toolsengine': ['old'] });
  result = fromInstalled(['register', 'all', '--replace']);
  assert.equal(result.status, 0, result.out);
  state = clientState();
  // Claude Code refuses a name that exists, so the old entry is removed first.
  // Codex replaces in one step: nothing is removed there.
  assert.deepEqual(state.calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp remove', 'claude mcp add', 'codex mcp get', 'codex mcp add']);
  assert.notDeepEqual(state.registered['claude:toolsengine'], ['old']);
  assert.deepEqual(state.registered['codex:toolsengine'], state.registered['claude:toolsengine']);
  assert.deepEqual(record().registrations.map(item => item.status), ['registered', 'registered']);
  assert.match(result.out, /Claude Code: replaced the earlier registration \(--replace\); registered as "toolsengine"/);
  assert.match(result.out, /Codex: replaced the earlier registration \(--replace\); registered as "toolsengine"/);
});

test('--replace: a failed add puts the earlier Claude Code entry back and leaves the Codex entry as it was', () => {
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  // The earlier entries have paths with spaces, and the Claude Code one a setting.
  const earlier = ['/old place/node', '/old place/toolsengine.js', '--workspace', '/old work space'];
  seedClients({ 'claude:toolsengine': earlier, 'codex:toolsengine': earlier }, { 'claude:toolsengine': ['OLD_SETTING=kept value', 'SECOND=2'] });
  // Both clients refuse the new command, which names the installed folder.
  const result = fromInstalled(['register', 'all', '--replace'], { STAND_IN_REFUSE_ADD_CONTAINING: installed() });
  assert.equal(result.status, 2, result.out);
  const state = clientState();
  assert.deepEqual(state.registered, { 'claude:toolsengine': earlier, 'codex:toolsengine': earlier }, 'both earlier entries must be there afterwards');
  assert.deepEqual(state.settings['claude:toolsengine'], ['OLD_SETTING=kept value', 'SECOND=2'], 'with its settings');
  assert.deepEqual(state.calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp remove', 'claude mcp add', 'claude mcp add', 'codex mcp get', 'codex mcp add']);
  assert.match(result.out, /Claude Code: the earlier "toolsengine" registration was put back as it was\./);
  assert.match(result.out, /Codex: its command failed \(exit 1\)\. The earlier registration was not removed and is unchanged\./);
  assert.doesNotMatch(result.out, /kept value/, 'the value of a setting is never printed');
  assert.deepEqual(record().registrations.map(item => item.status), ['failed', 'failed']);
});

test('an earlier entry that could not be put back is shown without anything that can be a secret, on the screen and in the log', () => {
  const { maskedEntry } = installerModule;
  assert.equal(typeof maskedEntry, 'function');
  assert.deepEqual(maskedEntry(['sh','-c','token secret']), ['[previous command, arguments and settings omitted]']);

  // The real path: the new registration is refused, and so is putting the old one back.
  const secrets = /sk-setting|kept value|sk-argument|in-a-word|user:pw|second-secret/;
  const earlier = ['/old place/node', '/old place/toolsengine.js', '--workspace', '/old work space', 'TOKEN=in-a-word', '--endpoint=https://user:pw@example.invalid/x', '--api-key', 'sk-argument', '--then', 'second-secret'];
  const settings = { 'claude:toolsengine': ['API_KEY=sk-setting', 'OLD_SETTING=kept value'] };
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  seedClients({ 'claude:toolsengine': earlier }, settings);
  // Both the new command and the old entry name a file toolsengine.js, so the stand-in refuses both adds.
  let result = fromInstalled(['register', 'claude', '--replace'], { STAND_IN_REFUSE_ADD_CONTAINING: 'toolsengine.js' });
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp remove', 'claude mcp add', 'claude mcp add']);
  assert.match(result.out, /could NOT be put back\. Claude Code now has no "toolsengine" server\./);
  assert.match(result.out, /the whole entry is there/);
  assert.doesNotMatch(result.out, secrets, 'a value that can be a secret was printed');
  assert.match(result.out, /previous command, arguments and settings are omitted/);

  // At install time what is printed is also written to install-log.txt.
  reset();
  seedClients({ 'claude:toolsengine': earlier }, settings);
  result = installer(['--browser', 'none', '--register', 'claude', '--replace'], { STAND_IN_REFUSE_ADD_CONTAINING: 'toolsengine.js' });
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /could NOT be put back/);
  assert.doesNotMatch(result.out, secrets);
  const logged = fs.readFileSync(installed('install-log.txt'), 'utf8');
  assert.match(logged, /could NOT be put back/);
  assert.doesNotMatch(logged, secrets, 'a value that can be a secret was written to the install log');
  assert.doesNotMatch(fs.readFileSync(installed('installation.json'), 'utf8'), secrets);
});

test('--replace: an earlier Claude Code entry that could not be put back is not removed', () => {
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  // A server reached over the network cannot be added again by the command the installer has.
  seedClients({}, {}, { toolsengine: { type: 'http', url: 'https://example.invalid/mcp' } });
  let result = fromInstalled(['register', 'claude', '--replace']);
  // What was asked for, a replacement, did not happen: that is not a success.
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, [], 'nothing may be run when the old entry could not be put back');
  assert.match(result.out, /Claude Code: not changed\. The earlier "toolsengine" entry is of a kind the installer could not put back/);
  assert.match(result.out, /mcp remove toolsengine --scope user/);

  // The same when the configuration cannot be read at all.
  fs.writeFileSync(path.join(environment.CLAUDE_CONFIG_DIR, '.claude.json'), '{ this is not JSON');
  result = fromInstalled(['register', 'claude', '--replace']);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, []);
  assert.match(result.out, /could not be read from Claude Code's configuration/);

  // An entry that Claude Code has somewhere the installer does not read (for
  // one project, say): Claude Code refuses the add, nothing is removed, and
  // the replacement that was asked for did not happen.
  seedClients({ 'claude:toolsengine': ['kept in another scope'] });
  fs.writeFileSync(path.join(environment.CLAUDE_CONFIG_DIR, '.claude.json'), JSON.stringify({ mcpServers: {} }));
  result = fromInstalled(['register', 'claude', '--replace']);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /exists, but it is not in the user configuration the installer reads/);
  assert.deepEqual(clientState().registered['claude:toolsengine'], ['kept in another scope']);
  assert.deepEqual(record().registrations.filter(item => item.client === 'claude').map(item => item.status), ['kept-existing']);
  // Without --replace, leaving an existing entry alone is what was asked for.
  result = fromInstalled(['register', 'claude']);
  assert.equal(result.status, 0, result.out);
  // And at install time.
  result = fromInstalled(['uninstall']);
  assert.equal(result.status, 0, result.out);
  seedClients({}, {}, { toolsengine: { type: 'http', url: 'https://example.invalid/mcp' } });
  result = installer(['--browser', 'none', '--register', 'claude', '--replace']);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(record().registrations.map(item => item.status), ['kept-existing']);
  assert.equal(record().state, 'installed', 'the install itself is finished');

  // With no earlier entry, --replace simply adds.
  seedClients({});
  result = fromInstalled(['register', 'claude', '--replace']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(clientState().calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp add']);
});

test('a path that a .cmd launcher cannot pass on: nothing is removed and nothing is run',
  { skip: windows ? false : 'only Windows starts clients through cmd.exe' }, () => {
    reset();
    const earlier = ['C:\\old place\\node.exe', 'C:\\old place\\toolsengine.js'];
    seedClients({ 'claude:toolsengine': earlier, 'codex:toolsengine': earlier });
    const workspace = path.join(base, 'work & play');
    const result = installer(['--browser', 'none', '--workspace', workspace, '--register', 'all', '--replace']);
    assert.equal(result.status, 2, result.out);
    const state = clientState();
    assert.deepEqual(state.calls, [], 'no client command may run, least of all a remove');
    assert.deepEqual(state.registered, { 'claude:toolsengine': earlier, 'codex:toolsengine': earlier });
    assert.match(result.out, /Claude Code: not registered, and nothing was changed\./);
    assert.match(result.out, /Codex: not registered, and nothing was changed\./);
    assert.ok(result.out.includes(workspace));
  });

test('which command lines a .cmd launcher can be given, and which earlier Claude Code entries can be put back', () => {
  const { unsafeForLauncher, claudeUserEntry } = installerModule;
  assert.equal(typeof unsafeForLauncher, 'function');
  assert.equal(typeof claudeUserEntry, 'function');
  const cmd = 'C:\\Users\\a\\AppData\\Roaming\\npm\\claude.cmd';
  assert.equal(unsafeForLauncher(cmd, ['mcp', 'add', 'toolsengine', '--', 'C:\\Program Files (x86)\\nodejs\\node.exe', 'C:\\Users\\a b\\x.js'], 'win32'), null);
  for (const word of ['C:\\work & play', '100%', 'a^b', 'say "hi"', 'a|b', 'a<b', 'a>b', 'wow!', 'two\nlines'])
    assert.equal(unsafeForLauncher(cmd, ['mcp', 'add', word], 'win32'), word, word);
  // A real program, and any client outside Windows, is started without cmd.exe.
  assert.equal(unsafeForLauncher('C:\\Tools\\claude.exe', ['mcp', 'add', 'C:\\work & play'], 'win32'), null);
  assert.equal(unsafeForLauncher('/usr/local/bin/claude', ['mcp', 'add', '/work & play'], 'linux'), null);

  const folder = path.join(base, 'entries');
  fs.mkdirSync(folder, { recursive: true });
  const read = servers => { fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ mcpServers: servers })); return claudeUserEntry('toolsengine', { env: { CLAUDE_CONFIG_DIR: folder } }); };
  assert.deepEqual(read({ toolsengine: { type: 'stdio', command: '/n/node', args: ['/t/x.js', '--workspace', '/my work'], env: { A: '1', B: 'two words' } } }),
    { state: 'present', settings: 2, restore: ['mcp', 'add', '--scope', 'user', 'toolsengine', '-e', 'A=1', 'B=two words', '--', '/n/node', '/t/x.js', '--workspace', '/my work'] });
  assert.deepEqual(read({ toolsengine: { command: 'node', args: [] } }).restore, ['mcp', 'add', '--scope', 'user', 'toolsengine', '--', 'node']);
  assert.deepEqual(read({ other: { command: 'node' } }), { state: 'absent' });
  for (const entry of [{ type: 'http', url: 'https://example.invalid' }, { type: 'stdio', command: 'node', args: ['x'], headers: {} }, { command: 'node', args: [1] }, { command: 'node', env: { A: 1 } }, { args: ['x'] }, 'text', null])
    assert.deepEqual(read({ toolsengine: entry }), { state: 'not-restorable' }, JSON.stringify(entry));
  assert.deepEqual(claudeUserEntry('toolsengine', { env: { CLAUDE_CONFIG_DIR: path.join(base, 'no such folder') } }), { state: 'absent' });
  // Without CLAUDE_CONFIG_DIR the file is looked for in the home folder.
  fs.writeFileSync(path.join(folder, '.claude.json'), JSON.stringify({ mcpServers: { toolsengine: { command: 'from-home' } } }));
  assert.equal(claudeUserEntry('toolsengine', { env: {}, home: folder }).restore.at(-1), 'from-home');
});

test('register: a client that is not installed is reported with the command to run later', () => {
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  // PATH is an empty folder of the test: Node's own folder can hold a real codex.
  const withoutClients = { PATH: emptyFolder };
  const result = fromInstalled(['register', 'codex', '--name', 'te-second'], withoutClients);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /Codex: not registered\. The "codex" command was not found on PATH/);
  assert.match(result.out, /codex mcp add te-second (?:--|"--") /);
});

test('uninstall: removes what was installed, keeps the workspace and anything else, lists the registrations', () => {
  reset();
  assert.equal(installer(['--browser', 'none', '--register', 'claude', 'codex']).status, 0);
  const workspace = record().workspace;
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'mine');
  fs.writeFileSync(installed('app', 'kept-by-the-person.txt'), 'not from the installer');
  seedClients({});
  let result = fromInstalled(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /1 other item\(s\) that the installer did not put there were left in place/);
  assert.match(result.out, /Claude Code: registered as "toolsengine" by the installer\./);
  assert.deepEqual(fs.readdirSync(installed(), { recursive: true }).map(String).sort(), ['app', path.join('app', 'kept-by-the-person.txt')]);
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'mine');
  assert.match(result.out, /Not removed: the workspace/);
  assert.match(result.out, /to remove it: {2}claude(?:\.cmd)? mcp remove toolsengine --scope user/);
  assert.match(result.out, /to remove it: {2}codex(?:\.cmd)? mcp remove toolsengine/);
  assert.deepEqual(clientState().calls, [], 'uninstall lists the registrations; it does not remove them');

  // A clean one disappears completely, and the root with the workspace stays.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  result = installer(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Removed\./);
  assert.deepEqual(fs.readdirSync(path.join(home, 'ToolsEngine')), ['workspace']);
  assert.equal(installer(['uninstall']).status, 1, 'nothing left to remove');
});

// A leftover folder that cannot be read made the uninstall stop with
// "ReferenceError: unexpected is not defined" after it had removed the
// files, before it named the workspace and the client registrations; a
// second uninstall then found nothing to remove and never named them.
test('uninstall names a leftover folder it cannot read, and still lists the workspace and the registrations', { skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'needs a POSIX folder that its owner cannot read' : false }, () => {
  reset();
  assert.equal(installer(['--browser', 'none', '--register', 'claude', 'codex']).status, 0);
  const locked = installed('extra', 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.chmodSync(locked, 0o000);
  try {
    seedClients({});
    const result = fromInstalled(['uninstall']);
    assert.doesNotMatch(result.out, /ReferenceError|is not defined/);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /other item\(s\) that the installer did not put there were left in place/);
    assert.match(result.out, /extra[\\/]locked: unreadable/);
    assert.match(result.out, /Not removed: the workspace/);
    assert.match(result.out, /to remove it: {2}claude(?:\.cmd)? mcp remove toolsengine --scope user/);
  } finally {
    fs.chmodSync(locked, 0o700);
  }
});

test('uninstall removes nothing through a link, and nothing by a list that was changed after the install', () => {
  // A project of the person's, with files named like those of the install.
  const project = path.join(base, 'a project of mine');
  fs.rmSync(project, { recursive: true, force: true });
  fs.mkdirSync(path.join(project, 'bin'), { recursive: true });
  for (const name of ['package.json', 'README.md', path.join('bin', 'toolsengine.js'), 'a private file of mine.txt']) fs.writeFileSync(path.join(project, name), 'mine, not the installer\'s');
  const projectFiles = () => fs.readdirSync(project, { recursive: true }).map(String).sort();
  const before = projectFiles();

  // 1. The app folder of the install is replaced by a link to that project.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  fs.rmSync(installed('app'), { recursive: true });
  fs.symlinkSync(project, installed('app'), windows ? 'junction' : 'dir');
  let result;
  try {
    result = fromInstalled(['uninstall']);
    assert.equal(result.status, 0, result.out);
    assert.deepEqual(projectFiles(), before, 'nothing in the project may be removed');
    assert.equal(fs.readFileSync(path.join(project, 'package.json'), 'utf8'), 'mine, not the installer\'s');
    assert.match(result.out, /1 item\(s\) in the folder are links/);
    assert.ok(result.out.includes(installed('app')));
    assert.ok(fs.lstatSync(installed('app')).isSymbolicLink(), 'the link itself is left where it was');
    assert.ok(!fs.existsSync(installed('install.mjs')), 'the real files of the install are removed');
    // Nor is anything read through the link: what it points to is not
    // listed, not counted and not printed.
    assert.doesNotMatch(result.out, /other item\(s\) that the installer did not put there/, 'the files of the project were counted as items left in the folder');
    for (const behind of ['package.json', 'README.md', path.join('bin', 'toolsengine.js'), 'a private file of mine.txt'])
      assert.ok(!result.out.includes(path.join(installed('app'), behind)), `the uninstall named ${behind}, which lies behind the link`);
    assert.ok(!result.out.includes('a private file of mine.txt'));
    assert.match(result.out, /The folder stays, because the links are still in it\./);
  } finally {
    if (windows) fs.rmdirSync(installed('app')); else fs.unlinkSync(installed('app'));
  }

  // A link among the things the person keeps in the folder is named as one item, and not looked into either.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  fs.writeFileSync(installed('kept by me.txt'), 'mine');
  fs.symlinkSync(project, installed('my link'), windows ? 'junction' : 'dir');
  try {
    result = fromInstalled(['uninstall']);
    assert.equal(result.status, 0, result.out);
    assert.match(result.out, /2 other item\(s\) that the installer did not put there were left in place/);
    assert.ok(result.out.includes(installed('kept by me.txt')) && result.out.includes(installed('my link')));
    assert.ok(!result.out.includes(path.join(installed('my link'), 'package.json')) && !result.out.includes('a private file of mine.txt'), 'the uninstall looked into a link');
    assert.deepEqual(projectFiles(), before);
  } finally {
    if (windows) fs.rmdirSync(installed('my link')); else fs.unlinkSync(installed('my link'));
  }

  // 2. release.json, the list of what to remove, was changed after the install.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  const list = JSON.parse(fs.readFileSync(installed('release.json'), 'utf8'));
  list.files.push({ path: 'notes of mine.txt', size: 4, sha256: sha256('mine'), mode: '644' });
  fs.writeFileSync(installed('release.json'), JSON.stringify(list));
  fs.writeFileSync(installed('notes of mine.txt'), 'mine');
  result = fromInstalled(['uninstall']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /is not the one that was installed/);
  assert.match(result.out, /nothing was removed/);
  assert.equal(fs.readFileSync(installed('notes of mine.txt'), 'utf8'), 'mine');
  assert.ok(fs.existsSync(installed('app', 'bin', 'toolsengine.js')));
  fs.rmSync(project, { recursive: true, force: true });
});

test('taking the record of an install away is no way around the check of its list of files', () => {
  // installation.json holds the SHA-256 of the release.json that was
  // installed, and uninstall removes nothing by a list that does not match
  // it. A folder with no record is an install that was not finished, which
  // uninstall also removes: so removing the record, and then changing the
  // list, must not make uninstall delete by the changed list.
  const tamper = () => {
    reset();
    assert.equal(installer(['--browser', 'none']).status, 0);
    const list = JSON.parse(fs.readFileSync(installed('release.json'), 'utf8'));
    list.files.push({ path: 'notes of mine.txt', size: 4, sha256: sha256('mine'), mode: '644' });
    fs.writeFileSync(installed('release.json'), JSON.stringify(list));
    fs.writeFileSync(installed('notes of mine.txt'), 'mine');
  };
  const untouched = result => {
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /Nothing was removed/);
    assert.equal(fs.readFileSync(installed('notes of mine.txt'), 'utf8'), 'mine', 'a file the changed list names must still be there');
    assert.ok(fs.existsSync(installed('app', 'bin', 'toolsengine.js')) && fs.existsSync(installed('install.mjs')), 'and so must the install');
  };

  // 1. No record at all, uninstall run from the folder itself: its own list has nothing to vouch for it.
  tamper();
  fs.rmSync(installed('installation.json'));
  let result = fromInstalled(['uninstall']);
  untouched(result);
  assert.match(result.out, /holds no record of its install/);
  assert.match(result.out, /Run the uninstall from the folder the archive/);

  // 2. No record, uninstall run from the archive: the list in the folder is not the archive's.
  result = installer(['uninstall']);
  untouched(result);
  assert.match(result.out, /its release\.json is not the one of this archive/);

  // 3. A record that no longer holds the hash is no record of the list.
  tamper();
  const saved = record();
  delete saved.releaseSha256;
  fs.writeFileSync(installed('installation.json'), JSON.stringify(saved));
  untouched(fromInstalled(['uninstall']));
  untouched(installer(['uninstall']));

  // 4. No record, the archive's own list, but a file that is not what the list says.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  fs.rmSync(installed('installation.json'));
  fs.writeFileSync(installed('app', 'README.md'), 'changed by someone');
  result = installer(['uninstall']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /1 of its files are missing or are not what this archive holds \(changed: app\/README\.md\)/);
  assert.equal(fs.readFileSync(installed('app', 'README.md'), 'utf8'), 'changed by someone');
  // Installing over it is refused too, and says that the folder is for the person to delete.
  result = installer(['--browser', 'none']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /holds no record of its install, so the installer will not remove it either/);

  // 5. What stays possible: a folder without a record whose files are those of this archive is removed from the archive.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  fs.rmSync(installed('installation.json'));
  result = installer(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.ok(!fs.existsSync(installed()));
});

test('clients are not run when the home in the environment is not the person\'s own profile', () => {
  // A terminal started by another account can carry that account's home. The
  // clients keep their configuration under the home folder, so running them
  // would change the other account's configuration.
  reset();
  const otherHome = path.join(base, 'home of another account');
  fs.mkdirSync(otherHome, { recursive: true });
  const carried = { HOME: otherHome, USERPROFILE: otherHome };
  let result = installer(['--browser', 'none', '--register', 'claude', 'codex', '--replace'], carried);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, [], 'no client may run with another account\'s home');
  assert.match(result.out, /were not run/);
  assert.ok(result.out.includes(otherHome) && result.out.includes(home), 'both folders are named');
  // The person sees why the installer ends with 2 although the install is
  // complete, and that --home would not change it.
  assert.match(result.out, /The install itself is complete; because the\n\s+registration that was asked for was not done, the installer ends with exit code 2\./);
  assert.match(result.out, /--home DIR chooses where ToolsEngine is installed and plays no part in this/);
  const saved = record();
  const server = [saved.node, saved.entry, ...saved.serverArgs];
  // The commands are printed instead, for a terminal of the person's own.
  assert.ok(result.out.includes(displayCommand([path.basename(findOnPath('claude', { env: environment })), ...clientCommands('claude', 'toolsengine', server).add])), result.out);
  assert.ok(result.out.includes(displayCommand([path.basename(findOnPath('codex', { env: environment })), ...clientCommands('codex', 'toolsengine', server).add])), result.out);
  assert.deepEqual(saved.registrations.map(item => item.status), ['printed', 'printed']);
  // Its register command would be refused in the same way, so it is not suggested.
  assert.doesNotMatch(result.out, /let the installer run them|install\.mjs'? register/, result.out);

  // The same for the register command of the installed copy.
  result = fromInstalled(['register', 'all', '--replace'], carried);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, []);
  assert.match(result.out, /were not run/);

  // --home says where ToolsEngine is installed. It never makes another
  // account's home this account's: naming the carried home with --home, as a
  // person in that terminal might, must not start a client either.
  result = fromInstalled(['register', 'all', '--replace', '--install-root', path.join(home, 'ToolsEngine'), '--home', otherHome], carried);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, [], '--home must not turn another account\'s home into this account\'s');
  assert.match(result.out, /were not run/);
  reset();
  result = installer(['--browser', 'none', '--register', 'all', '--home', otherHome], carried);
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, []);
  assert.ok(fs.existsSync(path.join(otherHome, 'ToolsEngine', VERSION, 'installation.json')), 'it is installed where --home says');
  fs.rmSync(path.join(otherHome, 'ToolsEngine'), { recursive: true, force: true });
  // Nor without --register, where the printed commands are all there is.
  reset();
  result = installer(['--browser', 'none', '--dry-run'], carried);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /claude(?:\.cmd)? mcp add --scope user toolsengine/, result.out);
  assert.doesNotMatch(result.out, /let the installer run them/, result.out);

  // With the person's own home in the environment they run.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  result = fromInstalled(['register', 'claude']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(clientState().calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp add']);
});

test('--home chooses where ToolsEngine is installed and nothing else: the clients run as long as the environment\'s home is the person\'s own', () => {
  reset();
  const elsewhere = path.join(base, 'tools on another drive');
  fs.rmSync(elsewhere, { recursive: true, force: true });
  const result = installer(['--browser', 'none', '--home', elsewhere, '--register', 'claude', 'codex']);
  assert.equal(result.status, 0, result.out);
  assert.doesNotMatch(result.out, /were not run/);
  const saved = JSON.parse(fs.readFileSync(path.join(elsewhere, 'ToolsEngine', VERSION, 'installation.json'), 'utf8'));
  assert.equal(saved.workspace, path.join(elsewhere, 'ToolsEngine', 'workspace'));
  assert.deepEqual(saved.registrations.map(item => [item.client, item.status]), [['claude', 'registered'], ['codex', 'registered']]);
  assert.deepEqual(clientState().calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp add', 'codex mcp get', 'codex mcp add']);
  // And the same from the installed copy, which needs no --home to find itself.
  seedClients({});
  const again = run(path.join(elsewhere, 'ToolsEngine', VERSION, 'install.mjs'), ['register', 'codex']);
  assert.equal(again.status, 0, again.out);
  assert.deepEqual(clientState().calls.map(call => call.slice(0, 3).join(' ')), ['codex mcp get', 'codex mcp add']);
  fs.rmSync(elsewhere, { recursive: true, force: true });
});

test('a client is not run when its configuration variable points outside the person\'s own profile', () => {
  // CLAUDE_CONFIG_DIR and CODEX_HOME decide which configuration a client
  // changes. Carried over from another account, with the right home, they
  // would have the client change that account's configuration.
  reset();
  assert.equal(installer(['--browser', 'none']).status, 0);
  const foreign = path.join(base, 'configuration of another account');
  fs.mkdirSync(foreign, { recursive: true });

  let result = fromInstalled(['register', 'claude', 'codex', '--replace'], { CLAUDE_CONFIG_DIR: foreign });
  assert.equal(result.status, 2, result.out);
  let state = clientState();
  assert.ok(!state.calls.some(call => call[0] === 'claude'), 'Claude Code must not run with a configuration folder outside the profile');
  assert.deepEqual(state.calls.map(call => call.slice(0, 3).join(' ')), ['codex mcp get', 'codex mcp add'], 'Codex, whose folder is inside the profile, is registered');
  assert.match(result.out, /Claude Code: not run\. CLAUDE_CONFIG_DIR is set to/);
  assert.ok(result.out.includes(foreign) && result.out.includes(home), 'both folders are named');
  assert.match(result.out, /claude(?:\.cmd)? mcp add --scope user toolsengine/, 'the command is printed instead');
  assert.deepEqual(record().registrations.map(item => [item.client, item.status]), [['claude', 'not-run'], ['codex', 'registered']]);
  assert.deepEqual(fs.readdirSync(foreign), [], 'nothing was written into the other folder');

  seedClients({});
  result = fromInstalled(['register', 'all'], { CODEX_HOME: foreign });
  assert.equal(result.status, 2, result.out);
  state = clientState();
  assert.deepEqual(state.calls.map(call => call.slice(0, 3).join(' ')), ['claude mcp add']);
  assert.match(result.out, /Codex: not run\. CODEX_HOME is set to/);

  // The same at install time, and the list of installed versions says what happened.
  reset();
  result = installer(['--browser', 'none', '--register', 'all'], { CLAUDE_CONFIG_DIR: foreign, CODEX_HOME: foreign });
  assert.equal(result.status, 2, result.out);
  assert.deepEqual(clientState().calls, []);
  assert.deepEqual(record().registrations.map(item => item.status), ['not-run', 'not-run']);
  assert.match(fromInstalled(['list']).out, /Claude Code: not run: CLAUDE_CONFIG_DIR pointed outside your profile/);
});

test('an install that was interrupted can be installed again, and can be uninstalled', () => {
  const interrupt = () => {
    reset();
    const killed = installer(['--browser', 'none'], { STAND_IN_KILL_INSTALLER: '1' });
    assert.notEqual(killed.status, 0, 'the stand-in server ends the installer during its check');
    assert.ok(fs.existsSync(installed('app', 'bin', 'toolsengine.js')), 'the files were copied before the interruption');
  };

  // 1. Installing again finishes it: the files are complete, so nothing is copied again.
  interrupt();
  let result = installer(['--browser', 'none']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /was not finished/);
  assert.match(result.out, /3 tools offered \(3 expected\)/);
  assert.equal(record().state, 'installed');
  assert.deepEqual(compareWithRelease(readRelease(installed()), installed()), []);
  // A finished install is still never written over.
  assert.equal(installer(['--browser', 'none']).status, 1);

  // 2. Until then it is not offered as a working version, and says what to do.
  interrupt();
  for (const command of ['check', 'register']) {
    result = fromInstalled(command === 'register' ? ['register', 'claude'] : [command]);
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /was not finished/);
  }
  assert.deepEqual(clientState().calls, []);
  assert.match(fromInstalled(['list']).out, /install not finished/);

  // 3. It can be uninstalled, from the archive and from its own folder.
  result = installer(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.ok(!fs.existsSync(installed()), result.out);
  interrupt();
  result = fromInstalled(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.ok(!fs.existsSync(installed()), result.out);

  // 4. A folder without liveness evidence requires explicit removal, not automatic recovery.
  interrupt();
  fs.rmSync(installed('installation.json'));
  assert.equal(installer(['--browser', 'none']).status, 1);
  assert.equal(installer(['uninstall']).status, 0);
  interrupt();
  fs.rmSync(installed('installation.json'));
  assert.equal(installer(['uninstall']).status, 0);
  assert.ok(!fs.existsSync(installed()));

  // 5. With a file missing or changed it is not finished but refused, with the way out; and that way works.
  interrupt();
  fs.rmSync(installed('app', 'README.md'));
  result = installer(['--browser', 'none']);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /not complete/);
  assert.match(result.out, /install\.mjs["']? uninstall/);
  assert.equal(installer(['uninstall']).status, 0);
  assert.ok(!fs.existsSync(installed()));
  assert.equal(installer(['--browser', 'none']).status, 0);
});

test('an interrupted install is finished only in a folder that holds nothing else, and only when its installer is gone', () => {
  const interrupt = () => {
    reset();
    const killed = installer(['--browser', 'none'], { STAND_IN_KILL_INSTALLER: '1' });
    assert.notEqual(killed.status, 0, 'the stand-in server ends the installer during its check');
    assert.equal(record().state, 'installing');
  };
  const refusedUnchanged = (result, pattern) => {
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, pattern);
    assert.match(result.out, /Nothing was changed/);
    assert.equal(record().state, 'installing', 'the folder must not have become an installed version');
  };

  // 1. Every listed file is right, but the folder holds more. A file that is
  //    on no list is checked by nothing, and in the right place the program
  //    loads it: a node_modules folder beside the program's own source, for one.
  interrupt();
  const stamp = fs.readFileSync(installed('installation.json'), 'utf8');
  fs.mkdirSync(installed('app', 'bin', 'node_modules', 'planted'), { recursive: true });
  fs.writeFileSync(installed('app', 'bin', 'node_modules', 'planted', 'index.js'), 'not from the archive');
  let result = installer(['--browser', 'none']);
  refusedUnchanged(result, /holds 1 item\(s\) that are not part of this release \(app\/bin\/node_modules\/\)/);
  assert.equal(fs.readFileSync(installed('installation.json'), 'utf8'), stamp, 'not even the record may be rewritten');
  assert.match(result.out, /install\.mjs["']? uninstall/);
  // A single extra file, and a link, count the same.
  fs.rmSync(installed('app', 'bin', 'node_modules'), { recursive: true });
  fs.writeFileSync(installed('app', 'extra.js'), 'x');
  fs.symlinkSync(base, installed('a link'), windows ? 'junction' : 'dir');
  try {
    refusedUnchanged(installer(['--browser', 'none']), /holds 2 item\(s\) that are not part of this release \(a link, app\/extra\.js\)/);
  } finally {
    if (windows) fs.rmdirSync(installed('a link')); else fs.unlinkSync(installed('a link'));
  }
  // The way out that the message gives: uninstall removes the install and leaves the extra file to the person.
  result = installer(['uninstall']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(fs.readdirSync(installed(), { recursive: true }).map(String).sort(), ['app', path.join('app', 'extra.js')]);
  // The same list, as a function: the installer's own three files are expected, nothing else is.
  const { unexpectedItems, stillInstalling } = installerModule;
  assert.equal(typeof unexpectedItems, 'function');
  interrupt();
  const release = readRelease(installed());
  assert.deepEqual(unexpectedItems(release, installed()), []);
  fs.writeFileSync(installed('install-log.txt.bak'), 'x');
  fs.mkdirSync(installed('app', 'src'));
  assert.deepEqual(unexpectedItems(release, installed()), ['app/src/', 'install-log.txt.bak']);
  fs.rmSync(installed('install-log.txt.bak'));
  fs.rmdirSync(installed('app', 'src'));

  // 2. The record of an unfinished install names the installer that made it.
  //    While that process runs, a second installer does not take the folder over.
  const saved = record();
  assert.ok(Number.isInteger(saved.installerPid) && saved.installerPid > 0);
  assert.equal(saved.installerHost, os.hostname());
  // The process running this test is alive; the installer that was ended is not.
  fs.writeFileSync(installed('installation.json'), JSON.stringify({ ...saved, installerPid: process.pid, installerScope: installerModule.currentProcessIdentity().scope, installerProcessStart: installerModule.currentProcessIdentity().start }));
  refusedUnchanged(installer(['--browser', 'none']), new RegExp(`is being installed into .* right now, by process ${process.pid} on this machine`));
  fs.writeFileSync(installed('installation.json'), JSON.stringify(saved));
  result = installer(['--browser', 'none']);
  assert.equal(result.status, 0, result.out);
  assert.equal(record().state, 'installed');

  // A record from another machine, where the process number cannot be asked about: at work for a day, then not.
  assert.equal(typeof stillInstalling, 'function');
  const elsewhere = { state: 'installing', installerPid: 4321, installerHost: 'another-machine', installerScope: installerModule.currentProcessIdentity().scope, installerProcessStart:'test', startedAt: new Date().toISOString() };
  assert.match(stillInstalling(elsewhere), /another machine \(another-machine\)/);
  assert.match(stillInstalling({ ...elsewhere, startedAt: new Date(Date.now() - 2 * 86400000).toISOString() }), /another machine/);
  assert.equal(stillInstalling({ ...elsewhere, installerHost: os.hostname() }, { alive: () => true, identity: () => ({scope:installerModule.currentProcessIdentity().scope,start:'test'}) }), 'process 4321 on this machine');
  assert.equal(stillInstalling({ ...elsewhere, installerHost: os.hostname() }, { alive: () => false }), null);
  assert.equal(stillInstalling({ ...elsewhere, state: 'installed' }, { alive: () => true }), null);
  assert.match(stillInstalling(null), /explicit recovery/);
  assert.match(stillInstalling({ state: 'installing' }), /explicit recovery/);
});

test('install: half-copied folders of an installer that is gone are cleared away, and nothing else', () => {
  reset();
  const root = path.join(home, 'ToolsEngine');
  // Process numbers that belonged to processes which have ended.
  const endedProcess = () => spawnSync(process.execPath, ['-e', '']).pid;
  const ended = endedProcess();
  // The installer marks a folder it copies into. The mark names the process
  // and the machine, so that the folder can be told from one that only has
  // such a name, and from one of an installer on another machine that shares
  // this folder (where a process number means nothing here).
  const mark = (name, content) => fs.writeFileSync(path.join(root, name, '.toolsengine-install-in-progress'), typeof content === 'string' ? content
    : JSON.stringify({ what: 'ToolsEngine installer staging folder', version: VERSION, folder:name, ...installerModule.currentProcessIdentity(), start:'test', host: os.hostname(), startedAt: new Date().toISOString(), ...content }));
  const folder = name => { fs.mkdirSync(path.join(root, name, 'app'), { recursive: true }); fs.writeFileSync(path.join(root, name, 'app', 'half-copied.js'), 'x'); return name; };

  const abandoned = folder(`.incoming-${VERSION}-${ended}`);
  mark(abandoned, { pid: ended });
  // The process that started this test file is running for as long as the test is.
  const ofALivingInstaller = folder(`.incoming-${VERSION}-${process.ppid}`);
  mark(ofALivingInstaller, { pid: process.ppid, ...installerModule.currentProcessIdentity(process.ppid) });
  // Folders that have such a name and are not the installer's: no mark, a
  // mark that is something else, a mark for another process number.
  const unmarked = folder(`.incoming-${VERSION}-${endedProcess()}`);
  const otherContent = folder(`.incoming-backup-${endedProcess()}`);
  mark(otherContent, 'notes of mine');
  const otherProcess = folder(`.incoming-${VERSION}-${endedProcess()}`);
  mark(otherProcess, { pid: 1 });
  // Folders of installers on another machine that shares this folder: one that started a moment ago, one from days ago.
  const elsewhereNow = folder(`.incoming-${VERSION}-${endedProcess()}`);
  mark(elsewhereNow, { pid: Number(elsewhereNow.split('-').at(-1)), host: 'another-machine' });
  const elsewhereLongAgo = folder(`.incoming-${VERSION}-${endedProcess()}`);
  mark(elsewhereLongAgo, { pid: Number(elsewhereLongAgo.split('-').at(-1)), host: 'another-machine', startedAt: new Date(Date.now() - 3 * 86400000).toISOString() });
  const others = ['.incoming-notes', `.incoming-${VERSION}-${ended}-kept`, `incoming-${VERSION}-${ended}`, 'my own folder'].map(folder);
  fs.writeFileSync(path.join(root, `.incoming-0.0.1-${ended}`), 'a file with such a name is not a copy folder');
  const kept = [unmarked, otherContent, otherProcess, elsewhereNow, elsewhereLongAgo, ...others, `.incoming-0.0.1-${ended}`];

  const { clearAbandonedCopies } = installerModule;
  assert.equal(typeof clearAbandonedCopies, 'function');
  const result = installer(['--browser', 'none']);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /Cleared away 1 half-copied folder\(s\)/);
  assert.deepEqual(fs.readdirSync(root).sort(), [VERSION, ofALivingInstaller, ...kept, 'workspace'].sort(), 'only the two marked folders of installers that are gone may be removed');
  // Once the other installer is gone too, its folder goes with the next call; the unmarked ones never do.
  assert.deepEqual(clearAbandonedCopies(root, { alive: () => false }), [ofALivingInstaller]);
  assert.deepEqual(fs.readdirSync(root).sort(), [VERSION, ...kept, 'workspace'].sort());
  // The installed version holds no mark: it is taken out before the folder is moved into place.
  assert.ok(!fs.existsSync(installed('.toolsengine-install-in-progress')));
  assert.equal(fromInstalled(['check']).status, 0);
});

test('install: a workspace that cannot be used stops the install before anything is copied', () => {
  reset();
  const notAFolder = path.join(base, 'a file, not a folder');
  fs.writeFileSync(notAFolder, 'x');
  const result = installer(['--browser', 'none', '--workspace', notAFolder]);
  assert.equal(result.status, 1, result.out);
  assert.match(result.out, /workspace/i);
  assert.ok(!fs.existsSync(installed()), 'no program folder may be left behind');
  assert.deepEqual(fs.existsSync(path.join(home, 'ToolsEngine')) ? fs.readdirSync(path.join(home, 'ToolsEngine')) : [], []);
  assert.equal(installer(['--browser', 'none']).status, 0, 'and the next install goes through');
});

test('install: an empty folder with the version\'s name is not an installed version', () => {
  reset();
  fs.mkdirSync(installed(), { recursive: true });
  const result = installer(['--browser', 'none']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(compareWithRelease(readRelease(installed()), installed()), []);
});

test('uninstall while a terminal stands in the folder: the files go, the empty folder is named, a later install clears it',
  { skip: windows ? false : 'only Windows keeps a folder that a program is standing in' }, async () => {
    reset();
    assert.equal(installer(['--browser', 'none']).status, 0);
    // A program whose current folder is the installed folder, as a terminal would be.
    const standing = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: installed(), stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = fromInstalled(['uninstall']);
      assert.equal(result.status, 0, result.out);
      assert.match(result.out, /The folder itself, now empty, is still there/);
      assert.doesNotMatch(result.out, /^ {2}Removed\.$/m);
      assert.deepEqual(fs.readdirSync(installed()), []);
    } finally {
      standing.kill();
      await new Promise(resolve => standing.once('exit', resolve));
    }
    const again = installer(['--browser', 'none']);
    assert.equal(again.status, 0, again.out);
    assert.ok(fs.existsSync(installed('installation.json')));
  });

test('install with a browser: the check opens a page and leaves no file behind; a browser that fails is reported', () => {
  reset();
  const browser = path.join(base, 'stand-in-browser');
  fs.writeFileSync(browser, '');
  let result = installer(['--browser', browser]);
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /5 tools offered \(5 expected\)/);
  assert.match(result.out, /started, opened a blank page and closed/);
  assert.deepEqual(record().browser.args, ['--browser-executable', browser]);
  assert.deepEqual(fs.readdirSync(path.join(home, 'ToolsEngine', 'workspace', 'artifacts', 'toolsengine')), [], 'the page file written by the check is removed');

  // The check removes the one file its own blank page left, and nothing else:
  // not what another server saved into the same folder in the same moment.
  reset();
  result = installer(['--browser', browser], { STAND_IN_OTHER_ARTIFACTS: '1' });
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(fs.readdirSync(path.join(home, 'ToolsEngine', 'workspace', 'artifacts', 'toolsengine')).sort(),
    ['downloaded-invoice.txt', 'page-2026-01-01T00-00-00-001Z.yml', 'report.pdf', 'screenshot.png'], 'files the check did not make must stay');
  result = fromInstalled(['check'], { STAND_IN_OTHER_ARTIFACTS: '1' });
  assert.equal(result.status, 0, result.out);
  assert.equal(fs.readdirSync(path.join(home, 'ToolsEngine', 'workspace', 'artifacts', 'toolsengine')).length, 4);

  // A browser that is to open in a window is registered so, but the check
  // itself never opens a window.
  reset();
  result = installer(['--browser', browser, '--headed']);
  assert.equal(result.status, 0, result.out);
  assert.deepEqual(record().serverArgs, ['--workspace', path.join(home, 'ToolsEngine', 'workspace'), '--browser-executable', browser, '--headed']);
  assert.match(result.out, /in a window you can see \(--headed\)/);
  assert.match(result.out, /started \(hidden, for this check\), opened a blank page and closed/);
  assert.ok(!fs.existsSync(path.join(home, 'ToolsEngine', 'workspace', 'a-window-was-opened.txt')), 'the check must not open a browser window');
  result = fromInstalled(['check']);
  assert.equal(result.status, 0, result.out);
  assert.ok(!fs.existsSync(path.join(home, 'ToolsEngine', 'workspace', 'a-window-was-opened.txt')), 'the check command must not open a browser window either');

  reset();
  const broken = path.join(base, 'broken-browser');
  fs.writeFileSync(broken, '');
  result = installer(['--browser', broken, '--register', 'claude']);
  assert.equal(result.status, 2, result.out);
  assert.match(result.out, /The browser did not start: The stand-in browser does not start\./);
  // The server itself works, so the registration that was asked for is made.
  assert.deepEqual(record().registrations.map(item => item.status), ['registered']);
});

test('desktop tools: off by default, Windows only, bound to the account\'s own profile', () => {
  reset();
  // Started by itself, so that the profile is the one the operating system
  // records. --home keeps the install inside the test folder.
  const result = installer(['--home', home, '--browser', 'none', '--desktop'], {}, { profile: null });
  if (!windows) {
    assert.equal(result.status, 1, result.out);
    assert.match(result.out, /--desktop is for Windows/);
    assert.ok(!fs.existsSync(path.join(home, 'ToolsEngine', VERSION)));
    return;
  }
  assert.equal(result.status, 0, result.out);
  assert.match(result.out, /4 tools offered \(4 expected\)/);
  // The profile is the one Windows records for the account, whatever --home says.
  assert.deepEqual(record().serverArgs.slice(-2), ['--desktop-profile-root', os.userInfo().homedir]);
});

 test('R3 recovery refuses hard-linked records and leaves external sentinels unchanged',()=>{
  for(const name of ['installation.json','install-log.txt','release.json']){
   reset();assert.equal(installer(['--browser','none','--no-check']).status,0);
   const old=record();old.state='installing';old.installerPid=99999999;fs.writeFileSync(installed('installation.json'),JSON.stringify(old));
   const sentinel=path.join(base,'r3-sentinel');fs.rmSync(sentinel,{force:true});
   fs.renameSync(installed(name),sentinel);fs.linkSync(sentinel,installed(name));
   const before=fs.readFileSync(sentinel,'utf8');const result=installer(['--browser','none','--no-check']);
   assert.equal(result.status,1,result.out);assert.equal(fs.readFileSync(sentinel,'utf8'),before);
   fs.unlinkSync(installed(name));fs.rmSync(sentinel);
  }
 });
 test('R3 inventory fails closed for linked parents and incomplete reads',()=>{
  const dir=path.join(base,'r3-tree');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'ok'),'x');
  const release={files:[{path:'ok'}]};const linked=path.join(base,'r3-parent');fs.symlinkSync(dir,linked,windows?'junction':'dir');
  try{assert.throws(()=>installerModule.unexpectedItems(release,linked),/plain|link/i);}finally{fs.unlinkSync(linked);}
  const read=fs.readdirSync;fs.readdirSync=()=>{throw Object.assign(new Error('synthetic denied'),{code:'EACCES'});};
  try{assert.ok(installerModule.unexpectedItems(release,dir).length>0);}finally{fs.readdirSync=read;}
 });

test('R7 failed restore omits arbitrary old argv from screen and install log',()=>{
 for(const args of [['node','toolsengine.js','-H','Authorization: Bearer REVIEW_SYNTHETIC_MARKER'],['sh','-c','exec node toolsengine.js --token REVIEW_SYNTHETIC_MARKER'],['node','toolsengine.js','REVIEW_SYNTHETIC_MARKER']]){
  reset();seedClients({'claude:toolsengine':args});
  const result=installer(['--browser','none','--register','claude','--replace'],{STAND_IN_REFUSE_ADD_CONTAINING:'toolsengine.js'});
  assert.equal(result.status,2,result.out);assert.match(result.out,/could NOT be put back/);
  assert.doesNotMatch(result.out,/REVIEW_SYNTHETIC_MARKER/);
  assert.doesNotMatch(fs.readFileSync(installed('install-log.txt'),'utf8'),/REVIEW_SYNTHETIC_MARKER/);
 }
});

test('R8 requested replacement fails when a client is absent',()=>{
 reset();assert.equal(installer(['--browser','none']).status,0);
 const result=fromInstalled(['register','codex','--replace'],{PATH:emptyFolder});
 assert.equal(result.status,2,result.out);assert.match(result.out,/not found on PATH/);assert.deepEqual(clientState().calls,[]);
 reset();const during=installer(['--browser','none','--register','codex','--replace'],{PATH:emptyFolder});assert.equal(during.status,2,during.out);
});
