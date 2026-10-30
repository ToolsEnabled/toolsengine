import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as gate from '../tools/test-gate.js';

test('the hidden-dialogs proof is a required Linux browser test of the release gate', () => {
  assert.ok(gate.BROWSER_TEST_FILES.includes('tests/hidden-dialogs.linux.test.js'));
  assert.equal(gate.REQUIRED_BROWSER_SUCCESSES.includes(gate.FIREFOX_DIALOGS_LIVE_TEST), process.platform === 'linux');
  assert.ok(fs.readFileSync(new URL('./hidden-dialogs.linux.test.js', import.meta.url), 'utf8').includes(gate.FIREFOX_DIALOGS_LIVE_TEST));
});
