// The release build runs the tests first, and builds nothing from a tree
// whose tests fail or whose browser tests did not run.
//
// A test that is skipped because of the system it runs on (a Windows-only
// test on Linux) is not held against the tree. A browser test that was
// skipped because the browser under test cannot run on the build machine is:
// an archive must not be built from a tree in which nothing opened a page.
// tests/support/browser-under-test.js writes those skip reasons; they begin
// with one of the two sentences below, and a test holds the two files
// together.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const BROWSER_TESTS_DID_NOT_RUN = Object.freeze([
  'The browser under test cannot set up its sandbox on this machine',
  'The Chromium build this version is pinned to is not on this machine',
]);

export const FIREFOX_LIVE_TEST = 'hidden Firefox types and clicks on its authenticated private display without importing user credentials';
// browser.show and browser.hide with the real programs (tests/browser-view.integration.test.js).
// On Linux they must pass; elsewhere they are skipped with exactly this reason.
export const VIEW_LIVE_TESTS = Object.freeze([
  'the view channel is a private Unix socket with a password, for one viewer, and no network port',
  "ToolsEngine's Chromium on its private display: hidden, shown to the person who uses it, hidden again with the same live page",
  'hidden Firefox: shown to the person who clicks in it, hidden again with the same live page',
  "over stdio, --private-display offers browser.show, keeps the browser off the person's screen, and shows it or names what is missing",
]);
export const VIEW_PLATFORM_SKIP = 'browser.show and browser.hide require Linux';
export const REQUIRED_BROWSER_SUCCESSES = Object.freeze([
  'real Chromium navigation, form interaction, snapshot, screenshot and PDF',
  'explicit CDP attachment lists tabs and disconnects without closing the browser',
  'closing the browser keeps cookies with --profile-dir and discards them with the temporary profile',
  'in an attached browser a download is left to that browser:',
  'actual stdio MCP resizes real browser desktop/mobile',
  'a browser with a dedicated profile (--profile-dir) is started sandboxed as well',
  ...(process.platform === 'linux' ? [FIREFOX_LIVE_TEST, ...VIEW_LIVE_TESTS] : []),
]);

// The test files whose tests open a page in a browser or attach to one. A
// test skipped in one of them is a browser test that did not run, unless its
// reason is one of the known facts about the build machine listed next. The
// file a line belongs to is known from the "# File:" line that runTests
// writes before each file's output.
export const BROWSER_TEST_FILES = Object.freeze([
  'tests/firefox-live.linux.test.js',
  'tests/browser-extension.test.js',
  'tests/browser-modes.integration.test.js',
  'tests/browser-sandbox.integration.test.js',
  'tests/browser-temp.integration.test.js',
  'tests/browser-tools.integration.test.js',
  'tests/browser-view.integration.test.js',
  'tests/browser.integration.test.js',
  'tests/resize.integration.test.js',
  'tests/review-live.integration.test.js',
]);
export const KNOWN_BROWSER_SKIPS = Object.freeze([
  'TOOLSENGINE_TEST_BROWSER names another browser',
  'needs an installed Chrome or Edge, or TOOLSENGINE_TEST_CHANNEL',
  'needs an installed Chrome or Edge on Linux, or TOOLSENGINE_TEST_CHANNEL',
  'needs an installed Google Chrome',
  'no short directories on Windows',
]);
// Skipped tests of the browser test files whose reason is none of the known
// ones. Lines before the first "# File:" line belong to no file.
export function unrecognisedBrowserSkips(text) {
  const found = [];
  let file = null;
  for (const line of String(text).split('\n')) {
    const header = /^# File: (.*)$/.exec(line);
    if (header) { file = header[1].trim().replaceAll('\\', '/'); continue; }
    const skip = /^\s*ok \d+ - (.*?) # SKIP ?(.*)$/.exec(line);
    if (!skip || !BROWSER_TEST_FILES.includes(file)) continue;
    const reason = skip[2].trim();
    // This test proves a Linux-only XDG convention, not a missing browser.
    // Admit only its exact Windows row; every other unknown skip still refuses.
    const xdgPlatformSkip = process.platform === 'win32'
      && file === 'tests/browser-modes.integration.test.js'
      && skip[1].trim() === 'the browser ToolsEngine starts writes nothing under the configuration folder of the environment it was started in'
      && reason === 'XDG_CONFIG_HOME is a Linux convention';
    const firefoxPlatformSkip = process.platform !== 'linux'
      && file === 'tests/firefox-live.linux.test.js'
      && skip[1].trim() === FIREFOX_LIVE_TEST
      && reason === 'Firefox mode requires Linux';
    const viewPlatformSkip = process.platform !== 'linux'
      && file === 'tests/browser-view.integration.test.js'
      && VIEW_LIVE_TESTS.includes(skip[1].trim())
      && reason === VIEW_PLATFORM_SKIP;
    if (!xdgPlatformSkip && !firefoxPlatformSkip && !viewPlatformSkip && !KNOWN_BROWSER_SKIPS.some(words => reason.startsWith(words))) found.push({ file, name: skip[1].trim(), reason });
  }
  return found;
}

