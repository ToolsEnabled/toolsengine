#!/usr/bin/env node
// ToolsEngine installer.
//
// Plain Node.js. It uses nothing outside the release archive it ships in and
// it has no download step: every file it installs is already in the archive
// and is checked against release.json before it is written.
//
//   node install.mjs                      install this version, print how to connect a client
//   node install.mjs --register claude codex
//   node install.mjs register claude      connect an installed version later
//   node install.mjs check                start the installed server and test it
//   node install.mjs list                 installed versions
//   node install.mjs uninstall            remove this version
//
// The installer never writes over an installed version, never removes a
// workspace, and changes a client's configuration only through that client's
// own command, and only when asked.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const HERE = path.dirname(SELF);

export const CLIENTS = Object.freeze(['claude', 'codex']);
export const CLIENT_TITLES = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });
const COMMANDS = ['install', 'register', 'check', 'list', 'uninstall', 'help'];
const BROWSER_NAMES = Object.freeze({
  chrome: 'Google Chrome', msedge: 'Microsoft Edge', chromium: 'Chromium',
  playwright: 'the Chromium build that Playwright downloads', custom: 'the browser you named',
});

// A refusal or a mistake in the command line: shown as one plain message.
export class Stop extends Error {}

export const USAGE = `ToolsEngine installer

  node install.mjs [install] [options]    Install this version.
  node install.mjs register CLIENT...     Connect an installed version to claude, codex or both.
  node install.mjs check                  Start the installed server and test it.
  node install.mjs list                   Show installed versions.
  node install.mjs uninstall              Remove one installed version.

Options for install
  --register CLIENT...   Also connect the server to claude, codex or both (all), using
                         each client's own command. Without it the commands are printed.
                         They are also only printed when the environment names a home
                         folder that is not your own profile, or points a client at a
                         configuration folder outside it (CLAUDE_CONFIG_DIR, CODEX_HOME).
  --replace              With --register: replace a server of the same name that is
                         already registered. Without it an existing one is left alone.
  --workspace DIR        Folder the assistant may read and write.
                         Default: a new folder "workspace" beside the installed versions.
  --browser CHOICE       auto (default): the first of these that is on the machine:
                         Chrome, Edge, Chromium (Linux), a Chromium that Playwright
                         downloaded earlier. With none of them, no browser tools.
                         Or name one: chrome, msedge, chromium, playwright, none,
                         or the full path of a Chromium-based browser.
  --headed               Let the browser open in a window you can see. Default: hidden.
  --desktop              Windows only: turn on the four desktop tools, which can read
                         and operate the apps that are open on this account. Off by default.
  --desktop-left-half    With --desktop: move a window to the left half of its monitor
                         before input that needs the foreground.
  --name NAME            Name of the server in the clients. Default: toolsengine.
  --install-root DIR     Folder that holds the installed versions.
                         Default: ToolsEngine, directly under your profile.
  --home DIR             Use DIR instead of your profile for the two defaults above.
                         It decides where ToolsEngine is installed and nothing else.
  --no-check             Do not start the installed server to test it.
  --dry-run              Show what would be done. Change nothing.

Options for register, check, list and uninstall
  --version VERSION      The installed version to act on. Default: this installer's version.
  --install-root DIR, --home DIR, --name NAME, --replace as above.

Nothing is downloaded. Node.js 22.14 or newer is the one thing that must already be installed.
`;

// ---------------------------------------------------------------------------
// Command line

export function parseArgs(argv) {
  const options = {
    command: 'install', register: [], replace: false, workspace: null, browser: 'auto', headed: false,
    desktop: false, desktopLeftHalf: false, name: null, installRoot: null, home: null,
    check: true, dryRun: false, version: null, help: false,
  };
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    options.command = args.shift();
    if (!COMMANDS.includes(options.command)) throw new Stop(`Unknown command: ${options.command}\nCommands: ${COMMANDS.join(', ')}. Options start with --.`);
  }
  const values = { '--workspace': 'workspace', '--browser': 'browser', '--name': 'name', '--install-root': 'installRoot', '--home': 'home', '--version': 'version' };
  const flags = { '--replace': ['replace', true], '--headed': ['headed', true], '--desktop': ['desktop', true], '--desktop-left-half': ['desktopLeftHalf', true],
    '--no-check': ['check', false], '--dry-run': ['dryRun', true], '--help': ['help', true], '-h': ['help', true] };
  const addClients = words => {
    for (const word of words.flatMap(item => item.split(',')).map(item => item.trim().toLowerCase()).filter(Boolean)) {
      if (word === 'all') { for (const client of CLIENTS) if (!options.register.includes(client)) options.register.push(client); continue; }
      if (!CLIENTS.includes(word)) throw new Stop(`Unknown client: ${word}. Use claude, codex or all.`);
      if (!options.register.includes(word)) options.register.push(word);
    }
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    // An install is always of this installer's own version. The option is
    // refused on the install command whether or not a value follows it: it
    // used to be accepted and ignored, and later a bare "--version" was
    // answered with "needs a value" instead of this explanation.
    if (arg === '--version' && options.command === 'install') throw new Stop('--version is for register, check, list and uninstall. An install is always this installer\'s version.');
    if (values[arg]) {
      if (args[i + 1] === undefined || args[i + 1].startsWith('--')) throw new Stop(`${arg} needs a value.`);
      // An empty value would quietly become the current folder further on.
      if (!args[i + 1].trim()) throw new Stop(`${arg} was given an empty value.`);
      options[values[arg]] = args[++i];
    } else if (flags[arg]) options[flags[arg][0]] = flags[arg][1];
    else if (arg === '--register') {
      // One or more client names follow, separated by spaces or commas:
      // PowerShell turns "claude,codex" into two words on its own.
      const words = [];
      while (args[i + 1] !== undefined && !args[i + 1].startsWith('-')) words.push(args[++i]);
      if (!words.length) throw new Stop('--register needs a client: claude, codex or all.');
      addClients(words);
    } else if (!arg.startsWith('-') && options.command === 'register') addClients([arg]);
    else throw new Stop(`Unknown option: ${arg}\nRun "node install.mjs --help" for the list.`);
  }
  if (options.command === 'help') options.help = true;
  if (options.name !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(options.name)) throw new Stop('--name may hold letters, digits, - and _ only (at most 40).');
  if (options.desktopLeftHalf && !options.desktop) throw new Stop('--desktop-left-half only has a meaning together with --desktop.');
  if (options.headed && options.browser === 'none') throw new Stop('--headed has no meaning with --browser none.');
  if (options.replace && options.command === 'install' && !options.register.length) throw new Stop('--replace only has a meaning together with --register.');
  if (options.command === 'register' && !options.register.length && !options.help) throw new Stop('Name the client to connect: node install.mjs register claude, codex or all.');
  if (options.version !== null && !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(options.version)) throw new Stop('--version is not a version number.');
  for (const key of ['workspace', 'installRoot', 'home']) if (options[key] !== null) options[key] = path.resolve(options[key]);
  return options;
}

// ---------------------------------------------------------------------------
// The release that sits beside this file

export function sha256(data) { return createHash('sha256').update(data).digest('hex'); }

function safeParts(relative) {
  const parts = String(relative).split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..' || /[\\:\0]/.test(part)))
    throw new Stop(`release.json names an unsafe path: ${relative}`);
  return parts;
}

export function requirePlainParents(target) {
  const absolute = path.resolve(target);
  let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Stop('Installer parents must be plain directories, without links or junctions. Nothing was changed.');
  }
}

// Open before checking, and use the checked descriptor for all record I/O.
// O_NOFOLLOW is defense in depth on systems that support it; fstat also
// refuses links and an identity mismatch, including Windows reparse races.
function recordFile(file, operation, { create = false, write = false } = {}) {
  requirePlainParents(path.dirname(file));
  let prior;
  try { prior = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code !== 'ENOENT' || !create) throw error; }
  const plain = stat => stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n;
  if (prior && !plain(prior)) throw new Stop('Installer records must be plain, singly linked files. Nothing was changed.');
  const flags = (write ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | (fs.constants.O_NOFOLLOW || 0)
    | (!prior ? fs.constants.O_CREAT | fs.constants.O_EXCL : 0);
  const fd = fs.openSync(file, flags, 0o600);
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!plain(stat) || (prior && (prior.dev !== stat.dev || prior.ino !== stat.ino))) throw new Stop('Installer record identity changed. Nothing was changed.');
    return operation(fd);
  } finally { fs.closeSync(fd); }
}
function readRecord(file) { return recordFile(file, fd => fs.readFileSync(fd, 'utf8')); }
function writeRecord(file, text) { return recordFile(file, fd => { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, text); }, { create: true, write: true }); }
function appendRecord(file, text) { return recordFile(file, fd => fs.writeSync(fd, text, fs.fstatSync(fd).size, 'utf8'), { create: true, write: true }); }

export function readRelease(directory) {
  requirePlainParents(directory);
  const file = path.join(directory, 'release.json');
  let text;
  try { text = readRecord(file); }
  catch { throw new Stop(`release.json is missing from ${directory}.\nRun the installer from the folder the archive was extracted to.`); }
  const release = JSON.parse(text);
  if (release.name !== 'ToolsEngine' || typeof release.version !== 'string' || !Array.isArray(release.files) || !release.files.length
    || typeof release.entry !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(release.version))
    throw new Stop('release.json is not a ToolsEngine release description.');
  for (const entry of release.files) safeParts(entry.path);
  safeParts(release.entry);
  release.sha256 = sha256(text);
  return release;
}

