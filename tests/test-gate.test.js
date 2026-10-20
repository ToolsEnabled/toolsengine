// The release build runs the tests before it builds (tools/test-gate.js) and
// refuses a tree whose tests fail, or whose browser tests did not run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as gate from '../tools/test-gate.js';

const summary = (tests, pass, fail, skipped) => `1..${tests}\n# tests ${tests}\n# suites 0\n# pass ${pass}\n# fail ${fail}\n# cancelled 0\n# skipped ${skipped}\n# todo 0\n# duration_ms 12.5\n`;

test('the build goes ahead only after a test run in which everything passed and the browser tests ran', () => {
  const { judgeTestRun } = gate;
  assert.equal(typeof judgeTestRun, 'function');

  // Everything passed. A test skipped for the system it is on does not count against the tree.
  const evidence = gate.REQUIRED_BROWSER_SUCCESSES.map((name,index)=>`ok ${index+4} - ${name}`).join('\n')+'\n';
  const good = judgeTestRun({ status: 0, output: evidence + `TAP version 13\nok 1 - one\nok 2 - two # SKIP only Windows starts clients through cmd.exe\nok 3 - three # SKIP set TOOLSENGINE_DESKTOP_LIVE=1 on Windows to open test windows\n${summary(3, 1, 0, 2)}` });
  assert.deepEqual(good, { ok: true, counts: { tests: 3, pass: 1, fail: 0, skipped: 2, cancelled: 0, todo: 0 } });

  // A failing test: not built, and the reason names it.
  const red = judgeTestRun({ status: 1, output: `TAP version 13\nok 1 - one\nnot ok 2 - the thing that broke\n  ---\n  error: 'x'\n  ...\n${summary(2, 1, 1, 0)}` });
  assert.equal(red.ok, false);
  assert.match(red.reason, /^1 failed, 0 cancelled and 0 TODO out of 2 tests: the thing that broke\.$/);
  // A run that ended badly without a failed test in its count (a crash on the way out) is not a pass either.
  assert.equal(judgeTestRun({ status: 1, output: summary(2, 2, 0, 0) }).ok, false);
  assert.equal(judgeTestRun({ status: null, output: summary(2, 2, 0, 0) }).ok, false);
  // No result at all, or no test.
  assert.equal(judgeTestRun({ status: 0, output: 'something went wrong before the tests\n' }).ok, false);
  assert.equal(judgeTestRun({ status: 0, output: '' }).ok, false);
  assert.equal(judgeTestRun({ status: 0, output: summary(0, 0, 0, 0) }).ok, false);
  assert.equal(judgeTestRun({ status: 0, output: summary(4, 0, 0, 4) }).ok, false, 'a run in which every test was skipped proves nothing');

  // The browser tests were skipped because the browser cannot run here. Every
  // other test passed, and the exit code is 0: still not built, and the
  // reason carries what to set.
  for (const words of gate.BROWSER_TESTS_DID_NOT_RUN) {
    const skipped = judgeTestRun({ status: 0, output: `TAP version 13\nok 1 - one\nok 2 - opens a page # SKIP ${words} (and more). To run the browser tests, set TOOLSENGINE_TEST_BROWSER to the path of an installed Chrome or Edge.\nok 3 - opens another # SKIP ${words} (and more). To run the browser tests, set TOOLSENGINE_TEST_BROWSER to the path of an installed Chrome or Edge.\n${summary(3, 1, 0, 2)}` });
    assert.equal(skipped.ok, false, words);
    assert.match(skipped.reason, /^2 browser tests did not run on this machine\. /);
    assert.match(skipped.reason, /TOOLSENGINE_TEST_BROWSER/);
  }
});

test('release evidence rejects cancellation, contradictory totals and Windows-path hidden skips', () => {
  const evidence=gate.REQUIRED_BROWSER_SUCCESSES.map((name,index)=>`ok ${index+1} - ${name}`).join('\n')+'\n';
  const count=gate.REQUIRED_BROWSER_SUCCESSES.length;
  for(const text of [
    summary(count+1,count,0,0).replace('# cancelled 0','# cancelled 1'),
    summary(count+1,count,0,0),
    'not ok 99 - interrupted\n'+summary(count,count,0,0),
    '# File: tests\\browser.integration.test.js\nok 99 - critical check # SKIP unknown Windows reason\n'+summary(count+1,count,0,1),
  ]) assert.equal(gate.judgeTestRun({status:0,output:evidence+text}).ok,false);
});