// output: what "node --test --test-reporter=tap" printed. status: its exit code.
export function judgeTestRun({ status, output }) {
  const text = String(output ?? '');
  const count = name => { const match = new RegExp(`^# ${name} (\\d+)\\s*$`, 'm').exec(text); return match ? Number(match[1]) : null; };
  const counts = { tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
    cancelled: count('cancelled') ?? 0, todo: count('todo') ?? 0 };
  if (counts.tests === null || counts.pass === null || counts.fail === null)
    return { ok: false, counts, reason: 'The test run gave no result that could be read.' };
  const failed = text.split('\n').filter(line => /^\s*not ok \d+ - /.test(line)).map(line => line.replace(/^\s*not ok \d+ - /, '').trim());
  if (status !== 0 || counts.fail > 0 || counts.cancelled > 0 || counts.todo > 0 || failed.length)
    return { ok: false, counts, reason: `${counts.fail} failed, ${counts.cancelled} cancelled and ${counts.todo} TODO out of ${counts.tests} tests${failed.length ? `: ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? '; ...' : ''}` : ` (exit code ${status})`}.` };
  if (counts.pass + counts.fail + counts.skipped + counts.cancelled + counts.todo !== counts.tests)
    return { ok: false, counts, reason: 'The test totals do not account for every test.' };
  if (counts.tests === 0 || counts.pass === 0) return { ok: false, counts, reason: 'No test ran.' };
  const notRun = text.split('\n').filter(line => BROWSER_TESTS_DID_NOT_RUN.some(words => line.includes(`# SKIP ${words}`)));
  if (notRun.length) {
    const why = notRun[0].slice(notRun[0].indexOf('# SKIP ') + 7).trim();
    return { ok: false, counts, reason: `${notRun.length} browser tests did not run on this machine. ${why}` };
  }
  const unrecognised = unrecognisedBrowserSkips(text);
  if (unrecognised.length) {
    const [first] = unrecognised;
    return { ok: false, counts, reason: `${unrecognised.length} browser tests were skipped for a reason the build does not know: ${first.file}: ${first.name} # SKIP ${first.reason || '(no reason given)'}` };
  }
  const passed = text.split('\n').filter(line => /^\s*ok \d+ - /.test(line) && !/# SKIP|# TODO/.test(line));
  const missing = REQUIRED_BROWSER_SUCCESSES.filter(name => !passed.some(line => line.includes(` - ${name}`)));
  if (missing.length) return { ok: false, counts, reason: `Required browser tests did not pass: ${missing.join('; ')}` };
  return { ok: true, counts };
}

// Run every test file sequentially, with one test process at a time.
export function runTests(packageFolder, { env = process.env } = {}) {
  const files = fs.readdirSync(path.join(packageFolder, 'tests')).filter(name => name.endsWith('.test.js')).sort().map(name => path.join('tests', name));
  const totals = { tests: 0, pass: 0, fail: 0, skipped: 0, cancelled: 0, todo: 0 };
  let status = 0, output = '';
  for (const file of files) {
    const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: packageFolder, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const text = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.status !== 0) status = result.status ?? 1;
    for (const key of Object.keys(totals)) {
      const match = new RegExp(`^# ${key} (\\d+)\\s*$`,'m').exec(text);
      if (!match) status = 1;
      else totals[key] += Number(match[1]);
    }
    output += `# File: ${file}\n` + text.replace(/^# (?:tests|pass|fail|skipped|suites|cancelled|todo|duration_ms) .*$/gm,'') + '\n';
  }
  output += Object.entries(totals).map(([key,value])=>`# ${key} ${value}`).join('\n')+'\n';
  return { status, output, files: files.length };
}
