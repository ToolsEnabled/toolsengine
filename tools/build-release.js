// Build the release archives: one file per system, installable with no network.
//
//   npm run build:release [-- --out DIR] [--offline] [--cache DIR] [--allow-dirty] [--test-log FILE]
//
// What it does, in order:
//   0. runs the whole test suite and stops unless every test passes and the
//      browser tests ran (on a machine where Playwright's own Chromium
//      cannot set up its sandbox, set TOOLSENGINE_TEST_BROWSER to an
//      installed Chrome or Edge);
//   1. packs the package exactly as "npm pack" does (the audited file list);
//   2. installs the production dependencies from npm-shrinkwrap.json with
//      "npm ci --ignore-scripts", so npm checks every tarball against the
//      integrity value recorded in the lockfile;
//   3. checks that the installed tree is the lockfile's tree, no more, no less;
//   4. writes THIRD-PARTY-NOTICES.txt from the lockfile: every bundled package
//      with the licence it declares and the licence and notice files it ships;
//   5. adds the installer, a launcher for the system and INSTALL.txt;
//   6. writes release.json with the size and SHA-256 of every file;
//   7. installs the result once into a throwaway folder, starts it, removes it;
//   8. makes a .tar.gz for Linux and a .zip for Windows, with fixed dates and
//      order so that the same source gives the same archive.
//
// Linux only: "npm pack" on Windows writes an archive whose command file is
// not executable, and the zip and tar programs used here are the Linux ones.
// The network is used in step 2 only, and only when the npm cache does not
// already hold the tarballs. Nothing in the archives needs it afterwards.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { compareWithRelease } from '../installer/install.mjs';
import { comparePacked } from './package-files.js';
import { judgeTestRun, runTests } from './test-gate.js';

const PORTABLE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGETS = Object.freeze([
  { id: 'linux-x64', system: 'Linux', archive: 'tar.gz', launcher: 'install.sh' },
  { id: 'windows-x64', system: 'Windows', archive: 'zip', launcher: 'install.cmd' },
]);
const LICENCE_FILE = /^(?:licen[sc]e|copying|notice|third[-_ ]?party[-_ ]?notices?|patents)(?:[-._].*)?$/i;
const LICENCE_TEXT = /^(?:licen[sc]e|copying)/i;

const sha256 = data => createHash('sha256').update(data).digest('hex');
const read = file => fs.readFileSync(file, 'utf8');
const readJson = file => JSON.parse(read(file));

function walk(directory, visit, base = directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const stat = fs.lstatSync(full);
    const relative = path.relative(base, full).split(path.sep).join('/');
    visit({ full, relative, name, stat });
    if (stat.isDirectory()) walk(full, visit, base);
  }
}

// Every package directory under node_modules, as lockfile keys.
function installedPackages(appDir) {
  const found = [];
  const scan = (modules, prefix) => {
    for (const name of fs.readdirSync(modules)) {
      if (name.startsWith('.')) continue;
      const here = path.join(modules, name);
      if (name.startsWith('@')) { for (const scoped of fs.readdirSync(here)) add(path.join(here, scoped), `${prefix}/${name}/${scoped}`); }
      else add(here, `${prefix}/${name}`);
    }
  };
  const add = (directory, key) => {
    found.push(key);
    const nested = path.join(directory, 'node_modules');
    if (fs.existsSync(nested)) scan(nested, `${key}/node_modules`);
  };
  scan(path.join(appDir, 'node_modules'), 'node_modules');
  return found.sort();
}

// The list of bundled packages, from the lockfile, each checked against what
// is installed, with the text of its licence and notice files.
export function collectNotices(lock, appDir) {
  const rows = [];
  for (const key of Object.keys(lock.packages).filter(Boolean).sort()) {
    const entry = lock.packages[key];
    assert.ok(!entry.dev, `${key}: a development dependency must not be bundled`);
    const directory = path.join(appDir, key);
    const manifest = readJson(path.join(directory, 'package.json'));
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    assert.equal(manifest.name, name, `${key}: installed package has another name`);
    assert.equal(manifest.version, entry.version, `${key}: installed version differs from the lockfile`);
    const declared = typeof manifest.license === 'string' ? manifest.license : null;
    assert.ok(declared, `${key}: the package declares no licence`);
    if (entry.license !== undefined) assert.equal(entry.license, declared, `${key}: lockfile and package disagree about the licence`);
    const files = fs.readdirSync(directory).filter(file => LICENCE_FILE.test(file) && fs.lstatSync(path.join(directory, file)).isFile()).sort();
    assert.ok(files.some(file => LICENCE_TEXT.test(file)), `${key}: no licence text ships with the package; add it by hand before bundling`);
    rows.push({ key, name, version: entry.version, licence: declared, resolved: entry.resolved || null, integrity: entry.integrity || null,
      files: files.map(file => ({ file, text: read(path.join(directory, file)).replace(/\r\n?/g, '\n').replace(/\s+$/, '') })) });
  }
  return rows;
}