// Compare a folder with the release description. Returns the list of
// differences; an empty list means every file is present and unchanged.
export function compareWithRelease(release, directory) {
  requirePlainParents(directory);
  const problems = [];
  for (const entry of release.files) {
    const target = path.join(directory, ...safeParts(entry.path));
    let stat;
    try { requirePlainParents(path.dirname(target)); stat = fs.lstatSync(target); } catch { problems.push(`missing or unsafe: ${entry.path}`); continue; }
    if (!stat.isFile()) { problems.push(`not a regular file: ${entry.path}`); continue; }
    const data = fs.readFileSync(target);
    if (data.length !== entry.size || sha256(data) !== entry.sha256) problems.push(`changed: ${entry.path}`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Where things go

// The profile the operating system records for this account. Environment
// variables are not trusted for this: a launcher started by another account
// can pass on that account's HOME or USERPROFILE. No option of the command
// line changes it either: --home says where ToolsEngine is installed, not
// whose account this is.
let statedProfile = null;
export function accountProfile() {
  if (statedProfile) return statedProfile;
  try { return os.userInfo().homedir || os.homedir(); } catch { return os.homedir(); }
}

// For the tests and for checking a release from a throwaway home, which need
// an installer that treats a throwaway folder as the account's profile. Only
// a program that imports this file can call it (tools/install-with-profile.mjs
// does); nothing in the command line or the environment leads here.
export function useAccountProfile(folder) {
  statedProfile = folder ? path.resolve(folder) : null;
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// Do two folders contain one another? Compared as text, and then by what the
// file system says each folder is (device and file number), for every folder
// from the inner one up to the root: one folder can have two spellings that
// resolving links does not bring together, on a mount that ignores the case
// of letters or on a second mount of the same folder. The same rule is in
// the server (src/config.js).
function folderIdentity(folder) {
  try {
    const stat = fs.statSync(folder, { bigint: true });
    if (stat.ino === 0n) throw new Stop('Filesystem identity unavailable; program separation cannot be proved.');
    return `${stat.dev}:${stat.ino}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function physicalChain(target, identify) {
  const rows = [], seen = new Set(); let suffix = [], folder = path.resolve(target);
  for (;;) {
    const identity = identify(folder);
    if (identity === null) {
      if (identify !== folderIdentity || path.dirname(folder) === folder || rows.length) throw new Stop('Filesystem identity unavailable; separation cannot be proved.');
    } else {
      if (seen.has(identity)) throw new Stop('Filesystem identity is ambiguous; separation cannot be proved.');
      seen.add(identity); rows.push({ identity, suffix: [...suffix] });
    }
    if (path.dirname(folder) === folder) break;
    suffix.unshift(path.basename(folder)); folder = path.dirname(folder);
  }
  return rows;
}
export function foldersOverlap(first, second, { identify = folderIdentity } = {}) {
  if (isInside(first, second) || isInside(second, first)) return true;
  const a = physicalChain(first, identify), b = physicalChain(second, identify);
  return a.some(left => b.some(right => left.identity === right.identity &&
    (left.suffix.length <= right.suffix.length && left.suffix.every((part,i) => part === right.suffix[i]) ||
     right.suffix.length <= left.suffix.length && right.suffix.every((part,i) => part === left.suffix[i]))));
}

// The real place of a path: links, junctions and short names resolved. For a
// path that does not exist yet, the real place of the nearest folder that
// does, with the rest appended.
function realPlace(target) {
  const absolute = path.resolve(target);
  let existing = absolute;
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(existing), ...rest); }
    catch {
      const parent = path.dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const directories = String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32' ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const directory of directories) for (const extension of extensions) {
    const candidate = join(directory, name + extension.toLowerCase());
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (platform === 'win32' || (stat.mode & 0o111))) return candidate;
    } catch { /* not here */ }
  }
  return null;
}

// The Node.js command written into a registration. A "node" on PATH that is
// this same program is preferred: it is usually a stable name, where the
// resolved path can carry a version number that changes with the next update.
export function nodeCommand() {
  const running = process.execPath;
  const onPath = findOnPath('node');
  if (onPath) try { if (fs.realpathSync(onPath) === fs.realpathSync(running)) return onPath; } catch { /* use the running one */ }
  return running;
}

// ---------------------------------------------------------------------------
// Browser

// Where Chrome, Edge and Chromium are looked for. The channel locations are
// the ones Playwright itself uses, so "--browser-channel chrome" finds the
// same file when the server starts.
export function browserCandidates({ platform = process.platform, env = process.env, profile, exists = fs.existsSync, chromiumRevision = null } = {}) {
  const found = [];
  const first = paths => paths.find(candidate => { try { return exists(candidate); } catch { return false; } });
  if (platform === 'win32') {
    const join = path.win32.join;
    const roots = ['C:\\Program Files', 'C:\\Program Files (x86)', ...(profile ? [join(profile, 'AppData', 'Local')] : [])];
    const chrome = first(roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')));
    if (chrome) found.push({ id: 'chrome', path: chrome, args: ['--browser-executable', chrome] });
    const edge = first(roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')));
    if (edge) found.push({ id: 'msedge', path: edge, args: ['--browser-executable', edge] });
  } else if (platform === 'linux') {
    const chrome = first(['/opt/google/chrome/chrome']);
    if (chrome) found.push({ id: 'chrome', path: chrome, args: ['--browser-executable', chrome] });
    const edge = first(['/opt/microsoft/msedge/msedge']);
    if (edge) found.push({ id: 'msedge', path: edge, args: ['--browser-executable', edge] });
    const chromium = first(['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']);
    if (chromium) found.push({ id: 'chromium', path: chromium, args: ['--browser-executable', chromium] });
  } else if (platform === 'darwin') {
    const chrome = first(['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']);
    if (chrome) found.push({ id: 'chrome', path: chrome, args: ['--browser-executable', chrome] });
    const edge = first(['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']);
    if (edge) found.push({ id: 'msedge', path: edge, args: ['--browser-executable', edge] });
  }
  // Playwright's own Chromium counts only when the exact build this release
  // was made for is already on the machine. It is never downloaded here.
  if (chromiumRevision && profile) {
    const pathApi = platform === 'win32' ? path.win32 : path.posix;
    const cache = platform === 'win32' ? pathApi.join(profile, 'AppData', 'Local', 'ms-playwright')
      : platform === 'darwin' ? pathApi.join(profile, 'Library', 'Caches', 'ms-playwright')
      : pathApi.join(profile, '.cache', 'ms-playwright');
    const folders = [`chromium-${chromiumRevision}`, `chromium_headless_shell-${chromiumRevision}`].map(name => pathApi.join(cache, name));
    const executable = platform === 'win32' ? pathApi.join(folders[0], 'chrome-win64', 'chrome.exe') : platform === 'linux' ? pathApi.join(folders[0], 'chrome-linux64', 'chrome') : pathApi.join(folders[0], 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (folders.every(folder => first([pathApi.join(folder, 'INSTALLATION_COMPLETE')])) && exists(executable))
      found.push({ id: 'playwright', path: executable, args: ['--browser-executable', executable] });
  }
  return found;
}

// Turn --browser into the list of browsers to try, best first. Each entry has
// the server arguments that select it. An empty list means no browser.
export function browserPlan(choice, candidates, { exists = fs.existsSync } = {}) {
  if (choice === 'none') return { requested: 'none', tryInOrder: [] };
  if (choice === 'auto') return { requested: 'auto', tryInOrder: candidates };
  if (['chrome', 'msedge', 'chromium', 'playwright'].includes(choice)) {
    const match = candidates.find(candidate => candidate.id === choice);
    if (match) return { requested: choice, tryInOrder: [match] };
    if (choice === 'chromium') throw new Stop('No Chromium was found in the usual places. Give its full path: --browser /full/path/to/chromium');
    // Asked for by name but not found by this installer: keep the request,
    // the server looks again each time it starts a browser.
    return { requested: choice, tryInOrder: [{ id: choice, path: null, args: choice === 'playwright' ? [] : ['--browser-channel', choice], notFound: true }] };
  }
  if (path.isAbsolute(choice)) {
    if (!exists(choice)) throw new Stop(`--browser names a file that does not exist: ${choice}`);
    return { requested: 'custom', tryInOrder: [{ id: 'custom', path: choice, args: ['--browser-executable', choice] }] };
  }
  throw new Stop(`--browser must be auto, chrome, msedge, chromium, playwright, none or the full path of a browser. Got: ${choice}`);
}

// ---------------------------------------------------------------------------
// Commands shown to the person and run for them

// A command line for the person to paste. Outside Windows every word that is
// not plainly safe goes into single quotes, which no shell reads into.
//
// On Windows a line has to work in Command Prompt and in PowerShell:
// - a comma would split a word in two in PowerShell, so such a word is quoted;
// - a bare "--" is taken away by PowerShell when the command is one of the
//   .ps1 launchers npm writes, so it is printed as "--", which both shells
//   pass on as it is;
// - $, a backtick and % are read differently by the two shells even inside
//   double quotes, and no spelling is right for both: pasteNote() says so.
const plainOnWindows = /^[A-Za-z0-9_\-.:\\/=@+]+$/;
const plainElsewhere = /^[A-Za-z0-9_\-.:/=@+,]+$/;
export function displayCommand(words, platform = process.platform) {
  const quote = platform === 'win32'
    ? word => word !== '--' && plainOnWindows.test(word) ? word : `"${word.replace(/(\\+)$/, '$1$1')}"`
    : word => plainElsewhere.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
  return words.map(quote).join(' ');
}

// What to tell the person about a printed line that cannot be right for both
// Windows shells, or null when the line can be pasted into either.
//
// A second kind: & | < > and ^. In double quotes they are plain characters to
// Command Prompt, so the printed line is right there. But a client installed
// through npm is a .cmd launcher, and a .cmd file is always run by Command
// Prompt, also when it is started from PowerShell. PowerShell takes the
// quotes off and puts them back only around words with a space, so the word
// reaches Command Prompt bare and the line is cut at that character:
// "C:\R&D\ws" would run a command named D\ws. For a client that is a real
// program (.exe) PowerShell passes the word on itself and nothing is wrong.
export function pasteNote(words, platform = process.platform) {
  if (platform !== 'win32') return null;
  const word = words.find(item => /[$`%"]/.test(item));
  if (word !== undefined)
    return `One word of this line (${word}) holds a character that Command Prompt and PowerShell read differently ($, \`, % or "). `
      + 'The line is written for neither: type that word yourself, in single quotes in PowerShell, or choose a folder without such a character.';
  // A command word without an ending can turn out to be a .cmd launcher too.
  const command = String(words[0] ?? '');
  const launcher = /\.(?:cmd|bat)$/i.test(command) || !/\.[A-Za-z0-9]+$/.test(path.win32.basename(command));
  if (words.some(item => item.includes('!'))) return 'Command Prompt can expand !NAME! even inside quotes when delayed expansion is enabled. Use a fresh cmd /d /v:off session for this printed line. In PowerShell prefer an .exe client or choose a path without ! when a .cmd launcher is involved.';
  if (!plainOnWindows.test(command)) return 'This command word is quoted. PowerShell requires the invocation operator &: prepend & to this line. Command Prompt uses the line as printed; .cmd arguments with metacharacters also need the shell precautions below.';
  const cut = launcher ? words.slice(1).find(item => /[&|<>^]/.test(item) && !/\s/.test(item)) : undefined;
  if (cut === undefined) return null;
  return `One word of this line (${cut}) holds a character that Command Prompt gives a meaning of its own (& | < > or ^). `
    + 'In Command Prompt the line is right as it stands. In PowerShell it is not: this client is started through a .cmd launcher, '
    + 'This argument has no space, so PowerShell hands the word to it without the quotes, and the line would be cut at that character. Paste it into Command Prompt, or choose a folder without such a character.';
}

// The exact registration, lookup and removal commands of each client.
export function clientCommands(client, name, serverCommand) {
  if (client === 'claude') return {
    add: ['mcp', 'add', '--scope', 'user', name, '--', ...serverCommand],
    remove: ['mcp', 'remove', name, '--scope', 'user'],
    show: ['mcp', 'get', name],
  };
  if (client === 'codex') return {
    add: ['mcp', 'add', name, '--', ...serverCommand],
    remove: ['mcp', 'remove', name],
    show: ['mcp', 'get', name],
  };
  throw new Stop(`Unknown client: ${client}`);
}

// On Windows a client installed through npm is a .cmd launcher, which only
// cmd.exe can start; cmd.exe gives some characters a meaning of its own, so a
// command line that holds one of them is not run. Returns the first word that
// stands in the way, or null when the command can be run as written.
export function unsafeForLauncher(file, words, platform = process.platform) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(file)) return null;
  const unsafe = [file, ...words].find(word => /["%!^&|<>\r\n]/.test(word));
  return unsafe === undefined ? null : unsafe;
}

// Run a client's command.
export function runClient(file, words, { timeout = 120000, env = process.env } = {}) {
  let result;
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(file)) {
    const unsafe = unsafeForLauncher(file, words);
    if (unsafe !== null) return { ran: false, status: null, output: '', reason: `a path holds a character that cannot be passed safely to a .cmd launcher: ${unsafe}` };
    const line = [file, ...words].map(word => `"${word.replace(/(\\+)$/, '$1$1')}"`).join(' ');
    result = spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { encoding: 'utf8', timeout, env, windowsHide: true, windowsVerbatimArguments: true });
  } else result = spawnSync(file, words, { encoding: 'utf8', timeout, env, windowsHide: true });
  if (result.error) return { ran: false, status: null, output: '', reason: result.error.code === 'ETIMEDOUT' ? 'the command did not finish in time' : String(result.error.message) };
  return { ran: true, status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`.trim() };
}

// ---------------------------------------------------------------------------
// A small MCP client over stdio, enough to test a server: newline-delimited
// JSON-RPC, one request at a time.

export class McpProcess {
  constructor(command, args, { cwd, env = process.env } = {}) {
    this.stderr = '';
    this.pending = new Map();
    this.nextId = 1;
    this.child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.exited = new Promise(resolve => {
      this.child.once('error', error => { this.failAll(error); resolve({ error }); });
      this.child.once('exit', (code, signal) => { this.failAll(new Error(`The server stopped (exit ${code ?? signal}). ${this.stderr.trim().slice(0, 600)}`)); resolve({ code, signal }); });
    });
    this.child.stdin.on('error', () => {});
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000); });
    let buffered = '';
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', chunk => {
      buffered += chunk;
      for (let end = buffered.indexOf('\n'); end >= 0; end = buffered.indexOf('\n')) {
        const line = buffered.slice(0, end).trim();
        buffered = buffered.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        const waiting = this.pending.get(message.id);
        if (!waiting) continue;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.error) waiting.reject(new Error(message.error.message || 'The server answered with an error.'));
        else waiting.resolve(message.result);
      }
    });
  }
  failAll(error) {
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
  request(method, params, timeout = 30000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No answer to ${method} within ${timeout / 1000} seconds.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
  }
  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }) + '\n');
  }
  async initialize(clientName = 'toolsengine-installer') {
    const result = await this.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: clientName, version: '1.0.0' } });
    this.notify('notifications/initialized');
    return result;
  }
  async callTool(name, args = {}, timeout = 60000) {
    const result = await this.request('tools/call', { name, arguments: args }, timeout);
    const text = (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    return { isError: result.isError === true, text, content: result.content || [] };
  }
  // Closing its input is how an MCP client tells a stdio server to stop.
  async close(wait = 15000) {
    try { this.child.stdin.end(); } catch { /* already closed */ }
    let timer;
    const outcome = await Promise.race([this.exited, new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), wait); })]);
    clearTimeout(timer);
    if (outcome === 'timeout') { this.child.kill(); await this.exited; return { forced: true }; }
    return { forced: false, ...outcome };
  }
}

// The sentence worth showing from a failed browser start: the error itself
// and, when the browser said why, that line. It sits further down in the
// text, after the long command line the browser was started with.
export function browserFailure(text) {
  const lines = String(text).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('###') && !/^(?:- )?<launch/.test(line));
  const first = lines[0] || 'The browser did not start.';
  // The server's own refusal for want of the sandbox is already plain. It is
  // written for the assistant that receives it as a tool result: here it is
  // shown to the person, so the sentences for the assistant are left out and
  // "the person" becomes "you".
  if (first.startsWith('The browser did not start, because its sandbox'))
    return first.split(' For the assistant reading this:')[0].replaceAll('the person\'s', 'your').replace('What the person can do', 'What you can do');
  const reason = lines.find(line => /FATAL|doesn't exist|cannot open shared object|error while loading|No such file|not installed/i.test(line));
  const tidy = line => line.replace(/^\[pid=\d+\]\[\w+\]\s*/, '').replace(/^\[[^\]]*\]\s*/, '');
  return (reason && reason !== first ? `${tidy(reason)} (${first})` : first).slice(0, 500);
}

// Start an installed server the way a client would and test it: handshake,
// tool list, system.status and, when a browser is configured, one blank page.
// No desktop tool is called. Files the blank page leaves in the workspace's
// artifacts folder are removed again.
export async function checkServer({ node, entry, serverArgs, workspace, expectedTools, browser }) {
  const report = { ok: false, started: false, tools: null, expectedTools, browser: browser ? 'not tried' : 'off' };
  // The one file the blank page leaves behind, as the server itself names it.
  // Nothing else in that folder is the check's to remove: the workspace can be
  // one that a running server is saving screenshots or downloads into.
  let ownSnapshot = null;
  const began = Date.now();
  const server = new McpProcess(node, [entry, ...serverArgs], { cwd: workspace });
  try {
    const hello = await server.initialize();
    report.started = true;
    report.startSeconds = Number(((Date.now() - began) / 1000).toFixed(1));
    report.server = `${hello.serverInfo?.name} ${hello.serverInfo?.version}`;
    const listed = await server.request('tools/list', {});
    report.tools = listed.tools.length;
    report.toolNames = listed.tools.map(tool => tool.name).sort();
    const status = await server.callTool('system.status');
    if (status.isError) throw new Error(`system.status failed: ${status.text.slice(0, 300)}`);
    const parsed = JSON.parse(status.text);
    report.status = { version: parsed.version, platform: parsed.platform, node: parsed.node, workspace: parsed.workspace,
      browserEnabled: parsed.browserEnabled, browserSession: parsed.browserSession, desktopEnabled: parsed.desktopEnabled };
    report.ok = report.tools === expectedTools;
    if (!report.ok) report.problem = `The server offers ${report.tools} tools; ${expectedTools} were expected.`;
    if (browser && report.ok) {
      const opened = Date.now();
      const page = await server.callTool('browser.navigate', { url: 'about:blank' }, 90000);
      if (page.isError) { report.browser = 'failed'; report.browserProblem = browserFailure(page.text); }
      else {
        report.browser = 'started';
        report.browserSeconds = Number(((Date.now() - opened) / 1000).toFixed(1));
        ownSnapshot = snapshotFileOf(page.text);
        await server.callTool('browser.close', {}, 30000).catch(() => {});
      }
    }
  } catch (error) {
    report.ok = false;
    report.problem = String(error.message || error).slice(0, 800);
  } finally {
    const closed = await server.close();
    report.stoppedCleanly = !closed.forced;
    if (ownSnapshot) {
      const file = path.join(workspace, 'artifacts', 'toolsengine', ownSnapshot);
      try { if (fs.lstatSync(file).isFile()) fs.unlinkSync(file); } catch { /* gone already, or not ours to force */ }
    }
  }
  return report;
}

// The name of the page-snapshot file that a browser.navigate answer links to:
// "- [Snapshot](artifacts/toolsengine/page-2026-01-01T00-00-00-000Z.yml)".
// On Windows the server writes the same with backslashes. Only a plain file
// name of exactly that kind is accepted.
export function snapshotFileOf(text) {
  const match = /\[Snapshot\]\(artifacts[\\/]toolsengine[\\/](page-[0-9A-Za-z-]+\.yml)\)/.exec(String(text));
  return match ? match[1] : null;
}

// Check the browsers in order and keep the first with which the server starts
// and a page opens. When none of them starts, the first one found stays
// configured and its failure is the one reported. When the server itself does
// not start, another browser would not help, so the search stops.
export async function pickBrowser(order, runCheck) {
  const attempts = [];
  for (const candidate of order.length ? order : [undefined]) {
    const report = await runCheck(candidate);
    attempts.push({ candidate: candidate?.id ?? null, ...report });
    if (report.ok && report.browser !== 'failed') return { chosen: candidate, check: attempts.at(-1), attempts };
    if (!report.ok) break;
  }
  return { chosen: order[0], check: attempts[0], attempts };
}

// ---------------------------------------------------------------------------
// Output

function makeLog() {
  const lines = [];
  let file = null;
  const log = (text = '') => {
    for (const line of String(text).split('\n')) {
      lines.push(line);
      process.stdout.write(line + '\n');
      if (file) appendRecord(file, line + '\n');
    }
  };
  log.saveTo = target => { appendRecord(target, lines.join('\n') + (lines.length ? '\n' : '')); file = target; };
  return log;
}

// The installer does not use the network. To make that a property of the
// program rather than a promise, the functions of this process that open a
// connection or look up a name are switched off before anything else runs.
// Programs the installer starts (the installed server for its check, and a
// client's own command with --register) are separate programs.
const network = { refused: [] };
function switchOffNetwork() {
  const refuse = what => () => { network.refused.push(what); throw new Error(`The ToolsEngine installer does not use the network (${what}).`); };
  net.Socket.prototype.connect = refuse('connection');
  net.Server.prototype.listen = refuse('listening socket');
  dgram.Socket.prototype.bind = refuse('UDP socket');
  dgram.Socket.prototype.send = refuse('UDP send');
  for (const name of ['lookup', 'lookupService', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveSrv', 'resolveTxt', 'reverse']) {
    dns[name] = refuse(`name lookup`);
    if (dns.promises?.[name]) dns.promises[name] = refuse('name lookup');
  }
  if (typeof globalThis.fetch === 'function') globalThis.fetch = refuse('fetch');
}

// ---------------------------------------------------------------------------
// Install

// A scanner can hold a freshly written file open for a moment on Windows.
function renamePatiently(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(from, to); return; }
    catch (error) {
      if (attempt >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

const PRIVATE_FOLDER = 0o700;

// Files are copied into a folder ".incoming-<version>-<process number>" and
// moved into place when all of them are there. An installer that is killed
// while copying cannot clear that folder away. The next install does.
//
// A name is not enough to go by: an install root can be any folder, and a
// folder of the person's own may be called like that. The installer
// therefore puts a mark of its own into the folder it copies into, and only
// a real folder directly in the install root, with such a name and with that
// mark, is ever removed. The mark names the process and the machine. A
// process number says something only on the machine it belongs to: for a
// folder marked on this machine the process is asked whether it still runs;
// one marked elsewhere (a root shared between machines or containers) is
// left alone until it is a day old, far longer than any copy takes.
const STAGING_MARK = '.toolsengine-install-in-progress';
const STAGING_WHAT = 'ToolsEngine installer staging folder';
const STAGING_OLD = 24 * 60 * 60 * 1000;

export function currentProcessIdentity(pid = process.pid) {
  if (process.platform !== 'linux') return { scope: null, start: null };
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    const namespace = fs.readlinkSync('/proc/self/ns/pid');
    const stat = fs.readFileSync(`/proc/${pid}/stat`,'utf8');
    const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    return { scope: `${boot}:${namespace}`, start };
  } catch { return { scope: null, start: null }; }
}
function writeStagingMark(folder, version) {
  fs.writeFileSync(path.join(folder, STAGING_MARK), JSON.stringify({ what: STAGING_WHAT, version, folder: path.basename(folder), pid: process.pid, host: os.hostname(), ...currentProcessIdentity(), startedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
}

function readStagingMark(folder) {
  try {
    const file = path.join(folder, STAGING_MARK);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1000) return null;
    const mark = JSON.parse(readRecord(file));
    return mark?.what === STAGING_WHAT && Number.isInteger(mark.pid) && mark.pid > 0 && typeof mark.host === 'string' && mark.host.length > 0 && typeof mark.scope === 'string' && mark.scope.length > 0 && typeof mark.start === 'string' && mark.start.length > 0 && !Number.isNaN(Date.parse(mark.startedAt)) ? mark : null;
  } catch { return null; }
}

export function clearAbandonedCopies(root, { alive = processAlive, host = os.hostname(), now = Date.now() } = {}) {
  const cleared = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return cleared; }
  for (const name of names) {
    const match = /^\.incoming-([0-9A-Za-z.+-]+)-(\d+)$/.exec(name);
    if (!match) continue;
    const folder = path.join(root, name);
    try {
      if (!fs.lstatSync(folder).isDirectory()) continue;
      const mark = readStagingMark(folder);
      // Not marked by an installer, or marked for another folder: not ours to remove.
      if (!mark || mark.version !== match[1] || mark.pid !== Number(match[2]) || mark.folder !== name) continue;
      const own = currentProcessIdentity();
      if (mark.host !== host || mark.scope !== own.scope || mark.pid === process.pid) continue;
      const live = alive(mark.pid);
      const current = live ? currentProcessIdentity(mark.pid) : null;
      const abandoned = live === false || (current?.start && current.start !== mark.start);
      if (!abandoned) continue;
      fs.rmSync(folder, { recursive: true, force: true });
      cleared.push(name);
    } catch { /* in use or not removable: left for the next time */ }
  }
  return cleared;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }   // it exists, and belongs to someone else
}

// The installer's own files in a version folder, beside those of the release.
const RECORD_FILES = Object.freeze(['release.json', 'installation.json', 'install-log.txt']);

// What a version folder holds beyond the files of the release and the
// installer's records: files that are not on the list, folders that no
// listed file lies in (named with a trailing slash and not looked into),
// links, and anything else that is not a plain file or folder.
export function unexpectedItems(release, directory) {
  requirePlainParents(directory);
  const files = new Set([...release.files.map(entry => entry.path), ...RECORD_FILES]);
  const folders = new Set();
  for (const name of files) { const parts = name.split('/'); for (let depth = 1; depth < parts.length; depth++) folders.add(parts.slice(0, depth).join('/')); }
  const unexpected = [];
  const look = (folder, prefix) => {
    let names = [];
    try { names = fs.readdirSync(folder); } catch { unexpected.push(`${prefix || '.'}: unreadable`); return; }
    for (const name of names.sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      let stat;
      try { stat = fs.lstatSync(path.join(folder, name)); } catch { unexpected.push(`${relative}: uncheckable`); continue; }
      if (stat.isDirectory()) { if (folders.has(relative)) look(path.join(folder, name), relative); else unexpected.push(`${relative}/`); }
      else if (!stat.isFile() || stat.nlink > 1 || !files.has(relative)) unexpected.push(relative);
    }
  };
  look(directory, '');
  return unexpected;
}

// Is the installer that started an unfinished install still at work? Returns
// words for who, or null. A process number can be asked about only on the
// machine it belongs to; a record made on another machine (a root shared
// between machines or containers) counts as at work for a day.
export function stillInstalling(record, { alive = processAlive, host = os.hostname(), identity = currentProcessIdentity } = {}) {
  if (record?.state && record.state !== 'installing') return null;
  const uncertain = 'an installer whose identity cannot be established; explicit recovery is required';
  if (!record || !Number.isInteger(record.installerPid) || record.installerPid <= 0 || !record.installerHost || !record.installerScope || !record.installerProcessStart) return uncertain;
  const own = currentProcessIdentity();
  if (record.installerHost !== host || record.installerScope !== own.scope) return `an installer on another machine (${record.installerHost}) or process namespace; explicit recovery is required`;
  const live = alive(record.installerPid);
  if (live === false) return null;
  const current = identity(record.installerPid);
  if (!current?.start || current.scope !== own.scope) return uncertain;
  return current.start !== record.installerProcessStart ? null : `process ${record.installerPid} on this machine`;
}

// A folder that was there before is used as it is. Outside Windows, say so
// when accounts other than the owner may write into it: the statement that
// only this account can change the program would not hold there.
function openToOthers(folder) {
  if (process.platform === 'win32') return null;
  try { const mode = fs.statSync(folder).mode & 0o777; return mode & 0o022 ? mode.toString(8) : null; } catch { return null; }
}

function requireNode(release) {
  const wanted = String(release.node || '>=22.14.0').replace(/^>=/, '').split('.').map(Number);
  const have = process.versions.node.split('.').map(Number);
  const older = have[0] < wanted[0] || (have[0] === wanted[0] && (have[1] < wanted[1] || (have[1] === wanted[1] && have[2] < (wanted[2] || 0))));
  if (older) throw new Stop(`ToolsEngine needs Node.js ${wanted.join('.')} or newer. This is Node.js ${process.versions.node} (${process.execPath}).\nInstall a newer Node.js, open a new terminal and run the installer again.`);
}

function resolvePlan(options, release) {
  const realProfile = accountProfile();
  const profile = options.home || realProfile;
  // Running from an installed copy: its own folder's parent is the root.
  const installedCopy = fs.existsSync(path.join(HERE, 'installation.json'));
  const root = options.installRoot || (installedCopy && !options.home ? path.dirname(HERE) : path.join(profile, 'ToolsEngine'));
  const version = options.version || release.version;
  const versionDir = version ? path.join(root, version) : null;
  return { realProfile, profile, root, version, versionDir, installedCopy, defaultRoot: !options.installRoot };
}

function serverArguments({ workspace, browserArgs, headed, desktop, desktopLeftHalf, realProfile }) {
  return ['--workspace', workspace, ...browserArgs, ...(headed && !browserArgs.includes('--no-browser') ? ['--headed'] : []),
    ...(desktop ? ['--desktop-profile-root', realProfile] : []), ...(desktop && desktopLeftHalf ? ['--desktop-left-half'] : [])];
}

// The check never opens a window: for a server that is set to show its
// browser, the hidden mode is asked for last, and the last one counts.
function argumentsForCheck(serverArgs) {
  return serverArgs.includes('--headed') ? [...serverArgs, '--headless'] : serverArgs;
}

// "node" where that word starts this same program, which is shorter to read
// and to type than its full path; the full path otherwise.
function nodeWord() {
  const onPath = findOnPath('node');
  if (onPath) try { if (fs.realpathSync(onPath) === fs.realpathSync(process.execPath)) return 'node'; } catch { /* use the full path */ }
  return process.execPath;
}

function expectedToolCount(release, { browser, desktop }) {
  return (browser ? release.tools.core : release.tools.withoutBrowser) + (desktop ? release.tools.windowsDesktop : 0);
}

function describeBrowser(log, record, versionDir, headed) {
  const download = displayCommand([nodeWord(), path.join(versionDir, 'app', 'node_modules', 'playwright', 'cli.js'), 'install', 'chromium']);
  log('Browser');
  if (!record.id && record.requested === 'none') {
    log('  None, as asked (--browser none). The browser tools are switched off; the file and web-reading tools remain.');
    return;
  }
  if (!record.id) {
    log('  None. No Chrome or Edge was found on this machine, so the browser tools are switched off');
    log('  (the server is started with --no-browser). The file and web-reading tools work without one.');
    log('  To get the browser tools: install Chrome or Edge and install ToolsEngine again, or download');
    log('  the Chromium that Playwright provides (this needs the network) with');
    log(`    ${download}`);
    log('  and then install ToolsEngine again with --browser playwright.');
    return;
  }
  const where = record.path ? ` (${record.path})` : '';
  if (record.id === 'playwright' && record.notFound) {
    log('  The Chromium that Playwright downloads, as asked. It is not on this machine yet, so the browser');
    log('  tools will fail until it is downloaded (this needs the network) with');
    log(`    ${download}`);
  } else if (record.id === 'playwright') log(`  The Chromium that Playwright downloads, already on this machine${where}.`);
  else if (record.notFound) log(`  ${BROWSER_NAMES[record.id]}, as asked. This installer did not find it in the usual places; the server looks again when it starts.`);
  else log(`  ${BROWSER_NAMES[record.id]}${record.id === 'custom' ? '' : ', already installed on this machine'}${where}.`);
  log(`  ToolsEngine starts it ${headed ? 'in a window you can see (--headed)' : 'hidden'}, with a temporary profile of its own. It does not use your`);
  log('  everyday browser profile or its sign-ins. No browser is in the archive and none is downloaded.');
}

// Print a command for the person to paste, with a note when the line cannot
// be right for both Windows shells.
function printCommand(log, words) {
  log(`    ${displayCommand(words)}`);
  const note = pasteNote(words);
  if (note) log(`    Note: ${note}`);
}

// offerRegister: false where the installer's own register command would be
// refused in the same way (the environment's home is not the person's
// profile), so it is not suggested.
function printClientCommands(log, plan, record, { offerRegister = true } = {}) {
  for (const client of CLIENTS) {
    const found = findOnPath(client);
    const shown = found ? path.basename(found) : client;
    const commands = clientCommands(client, record.serverName, [record.node, record.entry, ...record.serverArgs]);
    log('');
    log(`  ${CLIENT_TITLES[client]}${found ? '' : ` (the "${client}" command was not found on PATH; install ${CLIENT_TITLES[client]} first)`}:`);
    printCommand(log, [shown, ...commands.add]);
  }
  if (!offerRegister) return;
  log('');
  log('  Or let the installer run them:');
  log(`    ${displayCommand([nodeWord(), path.join(plan.versionDir, 'install.mjs'), 'register', ...CLIENTS])}`);
}

// The user-scope entry of that name in Claude Code's configuration, in the
// form of the command that adds it again. It is read so that the entry can be
// put back if replacing it fails: Claude Code has no command that prints an
// entry in a form that can be added again.
//
// What is true of the entry's content:
// - The whole file is read and parsed, because that is how one entry is
//   found in it; only this entry is used, and nothing else leaves this
//   function.
// - Putting the entry back passes its settings to Claude Code's own command
//   as "-e NAME=value" words. That is the only form the command takes, and
//   those words are visible to this account's other programs for as long as
//   the command runs.
// - The values of the settings are never printed or written to the install
//   log. If putting the entry back fails, the entry is shown so that the
//   person can add it again, with everything that can be a secret left out
//   (maskedEntry below).
export function claudeUserEntry(name, { env = process.env, home = os.homedir() } = {}) {
  const file = path.join(env.CLAUDE_CONFIG_DIR || home, '.claude.json');
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { return { state: error.code === 'ENOENT' ? 'absent' : 'unreadable' }; }
  const entry = parsed?.mcpServers?.[name];
  if (entry === undefined) return { state: 'absent' };
  const strings = list => Array.isArray(list) && list.every(item => typeof item === 'string');
  const settings = entry?.env ?? {};
  const restorable = entry && typeof entry === 'object' && (entry.type === undefined || entry.type === 'stdio') && typeof entry.command === 'string' && entry.command
    && strings(entry.args ?? []) && typeof settings === 'object' && !Array.isArray(settings) && Object.values(settings).every(value => typeof value === 'string')
    && Object.keys(entry).every(key => ['type', 'command', 'args', 'env'].includes(key));
  if (!restorable) return { state: 'not-restorable' };
  const pairs = Object.entries(settings).map(([key, value]) => `${key}=${value}`);
  return { state: 'present', settings: pairs.length,
    restore: ['mcp', 'add', '--scope', 'user', name, ...(pairs.length ? ['-e', ...pairs] : []), '--', entry.command, ...(entry.args ?? [])] };
}

// The command that adds an entry back, for showing to the person: what is
// printed also goes into install-log.txt, so nothing that can be a secret is
// in it. Left out are
// - the value of every setting (the words between -e and --);
// - the value of every word of the form NAME=value or --name=value among the
//   entry's own arguments;
// - everything after an argument whose name says it carries a secret, such
//   as --token, --api-key or --password: the rest is one "...";
// - a user name and password inside an address.
// The program and its ordinary arguments stay, so that the person can see
// which entry it was. The full entry is in Claude Code's own backup files.
export function maskedEntry() { return ['[previous command, arguments and settings omitted]']; }

// Register with the named clients through their own commands.
//
// Replacing an earlier registration must never end with none: nothing is
// removed until the new command is known to be one that will be run as
// written, and until the old entry is known to be one that can be put back.
// Codex replaces an entry in one step with its add command, so there nothing
// is removed at all. Claude Code refuses to add a name that exists, so there
// the old entry is removed first, and put back if the add then fails.
function registerClients(log, record, clients, { replace }) {
  const results = [];
  const serverCommand = [record.node, record.entry, ...record.serverArgs];
  const name = record.serverName;
  for (const client of clients) {
    const title = CLIENT_TITLES[client];
    const commands = clientCommands(client, name, serverCommand);
    const file = findOnPath(client);
    const shown = file ? path.basename(file) : client;
    const entry = { client, name, at: new Date().toISOString(), status: 'failed',
      command: displayCommand([shown, ...commands.add]), removeCommand: displayCommand([shown, ...commands.remove]) };
    results.push(entry);
    const note = pasteNote([shown, ...commands.add]);
    const showCommand = () => { log(`    ${entry.command}`); if (note) log(`    Note: ${note}`); };
    const output = text => { for (const line of text.split('\n').filter(Boolean).slice(0, 8)) log(`    > ${line}`); };
    const registered = how => {
      entry.status = 'registered';
      log(`  ${title}: ${how} as "${name}" with its own command:`);
      showCommand();
    };
    const keptExisting = why => {
      entry.status = 'kept-existing';
      log(`  ${title}: not changed. ${why}`);
    };
    const alreadyThere = () => {
      keptExisting(`A server named "${name}" is already registered and was left as it is.`);
      log(`    To see it:      ${displayCommand([shown, ...commands.show])}`);
      log('    To switch it to this version, run the installer\'s register command again with --replace.');
    };
    log('');
    if (!file) {
      entry.status = 'client-not-found';
      log(`  ${title}: not registered. The "${client}" command was not found on PATH. Install ${title}, then run:`);
      showCommand();
      continue;
    }
    const outside = configurationOutsideProfile(client);
    if (outside) {
      entry.status = 'not-run';
      entry.variable = outside.variable;
      log(`  ${title}: not run. ${outside.variable} is set to`);
      log(`    ${outside.value}`);
      log(`  which is not inside your own profile (${outside.own}), so ${title} would have changed a configuration`);
      log('  that is not this account\'s. In a terminal of your own, without that variable, run:');
      showCommand();
      continue;
    }
    // First of all: will the new command be run as written? If not, nothing
    // else is started, so nothing can be lost.
    const blocked = unsafeForLauncher(file, commands.add);
    if (blocked !== null) {
      log(`  ${title}: not registered, and nothing was changed. A path holds a character that cannot be passed`);
      log(`  safely to the client's .cmd launcher: ${blocked}`);
      log('    Choose a folder without " % ! ^ & | < >, or run the command yourself (see the note for which terminal):');
      showCommand();
      continue;
    }

    if (client === 'codex') {
      // Is a server of this name registered already? Codex would replace it
      // silently, so it is asked first; only the exit status is read.
      const probe = runClient(file, commands.show);
      if (!probe.ran) { log(`  ${title}: not registered (${probe.reason}). Run:`); showCommand(); continue; }
      const existing = probe.status === 0;
      if (existing && !replace) { alreadyThere(); continue; }
      const added = runClient(file, commands.add);
      if (added.ran && added.status === 0) { registered(existing ? 'replaced the earlier registration (--replace); registered' : 'registered'); output(added.output); continue; }
      log(`  ${title}: its command ${added.ran ? `failed (exit ${added.status})` : `could not be run (${added.reason})`}.${existing ? ' The earlier registration was not removed and is unchanged.' : ''}`);
      output(added.output);
      log(`    The command was: ${entry.command}`);
      continue;
    }

    // Claude Code.
    let old = { state: 'absent' };
    if (replace) {
      old = claudeUserEntry(name);
      if (old.state === 'unreadable' || old.state === 'not-restorable' || (old.state === 'present' && unsafeForLauncher(file, old.restore) !== null)) {
        keptExisting(`The earlier "${name}" entry ${old.state === 'unreadable' ? 'could not be read from Claude Code\'s configuration' : 'is of a kind the installer could not put back'},`);
        log('  so it was not removed: had the new registration then failed, there would have been none.');
        log('    To replace it yourself, remove it and add the new one:');
        log(`    ${entry.removeCommand}`);
        showCommand();
        continue;
      }
      if (old.state === 'present') {
        const removed = runClient(file, commands.remove);
        if (!removed.ran || removed.status !== 0) {
          log(`  ${title}: the earlier "${name}" registration could not be removed${removed.ran ? ` (exit ${removed.status})` : ` (${removed.reason})`}; nothing was changed.`);
          output(removed.output);
          continue;
        }
      }
    }
    const added = runClient(file, commands.add);
    if (added.ran && added.status === 0) { registered(old.state === 'present' ? 'replaced the earlier registration (--replace); registered' : 'registered'); output(added.output); continue; }
    if (added.ran && old.state !== 'present' && /already exists/i.test(added.output)) {
      if (!replace) { alreadyThere(); continue; }
      // Asked to replace, but the entry is not where the installer looked for
      // it (it can be registered for one project only). It is left alone.
      keptExisting(`Claude Code says a server named "${name}" exists, but it is not in the user configuration the installer reads,`);
      log('  so it could not be kept safe for putting back and was not removed. To replace it yourself:');
      log(`    ${displayCommand([shown, 'mcp', 'remove', name])}`);
      showCommand();
      continue;
    }
    log(`  ${title}: its command ${added.ran ? `failed (exit ${added.status})` : `could not be run (${added.reason})`}.`);
    output(added.output);
    log(`    The command was: ${entry.command}`);
    if (old.state === 'present') {
      // The old entry is gone and the new one was not accepted: put the old one back.
      const restored = runClient(file, old.restore);
      if (restored.ran && restored.status === 0) log(`  ${title}: the earlier "${name}" registration was put back as it was.`);
      else {
        log(`  ${title}: the earlier "${name}" registration could NOT be put back. Claude Code now has no "${name}" server.`);
        log('    Claude Code keeps copies of its configuration file in the "backups" folder beside it: the whole entry is there.');
        log('    The previous command, arguments and settings are omitted because they may contain secrets.');
        log('    The previous command, arguments and settings are omitted because they may contain secrets.');
      }
    }
  }
  return results;
}

function samePath(a, b) {
  return process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
}

// Claude Code and Codex keep their configuration under the home folder that
// the environment names. A terminal started by another account can carry that
// account's home: running a client there would change the other account's
// configuration. The clients are run only when the home in the environment is
// this account's own profile, as the operating system records it.
//
// --home is not looked at here. It says where ToolsEngine is installed. If it
// counted as the profile, an install into another folder would run no client
// (the environment's home would never equal it), and in a terminal that
// carries another account's home, naming that home with --home would make
// the two equal and the clients would run against the other account.
function otherHome() {
  const own = accountProfile();
  const named = os.homedir();
  return samePath(named, own) || samePath(realPlace(named), realPlace(own)) ? null : { named, own };
}

function explainOtherHome(log, other) {
  log('  The clients were not run. The environment of this terminal names');
  log(`    ${other.named}`);
  log('  as the home folder, and your own profile is');
  log(`    ${other.own}`);
  log('  Claude Code and Codex keep their configuration under the home folder, so they would have');
  log('  changed the configuration in the first one. In a terminal of your own, run the command for');
  log('  each client you use:');
}

// Each client can be pointed at another configuration folder by a variable of
// its own. Carried over from another account, with the right home, it would
// have the client change that account's configuration: a folder outside this
// account's profile is treated like another account's home, and that client
// is not run.
const CONFIG_VARIABLES = Object.freeze({ claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' });
function configurationOutsideProfile(client) {
  const variable = CONFIG_VARIABLES[client];
  const value = process.env[variable];
  if (!value) return null;
  const own = accountProfile();
  return isInside(realPlace(value), realPlace(own)) ? null : { variable, value: path.resolve(value), own };
}

function describeConfigVariables(log) {
  for (const client of CLIENTS) {
    const variable = CONFIG_VARIABLES[client];
    if (process.env[variable] && !configurationOutsideProfile(client)) log(`  ${variable} is set, so ${CLIENT_TITLES[client]} uses the configuration in ${process.env[variable]}`);
  }
}

async function install(options, log) {
  const release = readRelease(HERE);
  requireNode(release);
  if (fs.existsSync(path.join(HERE, 'installation.json')))
    throw new Stop(`This is the installed copy of ToolsEngine ${release.version}. To install, run install.mjs from the folder the archive was extracted to.\nTo connect a client: node install.mjs register claude codex`);
  const plan = resolvePlan({ ...options, version: null }, release);
  if (options.desktop && process.platform !== 'win32') throw new Stop('--desktop is for Windows. On this system ToolsEngine offers the browser, file and web-reading tools.');
  const [targetSystem] = String(release.target || '').split('-');
  const thisSystem = process.platform === 'win32' ? 'windows' : process.platform;

  log(`ToolsEngine ${release.version} installer (${release.target} archive, source ${String(release.commit).slice(0, 7)})`);
  if (options.dryRun) log('Dry run: nothing is changed.');
  if (targetSystem && targetSystem !== thisSystem) log(`Note: this archive was made for ${targetSystem} and this system is ${thisSystem}. The files are the same; only the ${targetSystem} archive was tested on ${targetSystem}.`);
  if (!options.home && otherHome())
    log(`Note: the environment names ${os.homedir()} as the home folder, but this account's own profile is ${plan.realProfile}. ToolsEngine is installed under the account's own profile. --home DIR installs it under another folder.`);
  log('');

  // 1. What is at the place this version goes to?
  //    nothing, or an empty folder         -> install
  //    a finished install                  -> never written over
  //    an install started and not finished -> finished now, if its files are complete
  //    anything else                       -> not ours, left alone
  // An empty folder of that name is what an uninstall leaves behind when a
  // terminal was still standing in it. It holds nothing, so it is cleared.
  const emptyFolder = directory => { try { return fs.lstatSync(directory).isDirectory() && fs.readdirSync(directory).length === 0; } catch { return false; } };
  let resume = false;
  if (emptyFolder(plan.versionDir)) {
    if (!options.dryRun) try { fs.rmdirSync(plan.versionDir); } catch { /* reported just below */ }
    if (!options.dryRun && fs.existsSync(plan.versionDir))
      throw new Stop(`${plan.versionDir} is an empty folder that cannot be removed, because a program is using it as its current folder (often a terminal).\nLeave that folder in the terminal, or close it, and run the installer again.`);
  } else if (fs.existsSync(plan.versionDir)) {
    const found = installedState(plan.versionDir);
    if (found.state === 'foreign')
      throw new Stop(`${plan.versionDir} exists and was not made by this installer.\nNothing was written over. Move it away or choose another --install-root.`);
    if (found.state === 'installed')
      throw new Stop(`ToolsEngine ${release.version} is already installed in ${plan.versionDir}.\nAn installed version is never written over.\n  To connect a client to it:  ${displayCommand([nodeWord(), path.join(plan.versionDir, 'install.mjs'), 'register', 'claude', 'codex'])}\n  To remove it first:         ${displayCommand([nodeWord(), path.join(plan.versionDir, 'install.mjs'), 'uninstall'])}`);
    // Started and not finished: the copy was interrupted after it reached its
    // place, most likely during the check. Complete, unchanged files of this
    // very release are used as they are. Anything else is not built upon.
    const uninstallCommand = displayCommand([nodeWord(), SELF, 'uninstall', ...(options.home ? ['--home', options.home] : []), ...(options.installRoot ? ['--install-root', options.installRoot] : [])]);
    if (found.release.sha256 !== release.sha256 || compareWithRelease(release, plan.versionDir).length) {
      // With its record, uninstall removes it. Without one the uninstall
      // command takes only a folder that matches this archive, which this
      // one does not: it is for the person to delete.
      const wayOut = found.record?.releaseSha256
        ? `Remove it, then install again:\n  ${uninstallCommand}`
        : 'It holds no record of its install, so the installer will not remove it either. Look at what it holds, delete the folder yourself, then install again.';
      throw new Stop(`An earlier install of ToolsEngine ${release.version} in ${plan.versionDir} was not finished, and its files are not complete or are not those of this archive.\nNothing was changed. ${wayOut}`);
    }
    // The listed files being right is not enough to build on a folder that
    // someone else may have had their hands in since.
    // - It must be a real folder of this account.
    requirePlainParents(plan.versionDir);
    if (process.platform === 'win32') throw new Stop('Automatic recovery on Windows is refused because installer ownership cannot be verified here. Remove the unfinished version with its matching archive and install again. Nothing was changed.');
    const folder = fs.lstatSync(plan.versionDir);
    if (!folder.isDirectory()) throw new Stop(`${plan.versionDir} is a link, not a folder. An install is not finished through a link. Nothing was changed.`);
    if (typeof process.getuid === 'function' && folder.uid !== process.getuid())
      throw new Stop(`${plan.versionDir} holds an install that was not finished, and the folder belongs to another account. It is not built upon. Nothing was changed.`);
    // - No installer may still be at work in it. An installer writes its
    //   process number and machine into the record before it starts the check.
    const still = stillInstalling(found.record);
    if (still) throw new Stop(`ToolsEngine ${release.version} is being installed into ${plan.versionDir} right now, by ${still}.\nWait for that to finish. Nothing was changed.`);
    // - It must hold nothing but the files of this release and the
    //   installer's own records. A file that is not on the list is not
    //   checked by anything, and one in the right place is loaded by the
    //   program in place of a file that is: app/src/node_modules, for one.
    const extra = unexpectedItems(release, plan.versionDir);
    if (extra.length)
      throw new Stop(`An earlier install of ToolsEngine ${release.version} in ${plan.versionDir} was not finished, and the folder holds ${extra.length} item(s) that are not part of this release (${extra.slice(0, 3).join(', ')}${extra.length > 3 ? ', ...' : ''}).\nAn install is not finished on top of things it did not put there. Nothing was changed.\nRemove the unfinished install; what the installer did not put there stays in the folder, for you to look at and move away:\n  ${uninstallCommand}`);
    resume = true;
  }
  const workspace = options.workspace || path.join(plan.root, 'workspace');
  if (isInside(workspace, plan.versionDir) || isInside(plan.versionDir, workspace))
    throw new Stop(`The workspace (${workspace}) and the program folder (${plan.versionDir}) must not contain one another: the assistant can write anywhere in the workspace, and must not be able to change the program.`);
  // A browser installed for this account alone sits under the account's
  // profile, wherever --home puts ToolsEngine.
  const candidates = browserCandidates({ profile: plan.realProfile, chromiumRevision: release.browser?.chromiumRevision });
  const browser = browserPlan(options.browser, candidates);

  // 2. The archive itself, before anything is created: every file it should
  //    hold is there and is what release.json says.
  if (!resume) {
    const damage = compareWithRelease(release, HERE)[0];
    if (damage) throw new Stop(`The archive is damaged or was changed after it was built: ${damage.startsWith('changed: ') ? `${damage.slice(9)} does not match release.json` : damage}.\nNothing was installed. Extract the archive again from the original file.`);
  }

  // 3. The workspace, before anything is copied: a workspace that cannot be
  //    used must stop the install while there is still nothing to clear up.
  let workspaceCreated = false;
  let workspacePath = workspace;
  if (!options.dryRun) {
    let stat = null;
    try { stat = fs.statSync(workspace); } catch { /* not there yet */ }
    if (stat && !stat.isDirectory()) throw new Stop(`The workspace is not a folder: ${workspace}\nNothing was installed.`);
    workspaceCreated = !stat;
    const rootCreated = !fs.existsSync(plan.root);
    try {
      // New folders are for this account only (mode 700 outside Windows, where
      // the mode is not used): what the umask happens to be does not decide
      // who can change the program or read the workspace.
      fs.mkdirSync(plan.root, { recursive: true, mode: PRIVATE_FOLDER });
      fs.mkdirSync(workspace, { recursive: true, mode: PRIVATE_FOLDER });
    } catch (error) { throw new Stop(`The workspace folder could not be created (${error.code || error.message}): ${workspace}\nNothing was installed.`); }
    // The server refuses a workspace path that passes through a link.
    workspacePath = fs.realpathSync.native(workspace);
    // The same question as above, now about the folders as they really are:
    // a link, a junction or a short 8.3 name can make two paths that look
    // apart name folders that lie inside one another, and so can a mount
    // that gives one folder two spellings.
    const programPath = path.join(fs.realpathSync.native(plan.root), release.version);
    if (foldersOverlap(workspacePath, programPath)) {
      if (workspaceCreated) try { fs.rmdirSync(workspace); } catch { /* not empty: left */ }
      if (rootCreated) try { fs.rmdirSync(plan.root); } catch { /* not empty: left */ }
      throw new Stop(`The workspace ${workspace} is really ${workspacePath}, and the program folder is really ${programPath}.\nThey must not contain one another: the assistant can write anywhere in the workspace, and must not be able to change the program.\nNothing was installed.`);
    }
  }
  // What is known before the check. It is written beside the files as soon as
  // they are in place, so that an install interrupted after that point can be
  // recognised, finished and removed.
  const started = { name: 'ToolsEngine', version: release.version, commit: release.commit, target: release.target, releaseSha256: release.sha256,
    state: 'installing', startedAt: new Date().toISOString(), installerPid: process.pid, installerHost: os.hostname(), installerScope: currentProcessIdentity().scope, installerProcessStart: currentProcessIdentity().start,
    installedFrom: HERE, installRoot: plan.root, versionDir: plan.versionDir,
    workspace: workspacePath, serverName: options.name || 'toolsengine', registrations: [] };

  log('Program');
  log(`  from  ${HERE}`);
  log(`  to    ${plan.versionDir}`);
  if (plan.defaultRoot) {
    log('        This is a folder directly under your profile, and not under AppData, on purpose:');
    log('        on some machines AppData and shared work folders can be changed by sandboxed apps,');
    log('        and a program that an assistant runs should sit where only your account can change it.');
  }
  const abandoned = options.dryRun ? [] : clearAbandonedCopies(plan.root);
  if (abandoned.length) log(`  Cleared away ${abandoned.length} half-copied folder(s) that an earlier, interrupted install left in ${plan.root}.`);
  const rootOpen = options.dryRun ? null : openToOthers(plan.root);
  if (rootOpen) {
    log(`  Note: ${plan.root} was there already, and accounts other than yours may write into it (mode ${rootOpen}).`);
    log('        It is used as it is. "chmod 700" on it makes it yours alone.');
  }

  // 4. Copy, checking every file against release.json again as it is written.
  const staging = path.join(plan.root, `.incoming-${release.version}-${process.pid}`);
  let bytes = 0;
  if (resume) {
    if (!options.dryRun) {
      writeRecord(path.join(plan.versionDir, 'installation.json'), JSON.stringify(started, null, 2) + '\n');
      log.saveTo(path.join(plan.versionDir, 'install-log.txt'));
    }
    log('  An earlier install of this version was not finished. Its files are complete and unchanged,');
    log(`  so nothing is copied again and the install ${options.dryRun ? 'would be' : 'is'} finished now.`);
  } else if (!options.dryRun) {
    fs.mkdirSync(plan.root, { recursive: true, mode: PRIVATE_FOLDER });
    fs.mkdirSync(staging, { mode: PRIVATE_FOLDER });
    try {
      writeStagingMark(staging, release.version);
      for (const entry of release.files) {
        const parts = safeParts(entry.path);
        const source = path.join(HERE, ...parts);
        let stat;
        try { stat = fs.lstatSync(source); } catch { throw new Stop(`The archive is incomplete: ${entry.path} is missing. Extract it again.`); }
        if (!stat.isFile()) throw new Stop(`The archive is damaged: ${entry.path} is not a regular file.`);
        const data = fs.readFileSync(source);
        if (data.length !== entry.size || sha256(data) !== entry.sha256)
          throw new Stop(`The archive is damaged or was changed after it was built: ${entry.path} does not match release.json.\nNothing was installed. Extract the archive again from the original file.`);
        const target = path.join(staging, ...parts);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data, { flag: 'wx', mode: entry.mode === '755' ? 0o755 : 0o644 });
        bytes += data.length;
      }
      fs.copyFileSync(path.join(HERE, 'release.json'), path.join(staging, 'release.json'), fs.constants.COPYFILE_EXCL);
      const problems = compareWithRelease(release, staging);
      if (problems.length) throw new Stop(`The copy does not match release.json (${problems.slice(0, 3).join('; ')}). Nothing was installed.`);
      fs.writeFileSync(path.join(staging, 'installation.json'), JSON.stringify(started, null, 2) + '\n', { flag: 'wx' });
      if (fs.existsSync(plan.versionDir)) throw new Stop(`${plan.versionDir} appeared while installing. Nothing was written over.`);
      // The mark belongs to the copying, not to the install: it is taken out
      // as the last thing before the folder is moved into place.
      fs.unlinkSync(path.join(staging, STAGING_MARK));
      renamePatiently(staging, plan.versionDir);
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      // A workspace folder made a moment ago for an install that did not happen.
      if (workspaceCreated) try { fs.rmdirSync(workspace); } catch { /* not empty, or gone: left */ }
      throw error;
    }
    log.saveTo(path.join(plan.versionDir, 'install-log.txt'));
    log(`  ${release.files.length.toLocaleString('en-US')} files (${(bytes / 1048576).toFixed(1)} MB) copied, each checked against release.json by SHA-256.`);
  } else log(`  ${release.files.length.toLocaleString('en-US')} files would be copied and checked against release.json.`);
  log('  Network: not used. Nothing is downloaded, and this installer keeps its own connection');
  log('  and name-lookup functions switched off while it runs.');
  log('');

  log('Workspace');
  log(`  ${workspacePath}${options.dryRun ? (fs.existsSync(workspace) ? ' (exists)' : ' (would be created)') : workspaceCreated ? ' (created)' : ' (already there, left as it is)'}`);
  const workspaceOpen = options.dryRun ? null : openToOthers(workspace);
  if (workspaceOpen) log(`  Note: accounts other than yours may write into this folder (mode ${workspaceOpen}). It is used as it is.`);
  log('  The file tools read and write in this folder only, and the browser saves its screenshots');
  log('  and PDFs here. Keep nothing in it that the assistant should not read.');
  log('');

  // 5. Settings of the server, and the check.
  const node = nodeCommand();
  const entry = path.join(plan.versionDir, ...safeParts(release.entry));
  const record = {
    name: 'ToolsEngine', version: release.version, commit: release.commit, target: release.target, releaseSha256: release.sha256,
    installedAt: new Date().toISOString(), installedFrom: HERE, installRoot: plan.root, versionDir: plan.versionDir,
    node, entry, workspace: workspacePath, workspaceCreated,
    browser: { requested: browser.requested, id: null, path: null, args: ['--no-browser'] },
    headed: options.headed, desktop: options.desktop, desktopLeftHalf: options.desktopLeftHalf,
    serverName: options.name || 'toolsengine', serverArgs: [], check: null, registrations: [],
  };
  const settingsFor = candidate => serverArguments({ workspace: workspacePath, browserArgs: candidate ? candidate.args : ['--no-browser'],
    headed: options.headed, desktop: options.desktop, desktopLeftHalf: options.desktopLeftHalf, realProfile: plan.realProfile });
  const choose = candidate => {
    record.browser = { requested: browser.requested, id: candidate?.id ?? null, path: candidate?.path ?? null, args: candidate ? candidate.args : ['--no-browser'], ...(candidate?.notFound ? { notFound: true } : {}) };
    record.serverArgs = settingsFor(candidate);
  };
  choose(browser.tryInOrder[0]);

  if (options.check && !options.dryRun) {
    const picked = await pickBrowser(browser.tryInOrder, candidate => checkServer({ node, entry, serverArgs: argumentsForCheck(settingsFor(candidate)), workspace: workspacePath,
      expectedTools: expectedToolCount(release, { browser: Boolean(candidate), desktop: options.desktop }), browser: Boolean(candidate) }));
    choose(picked.chosen);
    record.check = picked.check;
    record.checkAttempts = picked.attempts.map(({ toolNames, ...rest }) => rest);
  }

  describeBrowser(log, record.browser, plan.versionDir, options.headed);
  for (const attempt of (record.checkAttempts || []).filter(item => item.candidate && item.candidate !== record.browser.id && item.browser === 'failed'))
    log(`  ${BROWSER_NAMES[attempt.candidate]} was found too, but did not start in the check (${attempt.browserProblem}).`);
  log('');
  if (process.platform === 'win32') {
    log('Windows desktop tools');
    if (options.desktop) {
      log(`  On, for this account (${plan.realProfile}). The assistant can read and operate the apps that are open`);
      log('  on this account, signed-in ones included. The four desktop tools are described in README.md.');
    } else log('  Off. They are added only when you install with --desktop.');
    log('');
  }

  log('Check');
  if (options.dryRun) log('  Not run in a dry run.');
  else if (!options.check) log('  Skipped (--no-check).');
  else {
    const check = record.check;
    if (!check.started) log(`  The installed server did not start: ${check.problem}`);
    else {
      log(`  The installed server started and answered in ${check.startSeconds} s: ${check.server}`);
      log(`  ${check.tools} tools offered (${check.expectedTools} expected)${check.tools === check.expectedTools ? '' : '  <-- not as expected'}`);
      if (check.problem) log(`  Problem: ${check.problem}`);
      if (check.browser === 'started') log(`  ${BROWSER_NAMES[record.browser.id]} started${options.headed ? ' (hidden, for this check)' : ''}, opened a blank page and closed (${check.browserSeconds} s).`);
      else if (check.browser === 'failed') log(`  The browser did not start: ${check.browserProblem}\n  The other tools work. The browser tools will fail until this is fixed.`);
    }
  }
  log('');

  // 6. Clients.
  const serverUsable = !record.check || record.check.ok;
  const printedOnly = () => CLIENTS.map(client => ({ client, name: record.serverName, status: 'printed', at: record.installedAt,
    removeCommand: displayCommand([path.basename(findOnPath(client) || client), ...clientCommands(client, record.serverName, []).remove]) }));
  const other = options.register.length ? otherHome() : null;
  log('Connect a client');
  const offerRegister = !otherHome();
  if (options.dryRun) printClientCommands(log, plan, record, { offerRegister });
  else if (other && serverUsable) {
    explainOtherHome(log, other);
    printClientCommands(log, plan, record, { offerRegister: false });
    record.registrations = printedOnly();
  } else if (options.register.length && serverUsable) {
    describeConfigVariables(log);
    record.registrations = registerClients(log, record, options.register, { replace: options.replace });
    const others = CLIENTS.filter(client => !options.register.includes(client));
    for (const client of others) {
      const found = findOnPath(client);
      log('');
      log(`  ${CLIENT_TITLES[client]}: not asked for. To connect it later:`);
      printCommand(log, [found ? path.basename(found) : client, ...clientCommands(client, record.serverName, [record.node, record.entry, ...record.serverArgs]).add]);
    }
  } else {
    if (options.register.length) log('  Not registered with any client, because the check above failed. The commands, for when it is fixed:');
    else log('  Not registered with any client (no --register). Run the command for each client you use:');
    printClientCommands(log, plan, record, { offerRegister });
    record.registrations = printedOnly();
  }
  log('');
  log('  A client reads its configuration when it starts: open a new session to see the tools.');
  log('');
  log('Uninstall');
  log(`  ${displayCommand([nodeWord(), path.join(plan.versionDir, 'install.mjs'), 'uninstall'])}`);
  log('');
  if (network.refused.length) log(`Network attempts refused by the installer: ${network.refused.join(', ')}`);
  else log('Network connections opened by the installer: none.');
  if (record.check?.browser === 'started' || record.check?.browser === 'failed')
    log('(The browser started for the check is a program of its own. Like every start of that browser,\n it may contact its maker\'s servers by itself; --no-check installs without starting it.)');

  if (!options.dryRun) {
    const { toolNames, ...checkRecord } = record.check || {};
    // Only now is the install finished: "state" tells a finished one from one
    // that was interrupted after its files were in place.
    writeRecord(path.join(plan.versionDir, 'installation.json'), JSON.stringify({ ...record, state: 'installed', check: record.check ? checkRecord : null }, null, 2) + '\n');
  }
  // What was asked for and not done counts as not finished.
  const failedRegistration = notDone(record.registrations, { replace: options.replace }) || Boolean(other);
  return !serverUsable || (record.check && record.check.browser === 'failed') || failedRegistration ? 2 : 0;
}

// ---------------------------------------------------------------------------
// Commands on an installed version

// What a version folder holds: a finished install; one that was started and
// not finished (its files are in place but there is no record yet, or the
// record still says "installing"); or something this installer did not make.
function installedState(directory) {
  let release;
  try { release = readRelease(directory); } catch { return { state: 'foreign' }; }
  let record = null;
  try { record = JSON.parse(readRecord(path.join(directory, 'installation.json'))); } catch (error) { if (error.code !== 'ENOENT') throw new Stop('The installation record could not be safely read. Nothing was changed.'); }
  if (record && (record.name !== 'ToolsEngine' || record.version !== release.version)) return { state: 'foreign' };
  return { state: record && record.state !== 'installing' ? 'installed' : 'unfinished', release, record };
}

// The installed version a command is about. An install that was not finished
// is only handed out to the one command that clears it away.
function readInstalled(options, { unfinishedToo = false } = {}) {
  const here = fs.existsSync(path.join(HERE, 'release.json')) ? readRelease(HERE) : null;
  const plan = resolvePlan(options, here || { version: options.version });
  if (!plan.version) throw new Stop('Name the version: --version VERSION');
  const file = path.join(plan.versionDir, 'installation.json');
  const found = fs.existsSync(plan.versionDir) ? installedState(plan.versionDir) : { state: 'foreign' };
  if (found.state === 'foreign' || found.release.version !== plan.version)
    throw new Stop(`ToolsEngine ${plan.version} is not installed in ${plan.root}.\nRun "node install.mjs list${options.installRoot ? ` --install-root ${options.installRoot}` : ''}" to see what is.`);
  if (found.state === 'unfinished' && !unfinishedToo)
    throw new Stop(`The install of ToolsEngine ${plan.version} in ${plan.versionDir} was not finished.\n  To finish it, run the installer from the extracted archive again.\n  To remove it:  ${displayCommand([nodeWord(), SELF, 'uninstall', ...(options.home ? ['--home', options.home] : []), ...(options.installRoot ? ['--install-root', options.installRoot] : [])])}`);
  const record = found.record || { name: 'ToolsEngine', version: plan.version, state: 'installing', workspace: null, serverName: 'toolsengine', registrations: [] };
  // The folder may have been moved since: trust where it is now.
  record.versionDir = plan.versionDir;
  record.entry = path.join(plan.versionDir, ...safeParts(found.release.entry));
  return { plan, record, file, unfinished: found.state === 'unfinished' };
}

function installedVersions(root) {
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  const found = [];
  for (const name of names.sort()) {
    const state = installedState(path.join(root, name));
    if (state.state === 'foreign' || state.release.version !== name) continue;
    found.push(state.state === 'installed' ? state.record : { ...(state.record || {}), version: name, commit: state.release.commit, unfinished: true });
  }
  return found;
}

function list(options, log) {
  const plan = resolvePlan(options, { version: null });
  const versions = installedVersions(plan.root);
  log(`Installed versions in ${plan.root}`);
  if (!versions.length) { log('  none'); return 0; }
  for (const record of versions) {
    log('');
    if (record.unfinished) {
      log(`  ${record.version}   install not finished   source ${String(record.commit).slice(0, 7)}`);
      log('    Run the installer from the extracted archive again to finish it, or uninstall it.');
      continue;
    }
    log(`  ${record.version}   installed ${record.installedAt}   source ${String(record.commit).slice(0, 7)}`);
    log(`    workspace  ${record.workspace}`);
    log(`    browser    ${record.browser?.id ? BROWSER_NAMES[record.browser.id] : 'none'}${record.headed ? ' (in a window)' : ''}${record.desktop ? '   desktop tools on' : ''}`);
    for (const item of record.registrations || []) log(`    ${CLIENT_TITLES[item.client] || item.client}: ${describeRegistration(item)}`);
  }
  return 0;
}

// A registration that was asked for and did not happen. With --replace that
// includes an earlier entry that was left in place: the person asked for it
// to be replaced, and it was not.
function notDone(registrations, { replace = false } = {}) {
  return registrations.some(item => item.status === 'failed' || item.status === 'client-not-found' || item.status === 'not-run' || (replace && item.status === 'kept-existing'));
}

function describeRegistration(item) {
  return item.status === 'registered' ? `registered as "${item.name}" by the installer`
    : item.status === 'printed' ? `command printed for "${item.name}"; the installer does not know whether you ran it`
    : item.status === 'not-run' ? `not run: ${item.variable} pointed outside your profile; the command for "${item.name}" was printed`
    : item.status === 'kept-existing' ? `an earlier "${item.name}" registration was left in place`
    : item.status === 'client-not-found' ? 'client not found, not registered'
    : 'registration failed';
}

function register(options, log) {
  const { plan, record, file } = readInstalled(options);
  log(`ToolsEngine ${record.version} in ${plan.versionDir}`);
  log('');
  log('Connect a client');
  const other = otherHome();
  if (other) {
    explainOtherHome(log, other);
    for (const client of options.register) {
      const found = findOnPath(client);
      log('');
      log(`  ${CLIENT_TITLES[client]}:`);
      printCommand(log, [found ? path.basename(found) : client, ...clientCommands(client, options.name || record.serverName, [record.node, record.entry, ...record.serverArgs]).add]);
    }
    return 2;
  }
  describeConfigVariables(log);
  const results = registerClients(log, { ...record, serverName: options.name || record.serverName }, options.register, { replace: options.replace });
  record.registrations = [...(record.registrations || []).filter(item => !results.some(result => result.client === item.client && result.name === item.name)), ...results];
  writeRecord(file, JSON.stringify(record, null, 2) + '\n');
  log('');
  log('  A client reads its configuration when it starts: open a new session to see the tools.');
  return notDone(results, { replace: options.replace }) ? 2 : 0;
}

async function check(options, log) {
  const { plan, record } = readInstalled(options);
  const release = readRelease(plan.versionDir);
  log(`ToolsEngine ${record.version} in ${plan.versionDir}`);
  const problems = compareWithRelease(release, plan.versionDir);
  log(problems.length ? `  Files: ${problems.length} differ from release.json:` : `  Files: all ${release.files.length.toLocaleString('en-US')} are present and unchanged.`);
  for (const problem of problems.slice(0, 20)) log(`    ${problem}`);
  const report = await checkServer({ node: record.node, entry: record.entry, serverArgs: argumentsForCheck(record.serverArgs), workspace: record.workspace,
    expectedTools: expectedToolCount(release, { browser: Boolean(record.browser?.id), desktop: record.desktop }), browser: Boolean(record.browser?.id) });
  if (!report.started) log(`  The server did not start: ${report.problem}`);
  else {
    log(`  The server started and answered in ${report.startSeconds} s: ${report.server}`);
    log(`  ${report.tools} tools offered (${report.expectedTools} expected)`);
    if (report.problem) log(`  Problem: ${report.problem}`);
    if (report.browser === 'started') log(`  ${BROWSER_NAMES[record.browser.id]} started, opened a blank page and closed (${report.browserSeconds} s).`);
    else if (report.browser === 'failed') log(`  The browser did not start: ${report.browserProblem}`);
    else log('  Browser: off for this installation.');
  }
  return !problems.length && report.ok && report.browser !== 'failed' ? 0 : 2;
}

// Remove one installed version: exactly the files the installer put there.
// Anything else found in the folder is left and named. The workspace and the
// clients' configurations are not touched.
function uninstall(options, log) {
  // An install that was interrupted is removed like a finished one.
  const { plan, record, unfinished } = readInstalled(options, { unfinishedToo: true });
  const directory = plan.versionDir;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Stop(`${directory} is a link, not the installed folder. Nothing was removed.`);
  const release = readRelease(directory);
  if (release.version !== record.version) throw new Stop(`${directory} holds release ${release.version}, not ${record.version}. Nothing was removed.`);
  // release.json is the list of what to remove. It must be the list that was
  // installed: the record made at install time holds its SHA-256.
  const recorded = typeof record.releaseSha256 === 'string' && record.releaseSha256 ? record.releaseSha256 : null;
  if (recorded && release.sha256 !== recorded)
    throw new Stop(`release.json in ${directory} is not the one that was installed: it was changed afterwards.\nThe installer removes only the files that list names, so nothing was removed. If you are sure of what the folder holds, delete it yourself.`);
  if (!recorded) {
    // No record says which list was installed here: an install that was
    // interrupted before its record was written, or a record that was taken
    // away. The list in the folder then has nothing to vouch for it, and
    // taking the record away must not be a way around the check above. The
    // list is accepted only when it is the one of the archive this installer
    // runs from, and when every file in the folder is what that list says.
    const own = samePath(realPlace(HERE), realPlace(directory)) || !fs.existsSync(path.join(HERE, 'release.json')) ? null : readRelease(HERE);
    const byHand = 'Nothing was removed. If you are sure of what the folder holds, delete it yourself.';
    if (!own)
      throw new Stop(`${directory} holds no record of its install, so the list of files in it cannot be checked against what was installed.\nRun the uninstall from the folder the archive of ToolsEngine ${release.version} was extracted to: its list is then the one that counts.\n${byHand}`);
    if (own.sha256 !== release.sha256)
      throw new Stop(`${directory} holds no record of its install, and its release.json is not the one of this archive.\n${byHand}`);
    const differences = compareWithRelease(release, directory);
    if (differences.length)
      throw new Stop(`${directory} holds no record of its install, and ${differences.length} of its files are missing or are not what this archive holds (${differences.slice(0, 3).join('; ')}).\n${byHand}`);
  }
  log(`Removing ${unfinished ? 'the unfinished install of ' : ''}ToolsEngine ${record.version} from ${directory}`);
  if (options.dryRun) { log('Dry run: nothing is changed.'); }
  else {
    // Windows cannot remove a folder that is some program's current folder.
    if (isInside(process.cwd(), directory)) process.chdir(plan.root);
    // A real folder, as opposed to a link or a junction to one. Nothing is
    // removed through a link: what it points to was not put there by the
    // installer, whatever names it holds.
    const realFolder = folder => { try { return fs.lstatSync(folder).isDirectory(); } catch { return false; } };
    const directories = new Set();
    const links = new Set();
    for (const name of [...release.files.map(entry => entry.path), 'release.json', 'installation.json', 'install-log.txt']) {
      const parts = safeParts(name);
      let through = directory;
      let linked = null;
      for (let depth = 1; depth < parts.length && !linked; depth++) {
        through = path.join(through, parts[depth - 1]);
        if (fs.existsSync(through) && !realFolder(through)) linked = through;
        else directories.add(parts.slice(0, depth).join('/'));
      }
      if (linked) { links.add(linked); continue; }
      const target = path.join(directory, ...parts);
      try { if (fs.lstatSync(target).isFile()) fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const name of [...directories].sort((a, b) => b.length - a.length)) {
      const folder = path.join(directory, ...name.split('/'));
      if (realFolder(folder)) try { fs.rmdirSync(folder); } catch { /* not empty: something else is in it */ }
    }
    let left = [];
    try { fs.rmdirSync(directory); }
    catch {
      // What is still there. Only real folders are looked into: a link or a
      // junction is named as one item and never followed, so nothing of what
      // it points to is read, counted or printed.
      const look = (folder, prefix) => {
        let names = [];
        try { names = fs.readdirSync(folder); } catch { unexpected.push(`${prefix || '.'}: unreadable`); return; }
        for (const name of names.sort()) {
          const item = path.join(folder, name);
          if (realFolder(item)) look(item, path.join(prefix, name));
          else left.push(path.join(prefix, name));
        }
      };
      look(directory, '');
    }
    // The links that stood where a folder of the install belongs are named on their own.
    const linked = new Set([...links].map(link => path.relative(directory, link)));
    left = left.filter(name => !linked.has(name));
    if (links.size) {
      log(`  ${links.size} item(s) in the folder are links, not folders of the install. Nothing was removed through them:`);
      for (const link of [...links].slice(0, 10)) log(`    ${link}`);
    }
    if (left.length) {
      log(`  The installed files are removed. ${left.length} other item(s) that the installer did not put there were left in place:`);
      for (const name of left.slice(0, 10)) log(`    ${path.join(directory, String(name))}`);
    } else if (links.size) {
      log('  The installed files are removed. The folder stays, because the links are still in it.');
    } else if (fs.existsSync(directory)) {
      // Windows does not remove a folder that some program is standing in.
      log('  The installed files are removed. The folder itself, now empty, is still there because a program is');
      log('  using it as its current folder (often the terminal this was run from). Leave that folder and delete it:');
      log(`    ${directory}`);
    } else log('  Removed.');
  }
  log('');
  if (record.workspace) {
    log(`Not removed: the workspace ${record.workspace}`);
    log('  It holds your files. Delete it yourself when you no longer need it.');
  }
  const others = installedVersions(plan.root).filter(item => item.version !== record.version);
  if (others.length) log(`Still installed: ${others.map(item => item.version).join(', ')}`);
  if (unfinished) {
    log('That install was not finished, so it registered no client.');
    return 0;
  }
  log('');
  log('Client registrations are not removed by the installer. If one still points to this version,');
  log('remove it with the client\'s own command:');
  for (const client of CLIENTS) {
    const found = findOnPath(client);
    const shown = found ? path.basename(found) : client;
    const known = (record.registrations || []).filter(entry => entry.client === client && ['registered', 'printed', 'kept-existing', 'not-run'].includes(entry.status));
    const items = known.length ? known : [{ name: record.serverName, status: 'none' }];
    for (const item of items) {
      const commands = clientCommands(client, item.name, []);
      log('');
      log(`  ${CLIENT_TITLES[client]}: ${item.status === 'none' ? `the installer did not register "${item.name}" here; you may have done it by hand` : describeRegistration(item)}.`);
      log(`    to see it:     ${displayCommand([shown, ...commands.show])}`);
      log(`    to remove it:  ${displayCommand([shown, ...commands.remove])}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------

export async function main(argv) {
  const log = makeLog();
  try {
    const options = parseArgs(argv);
    if (options.help) { process.stdout.write(USAGE); return 0; }
    switchOffNetwork();
    if (options.command === 'install') return await install(options, log);
    if (options.command === 'register') return register(options, log);
    if (options.command === 'check') return await check(options, log);
    if (options.command === 'list') return list(options, log);
    if (options.command === 'uninstall') return uninstall(options, log);
    return 1;
  } catch (error) {
    if (error instanceof Stop) { log(''); log(`Stopped: ${error.message}`); return 1; }
    log('');
    log(`The installer failed: ${error.stack || error}`);
    return 1;
  }
}

const startedDirectly = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; }
})();
if (startedDirectly) process.exitCode = await main(process.argv.slice(2));
