// The release build is refused when a test of a browser test file was
// skipped for a reason the build does not know, even though every required
// browser scenario passed. Before this test held the six required scenarios
// in its input, it was refused for their absence, not for the skip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {judgeTestRun,REQUIRED_BROWSER_SUCCESSES,BROWSER_TEST_FILES,KNOWN_BROWSER_SKIPS,unrecognisedBrowserSkips} from '../tools/test-gate.js';
const evidence=REQUIRED_BROWSER_SUCCESSES.map((name,index)=>`ok ${index+1} - ${name}`).join('\n')+'\n';
const summary=(tests,pass,fail,skipped)=>`# tests ${tests}\n# pass ${pass}\n# fail ${fail}\n# skipped ${skipped}\n`;
test('release gate refuses an unidentified browser skip even when the required browser scenarios passed',()=>{
 const output=`# File: tests/installer.test.js\nok 1 - ordinary test # SKIP only Windows starts clients through cmd.exe\n# File: tests/browser.integration.test.js\n${evidence}ok 7 - browser test # SKIP novel skip reason\n${summary(8,6,0,2)}`;
 const verdict=judgeTestRun({status:0,output});
 assert.equal(verdict.ok,false);
 assert.equal(verdict.reason,'1 browser tests were skipped for a reason the build does not know: tests/browser.integration.test.js: browser test # SKIP novel skip reason');
 assert.deepEqual(unrecognisedBrowserSkips(output),[{file:'tests/browser.integration.test.js',name:'browser test',reason:'novel skip reason'}]);
 // A skip with no reason at all is as unknown as a new one.
 assert.equal(judgeTestRun({status:0,output:output.replace('# SKIP novel skip reason','# SKIP')}).reason,'1 browser tests were skipped for a reason the build does not know: tests/browser.integration.test.js: browser test # SKIP (no reason given)');
 // The same skip in a file that opens no page is not held against the tree,
 // and in a browser test file a known fact about the build machine is not either.
 const fine=`# File: tests/installer.test.js\nok 1 - ordinary test # SKIP novel skip reason\n# File: tests/browser-sandbox.integration.test.js\n${evidence}ok 7 - sandbox test # SKIP ${KNOWN_BROWSER_SKIPS[0]}\n${summary(8,6,0,2)}`;
 assert.deepEqual(judgeTestRun({status:0,output:fine}),{ok:true,counts:{tests:8,pass:6,fail:0,skipped:2,cancelled:0,todo:0}});
 // Without the required scenarios the refusal names them, whatever was skipped.
 assert.match(judgeTestRun({status:0,output:`ok 1 - ordinary test\nok 2 - browser test # SKIP novel skip reason\n${summary(2,1,0,1)}`}).reason,/^Required browser tests did not pass: /);
 assert.ok(BROWSER_TEST_FILES.includes('tests/browser.integration.test.js'));
});