export function renderNotices(rows, { version }) {
  const counts = {};
  for (const row of rows) counts[row.licence] = (counts[row.licence] || 0) + 1;
  const summary = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([licence, count]) => `${licence}: ${count}`).join('; ');
  const width = Math.max(...rows.map(row => `${row.name}@${row.version}`.length));
  const lines = [
    'THIRD-PARTY NOTICES',
    '',
    `ToolsEngine ${version} is distributed in this archive together with the third-party`,
    'packages it needs to run. ToolsEngine itself is under the MIT licence: see LICENSE',
    'and NOTICE beside this file.',
    '',
    'The packages listed here are unmodified copies from the npm registry. They are in',
    'app/node_modules, each with its own licence file in place. This file was generated',
    'from app/npm-shrinkwrap.json: it lists every package named there, the licence each',
    'one declares, and the full text of the licence and notice files each one ships.',
    '',
    'No web browser is part of this archive.',
    '',
    `${rows.length} packages. ${summary}.`,
    '',
    'PACKAGES',
    '',
    ...rows.map(row => `  ${`${row.name}@${row.version}`.padEnd(width)}  ${row.licence.padEnd(12)}  app/${row.key}`),
    '',
    'LICENCE AND NOTICE TEXTS',
  ];
  for (const row of rows) {
    lines.push('', '='.repeat(80), `${row.name}@${row.version}`, `Licence: ${row.licence}`, `In this archive: app/${row.key}`);
    if (row.resolved) lines.push(`From: ${row.resolved}`);
    for (const { file, text } of row.files) lines.push('-'.repeat(80), `[${file}]`, '', text);
  }
  return { text: lines.join('\n') + '\n', counts };
}

function launcher(target) {
  if (target.launcher === 'install.sh') return [
    '#!/bin/sh',
    '# ToolsEngine: starts the installer (install.mjs, beside this file) with Node.js.',
    '# All options are passed on. See INSTALL.txt.',
    'here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd) || exit 1',
    'if ! command -v node >/dev/null 2>&1; then',
    '  echo "ToolsEngine needs Node.js 22.14 or newer, and no \\"node\\" command was found." >&2',
    '  echo "Install Node.js (https://nodejs.org or your package manager), open a new terminal and run this again." >&2',
    '  exit 1',
    'fi',
    `if ! node -e 'var v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=14)?0:1)'; then`,
    '  echo "ToolsEngine needs Node.js 22.14 or newer. This machine has $(node --version)." >&2',
    '  exit 1',
    'fi',
    'exec node "$here/install.mjs" "$@"',
    '',
  ].join('\n');
  return [
    '@echo off',
    'rem ToolsEngine: starts the installer (install.mjs, beside this file) with Node.js.',
    'rem All options are passed on. See INSTALL.txt.',
    'setlocal',
    'where node >nul 2>nul',
    'if errorlevel 1 (',
    '  echo ToolsEngine needs Node.js 22.14 or newer, and no node command was found.',
    '  echo Install Node.js from https://nodejs.org, open a new terminal and run this again.',
    '  exit /b 1',
    ')',
    `node -e "var v=process.versions.node.split('.').map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=14)?0:1)"`,
    'if errorlevel 1 (',
    '  echo ToolsEngine needs Node.js 22.14 or newer. This machine has:',
    '  node --version',
    '  exit /b 1',
    ')',
    'node "%~dp0install.mjs" %*',
    'exit /b %errorlevel%',
    '',
  ].join('\r\n');
}

