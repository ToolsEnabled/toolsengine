import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeDesktopRun } from '../tools/qualify-windows.js';

test('native desktop release gate refuses skips, cancellation, truncated and contradictory results', () => {
  const good = '# tests 8\n# pass 8\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n';
  assert.equal(judgeDesktopRun({ status: 0, output: good }).ok, true);
  for (const output of [
    good.replace('# pass 8', '# pass 7').replace('# skipped 0', '# skipped 1'),
    good.replace('# cancelled 0', '# cancelled 1'),
    good.replace('# todo 0', '# todo 1'),
    good.replace('# tests 8', '# tests 7'),
    good.replace('# fail 0\n', ''),
    good + 'not ok 1 - failed despite counts\n',
    '',
  ]) assert.equal(judgeDesktopRun({ status: 0, output }).ok, false);
  assert.equal(judgeDesktopRun({ status: null, output: good }).ok, false);
  assert.equal(judgeDesktopRun({ status: 1, output: good }).ok, false);
});