test('the skip reasons the build looks for are the ones the browser tests give, and the build has no way around its tests', () => {
  // Read as text: importing the helper would start a browser.
  const helper = fs.readFileSync(new URL('./support/browser-under-test.js', import.meta.url), 'utf8');
  assert.equal(gate.BROWSER_TESTS_DID_NOT_RUN.length, 2);
  for (const words of gate.BROWSER_TESTS_DID_NOT_RUN) assert.ok(helper.includes(`'${words}'`), `the browser tests do not give this reason: ${words}`);
  // Each skip tells the person which variable to set.
  assert.match(helper, /set TOOLSENGINE_TEST_BROWSER to the path of an installed Chrome or Edge/);
  assert.match(helper, /TOOLSENGINE_TEST_NO_SANDBOX=1/);

  const build = fs.readFileSync(new URL('../tools/build-release.js', import.meta.url), 'utf8');
  assert.match(build, /const verdict = judgeTestRun\(tested\);/);
  assert.match(build, /if \(!verdict\.ok\) throw new Error\(`Not built: /);
  // The tests come before anything is packed.
  assert.ok(build.indexOf('const verdict = judgeTestRun(tested);') < build.indexOf("npm(['pack'"), 'the tests must run before the package is packed');
  assert.doesNotMatch(build, /--skip-tests|--no-tests|skipTests/);

  // The files that open a page in the server's own browser use the helper.
  for (const file of ['browser-tools.integration.test.js', 'browser.integration.test.js', 'browser-modes.integration.test.js', 'resize.integration.test.js'])
    assert.match(fs.readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'), /from '\.\/support\/browser-under-test\.js'/, file);

  // Every test file that starts or attaches a browser is a browser test file
  // to the gate, and the skip reasons the gate accepts there are the ones
  // those files give.
  const testFiles = fs.readdirSync(new URL('.', import.meta.url)).filter(name => name.endsWith('.test.js')).sort();
  const source = name => fs.readFileSync(new URL(`./${name}`, import.meta.url), 'utf8');
  const opensBrowser = testFiles.filter(name => /from '(?:playwright|\.\/support\/browser-under-test\.js)'/.test(source(name)));
  for (const name of opensBrowser) assert.ok(gate.BROWSER_TEST_FILES.includes(`tests/${name}`), `tests/${name} starts a browser and must be a browser test file to the gate`);
  for (const file of gate.BROWSER_TEST_FILES) assert.ok(testFiles.includes(file.replace(/^tests\//, '')), `${file} does not exist`);
  const browserSources = gate.BROWSER_TEST_FILES.map(file => source(file.replace(/^tests\//, ''))).join('\n');
  for (const words of gate.KNOWN_BROWSER_SKIPS) assert.ok(browserSources.includes(`'${words}'`), `no browser test skips with this reason: ${words}`);
});


test('the Windows-only XDG skip has one exact identity and cannot replace required live browser successes', () => {
  const raw = fs.readFileSync(new URL('../tools/test-gate.js', import.meta.url), 'utf8');
  const pure = raw.slice(raw.indexOf('export const BROWSER_TESTS_DID_NOT_RUN'), raw.indexOf('// Run every test file sequentially')).replace(/^export /gm, '');
  const load = platform => vm.runInNewContext(pure + ';({judgeTestRun,unrecognisedBrowserSkips,REQUIRED_BROWSER_SUCCESSES})', {process:{platform}});
  const win = load('win32'), linux = load('linux');
  const row = { file:'tests/browser-modes.integration.test.js', name:'the browser ToolsEngine starts writes nothing under the configuration folder of the environment it was started in', reason:'XDG_CONFIG_HOME is a Linux convention' };
  const emit = (r=row, omitted=-1) => '# File: '+r.file+'\nok 1 - '+r.name+' # SKIP '+r.reason+'\n'+win.REQUIRED_BROWSER_SUCCESSES.filter((_,i)=>i!==omitted).map((name,i)=>'ok '+(i+2)+' - '+name).join('\n')+'\n'+summary(7,6,0,1);
  assert.equal(win.judgeTestRun({status:0,output:emit()}).ok,true);
  assert.equal(linux.judgeTestRun({status:0,output:emit()}).ok,false);
  for (const changed of [{...row,file:'tests/browser.integration.test.js'},{...row,name:row.name+' altered'},{...row,reason:row.reason+' extra'},{...row,reason:'unknown reason'}]) {
    assert.equal(win.judgeTestRun({status:0,output:emit(changed)}).ok,false);
    assert.equal(win.unrecognisedBrowserSkips(emit(changed)).length,1);
  }
  for (let i=0;i<win.REQUIRED_BROWSER_SUCCESSES.length;i++) {
    const result=win.judgeTestRun({status:0,output:emit(row,i)});
    assert.equal(result.ok,false);assert.match(result.reason,/Required browser tests did not pass/);
  }
});

test('the Firefox release check cannot be omitted on Linux or skipped under an altered platform identity', () => {
  const raw = fs.readFileSync(new URL('../tools/test-gate.js', import.meta.url), 'utf8');
  const pure = raw.slice(raw.indexOf('export const BROWSER_TESTS_DID_NOT_RUN'), raw.indexOf('// Run every test file sequentially')).replace(/^export /gm, '');
  const load = platform => vm.runInNewContext(pure + ';({judgeTestRun,REQUIRED_BROWSER_SUCCESSES,FIREFOX_LIVE_TEST})', {process:{platform}});
  const linux=load('linux'),win=load('win32');
  const evidence=win.REQUIRED_BROWSER_SUCCESSES.map((name,index)=>`ok ${index+2} - ${name}`).join('\n');
  const row={file:'tests/firefox-live.linux.test.js',name:win.FIREFOX_LIVE_TEST,reason:'Firefox mode requires Linux'};
  const output=r=>`# File: ${r.file}\nok 1 - ${r.name} # SKIP ${r.reason}\n${evidence}\n${summary(7,6,0,1)}`;
  assert.equal(win.judgeTestRun({status:0,output:output(row)}).ok,true);
  assert.equal(linux.judgeTestRun({status:0,output:output(row)}).ok,false);
  assert.equal(linux.judgeTestRun({status:0,output:evidence+'\n'+summary(6,6,0,0)}).ok,false);
  for(const changed of [{...row,file:'tests/browser.integration.test.js'},{...row,name:row.name+' altered'},{...row,reason:row.reason+' extra'}])
    assert.equal(win.judgeTestRun({status:0,output:output(changed)}).ok,false);
});

test('native Chrome release evidence requires the actual approved extension workflow', () => {
  const raw = fs.readFileSync(new URL('../tools/test-gate.js', import.meta.url), 'utf8');
  const pure = raw.slice(raw.indexOf('export const BROWSER_TESTS_DID_NOT_RUN'), raw.indexOf('// Run every test file sequentially')).replace(/^export /gm, '');
  for (const platform of ['linux', 'win32']) {
    const model = vm.runInNewContext(pure + ';({judgeTestRun,REQUIRED_BROWSER_SUCCESSES,CHROME_LIVE_TEST})', {process:{platform}});
    const emit = names => names.map((name, i) => 'ok ' + (i + 1) + ' - ' + name).join('\n') + '\n' + summary(names.length, names.length, 0, 0);
    assert.equal(model.judgeTestRun({ status: 0, output: emit(model.REQUIRED_BROWSER_SUCCESSES) }).ok, true);
    const partial = model.REQUIRED_BROWSER_SUCCESSES.filter(name => name !== model.CHROME_LIVE_TEST);
    partial.push(model.CHROME_LIVE_TEST.replace(' through its approved extension', ''));
    assert.equal(model.judgeTestRun({ status: 0, output: emit(partial) }).ok, false);
  }
});