function installText(target, release) {
  const windows = target.system === 'Windows';
  const run = windows ? 'install.cmd' : './install.sh';
  const home = windows ? 'C:\\Users\\YOU\\ToolsEngine' : '~/ToolsEngine';
  const sep = windows ? '\\' : '/';
  const lines = [
    `ToolsEngine ${release.version} for ${target.system}`,
    '',
    'An MCP server that gives an AI assistant a browser, a folder of files to work in',
    `and a reader for public web pages${windows ? ', and, only if you turn it on, the Windows desktop' : ''}.`,
    '',
    'WHAT YOU NEED',
    '',
    '  Node.js 22.14 or newer. Check with:   node --version',
    '  Nothing else. Nothing is downloaded: everything ToolsEngine needs is in this folder.',
    '  For the browser tools: Google Chrome or Microsoft Edge on this machine.',
    '',
    'INSTALL',
    '',
    `  Open a terminal in this folder and run:`,
    '',
    `      ${run}`,
    '',
    '  It copies the program to',
    `      ${home}${sep}${release.version}`,
    '  creates an empty workspace folder',
    `      ${home}${sep}workspace`,
    '  starts the installed server once to check it, and prints the command that',
    '  connects it to Claude Code and the one for Codex.',
    '',
    '  To have the installer connect the clients for you:',
    '',
    `      ${run} --register claude codex`,
    '',
    '  (name one or both; each client must already be installed).',
    '',
    'OPTIONS',
    '',
    '  --workspace DIR      another folder for the assistant to work in',
    '  --browser CHOICE     chrome, msedge, none, or the full path of a browser',
    '  --headed             let the browser open in a window you can see',
    ...(windows ? ['  --desktop            turn on the Windows desktop tools (off by default)'] : []),
    '  --replace            with --register: replace an existing "toolsengine" registration',
    '  --dry-run            show what would be done, change nothing',
    `  ${run} --help${' '.repeat(Math.max(1, 16 - run.length))}the full list`,
    '',
    'AFTERWARDS',
    '',
    '  This folder and the archive are no longer needed once the install has finished.',
    '  The installed copy holds its own installer:',
    '',
    `      node ${home}${sep}${release.version}${sep}install.mjs check        test the installed server`,
    `      node ${home}${sep}${release.version}${sep}install.mjs register claude codex`,
    `      node ${home}${sep}${release.version}${sep}install.mjs uninstall    remove this version`,
    '',
    '  Uninstall removes the program folder of this version. It keeps the workspace and',
    '  prints the command that removes the registration from each client.',
    '',
    'IN THIS FOLDER',
    '',
    `  ${target.launcher.padEnd(26)}starts install.mjs with Node.js`,
    '  install.mjs               the installer',
    '  app/                      ToolsEngine and the packages it needs (app/README.md is the manual)',
    '  release.json              every file with its size and SHA-256',
    '  LICENSE, NOTICE           ToolsEngine licence (MIT) and notices',
    '  THIRD-PARTY-NOTICES.txt   the bundled packages and their licence texts',
    '',
  ];
  return lines.join(windows ? '\r\n' : '\n');
}

function git(...args) { return execFileSync('git', args, { cwd: PORTABLE, encoding: 'utf8' }).trim(); }

export function validateTestLog(file, packageFolder) {
  const parent = fs.realpathSync(path.dirname(file));
  const destination = path.join(parent, path.basename(file));
  const relative = path.relative(fs.realpathSync(packageFolder), destination);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) throw new Error('The test log must be outside the tested package tree.');
  if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.nlink !== 1) throw new Error('The test log must be a plain, singly linked file.'); }
  return destination;
}

export function testedTree(packageFolder) {
  const result = {};
  for (const name of ['bin','src','native','docs','tests','tools','installer','node_modules','package.json','npm-shrinkwrap.json','README.md','LICENSE','NOTICE']) {
    const full = path.join(packageFolder, name);
    if (!fs.existsSync(full)) continue;
    const scan = (file, relative) => {
      if (relative.split('/').includes('.bin') || relative === 'node_modules/.package-lock.json') return;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { for (const child of fs.readdirSync(file).sort()) scan(path.join(file,child), `${relative}/${child}`); }
      else { assert.ok(stat.isFile() && stat.nlink === 1, `Unverifiable tested file: ${relative}`); result[relative] = sha256(fs.readFileSync(file)); }
    };
    scan(full, name);
  }
  return result;
}
export function assertTestedTree(packageFolder, snapshot) {
  assert.deepEqual(testedTree(packageFolder), snapshot, 'The sources or dependencies changed after their test snapshot. Nothing may be packed.');
}
export function assertPackedBytes(file, relative, snapshot) {
  assert.equal(sha256(fs.readFileSync(file)), snapshot[relative], `Packed file differs from the tested bytes: ${relative}`);
}

function parseOptions(argv) {
  const options = { out: path.resolve(PORTABLE, '..', 'dist'), offline: false, cache: null, allowDirty: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') options.out = path.resolve(argv[++i]);
    else if (argv[i] === '--cache') options.cache = path.resolve(argv[++i]);
    else if (argv[i] === '--offline') options.offline = true;
    else if (argv[i] === '--allow-dirty') options.allowDirty = true;
    else if (argv[i] === '--test-log') options.testLog = path.resolve(argv[++i]);
    else throw new Error(`Unknown option: ${argv[i]}`);
  }
  return options;
}

async function build() {
  if (process.platform !== 'linux') throw new Error('Build the release on Linux. On Windows "npm pack" writes an archive whose command file is not executable.');
  if (!process.env.npm_execpath) throw new Error('Run with: npm run build:release');
  const options = parseOptions(process.argv.slice(2));
  if (options.testLog) options.testLog = validateTestLog(options.testLog, PORTABLE);
  const outputRelative = path.relative(PORTABLE, options.out);
  if (!outputRelative.startsWith('..') && !path.isAbsolute(outputRelative)) throw new Error('Release output must be outside the tested package tree.');
  // The npm started here must act on the folder it is given, not on the
  // project whose script is running: its inherited npm_* settings are dropped.
  const plainEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name)));
  const npm = (args, cwd) => execFileSync(process.execPath, [process.env.npm_execpath, ...args], { cwd, env: plainEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });

  const pkg = readJson(path.join(PORTABLE, 'package.json'));
  const lockText = read(path.join(PORTABLE, 'npm-shrinkwrap.json'));
  const lock = JSON.parse(lockText);
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--', '.');
  if (dirty && !options.allowDirty) throw new Error(`Commit first: the release records one commit, and these files differ from it:\n${dirty}`);
  const commitTime = Number(git('log', '-1', '--format=%ct'));
  const builtAt = new Date(commitTime * 1000).toISOString();

  // 0. The tests. Nothing is built from a tree whose tests fail, or whose
  //    browser tests did not run on this machine. There is no option to
  //    leave this step out.
  console.error('Running the tests before building (this takes a few minutes)...');
  const snapshot = testedTree(PORTABLE);
  const tested = runTests(PORTABLE);
  assertTestedTree(PORTABLE, snapshot);
  const verdict = judgeTestRun(tested);
  if (options.testLog) fs.writeFileSync(options.testLog, tested.output);
  if (!verdict.ok) throw new Error(`Not built: ${verdict.reason}\nAn archive is built only from a tree whose tests all pass, the browser tests included. Run "npm test" to see the whole result.`);
  console.error(`Tests: ${verdict.counts.tests}, ${verdict.counts.pass} pass, ${verdict.counts.fail} fail, ${verdict.counts.skipped} skipped for the system they are on.`);

  const stage = path.join(options.out, '.stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });

  // 1. The package, as npm packs it.
  const packed = JSON.parse(npm(['pack', '--json', '--ignore-scripts', '--logs-max=0', '--no-update-notifier', '--pack-destination', stage], PORTABLE))[0];
  assert.ok(packed.files.find(file => file.path === 'bin/toolsengine.js').mode & 0o111, 'bin/toolsengine.js must be executable in the package');
  fs.mkdirSync(path.join(stage, 'unpack'));
  execFileSync('tar', ['-xzf', path.join(stage, packed.filename), '-C', path.join(stage, 'unpack')]);
  const common = path.join(stage, 'common');
  fs.mkdirSync(common);
  const app = path.join(common, 'app');
  fs.renameSync(path.join(stage, 'unpack', 'package'), app);
  const packedFiles = packed.files.map(file => file.path).sort();
  // Exactly the audited files: npm packs whole folders, ignored files included,
  // so a file left in src, docs, native or bin would otherwise be shipped.
  assert.deepEqual(comparePacked(packedFiles), { unexpected: [], missing: [] }, 'npm pack lists other files than the files of the package (tools/package-files.js). Nothing was built');

  for (const relative of packedFiles) assertPackedBytes(path.join(app, relative), relative, snapshot);

  // 2. Production dependencies from the lockfile, integrity-checked by npm.
  npm(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--no-progress', '--loglevel=error', '--logs-max=0', '--no-update-notifier',
    ...(options.offline ? ['--offline'] : []), ...(options.cache ? ['--cache', options.cache] : [])], app);
  assert.equal(read(path.join(app, 'npm-shrinkwrap.json')), lockText, 'npm ci changed the lockfile');

  for (const [relative] of Object.entries(snapshot).filter(([name]) => name.startsWith('node_modules/'))) assertPackedBytes(path.join(app, relative), relative, snapshot);
  assertTestedTree(PORTABLE, snapshot);

  // 3. The tree is the lockfile's tree.
  const expected = Object.keys(lock.packages).filter(Boolean).sort();
  assert.deepEqual(installedPackages(app), expected, 'The installed packages are not exactly the packages of npm-shrinkwrap.json');
  // Command links are not used by the server and cannot go into a zip.
  const commandLinks = [];
  walk(app, ({ full, name, stat }) => { if (stat.isDirectory() && name === '.bin' && path.basename(path.dirname(full)) === 'node_modules') commandLinks.push(full); });
  for (const directory of commandLinks) fs.rmSync(directory, { recursive: true });
  walk(common, ({ relative, stat }) => { assert.ok(stat.isFile() || stat.isDirectory(), `Not a plain file or folder: ${relative}`); });

  // 4. Notices.
  const rows = collectNotices(lock, app);
  assert.equal(rows.length, expected.length);
  const notices = renderNotices(rows, { version: pkg.version });
  fs.writeFileSync(path.join(common, 'THIRD-PARTY-NOTICES.txt'), notices.text);

  // 5. Installer and the package's own licence files at the top.
  fs.copyFileSync(path.join(PORTABLE, 'installer', 'install.mjs'), path.join(common, 'install.mjs'));
  assertPackedBytes(path.join(common, 'install.mjs'), 'installer/install.mjs', snapshot);
  for (const name of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(app, name), path.join(common, name));

  const catalogue = readJson(path.join(app, 'docs', 'tool-catalogue.json'));
  const desktopCatalogue = readJson(path.join(app, 'docs', 'desktop-catalogue.json'));
  const browsers = readJson(path.join(app, 'node_modules', 'playwright-core', 'browsers.json')).browsers;
  const playwrightVersion = readJson(path.join(app, 'node_modules', 'playwright-core', 'package.json')).version;

  fs.mkdirSync(options.out, { recursive: true });
  const results = [];
  for (const target of TARGETS) {
    const folderName = `toolsengine-${pkg.version}-${target.id}`;
    const folder = path.join(stage, folderName);
    fs.cpSync(common, folder, { recursive: true });
    const release = {
      name: 'ToolsEngine', package: pkg.name, version: pkg.version, commit, builtAt, target: target.id,
      node: pkg.engines.node, entry: 'app/bin/toolsengine.js',
      tools: { core: catalogue.count, withoutBrowser: catalogue.tools.filter(tool => !tool.name.startsWith('browser.')).length, windowsDesktop: desktopCatalogue.tools.length },
      browser: { bundled: false, playwright: playwrightVersion, chromiumRevision: browsers.find(browser => browser.name === 'chromium').revision },
      bundled: { packages: rows.length, licences: notices.counts, packageFiles: packedFiles.length },
      files: [],
    };
    fs.writeFileSync(path.join(folder, target.launcher), launcher(target));
    fs.writeFileSync(path.join(folder, 'INSTALL.txt'), installText(target, release));

    // 6. Fixed modes and dates, then the list of files.
    const executable = new Set(['app/bin/toolsengine.js', 'install.sh']);
    let bytes = 0;
    let longest = 0;
    walk(folder, ({ full, relative, stat }) => {
      if (stat.isDirectory()) { fs.chmodSync(full, 0o755); return; }
      const mode = executable.has(relative) ? '755' : '644';
      fs.chmodSync(full, Number.parseInt(mode, 8));
      const data = fs.readFileSync(full);
      bytes += data.length;
      longest = Math.max(longest, relative.length);
      release.files.push({ path: relative, size: data.length, sha256: sha256(data), mode });
    });
    // One line per file keeps the list readable and much smaller.
    const { files, ...head } = release;
    fs.writeFileSync(path.join(folder, 'release.json'),
      `${JSON.stringify(head, null, 1).slice(0, -2)},\n "files": [\n${files.map(file => `  ${JSON.stringify(file)}`).join(',\n')}\n ]\n}\n`);
    fs.chmodSync(path.join(folder, 'release.json'), 0o644);
    walk(folder, ({ full }) => fs.utimesSync(full, commitTime, commitTime));
    fs.chmodSync(folder, 0o755);
    fs.utimesSync(folder, commitTime, commitTime);

    // 7. Install it once, start it, remove it. No browser: this is a check of
    //    the bundle, not of the build machine's browser.
    if (target.id === 'linux-x64') {
      const home = path.join(stage, 'smoke-home');
      const run = args => spawnSync(process.execPath, [path.join(folder, 'install.mjs'), ...args], { encoding: 'utf8' });
      const installed = run(['--home', home, '--browser', 'none']);
      assert.equal(installed.status, 0, `The bundle does not install and start:\n${installed.stdout}${installed.stderr}`);
      assert.match(installed.stdout, new RegExp(`${release.tools.withoutBrowser} tools offered \\(${release.tools.withoutBrowser} expected\\)`));
      const removed = spawnSync(process.execPath, [path.join(home, 'ToolsEngine', release.version, 'install.mjs'), 'uninstall'], { encoding: 'utf8' });
      assert.equal(removed.status, 0, removed.stdout + removed.stderr);
      assert.ok(!fs.existsSync(path.join(home, 'ToolsEngine', release.version)), 'Uninstall left the version folder');
      fs.rmSync(home, { recursive: true, force: true });
      // The test must leave the bundle as it was.
      assert.deepEqual(compareWithRelease(release, folder), []);
    }

    // 8. The archive.
    const archive = path.join(options.out, `${folderName}.${target.archive}`);
    fs.rmSync(archive, { force: true });
    const names = [];
    walk(folder, ({ relative, stat }) => { if (stat.isFile()) names.push(`${folderName}/${relative}`); });
    names.sort();
    if (target.archive === 'tar.gz') {
      const tar = archive.slice(0, -3);
      fs.rmSync(tar, { force: true });
      execFileSync('tar', ['--create', '--file', tar, '--format=gnu', '--sort=name', `--mtime=@${commitTime}`, '--owner=0', '--group=0', '--numeric-owner', '-C', stage, folderName]);
      execFileSync('gzip', ['-n', '-9', tar]);
    } else {
      execFileSync('zip', ['-X', '-D', '-q', '-9', archive, '-@'], { cwd: stage, input: names.join('\n') + '\n', env: { ...process.env, TZ: 'UTC' } });
    }
    const data = fs.readFileSync(archive);
    results.push({ target: target.id, file: path.basename(archive), bytes: data.length, sha256: sha256(data), files: release.files.length + 1,
      unpackedBytes: bytes, longestPath: longest, releaseJsonSha256: sha256(fs.readFileSync(path.join(folder, 'release.json'))) });
  }

  fs.writeFileSync(path.join(options.out, 'SHA256SUMS'), results.map(result => `${result.sha256}  ${result.file}`).join('\n') + '\n');
  const report = { name: 'ToolsEngine', version: pkg.version, commit, builtAt, node: process.version,
    // The test run this build was made after. The browser is the one the
    // browser tests drove on the build machine.
    tests: { ...verdict.counts, files: tested.files, browser: process.env.TOOLSENGINE_TEST_BROWSER || 'the Chromium that Playwright downloads',
      browserSandbox: process.env.TOOLSENGINE_TEST_NO_SANDBOX === '1' ? 'off for the tests (TOOLSENGINE_TEST_NO_SANDBOX=1)' : 'on' },
    bundledPackages: rows.length, licences: notices.counts, packageFiles: packedFiles, archives: results };
  fs.writeFileSync(path.join(options.out, 'release-report.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(stage, { recursive: true, force: true });
  console.log(JSON.stringify({ ...report, packageFiles: packedFiles.length }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await build(); }
  catch (error) {
    // A refusal is a plain message; anything else keeps its trace.
    if (!/^(?:Not built|Commit first|Build the release on Linux|Run with)/.test(String(error?.message))) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}
