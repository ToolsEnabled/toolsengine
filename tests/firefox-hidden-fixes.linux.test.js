// Native helper tests run in the suite (fake accessibles and a fake Xvfb; no
// bus or display is used). AT-SPI 2.62 reports Firefox buttons with the role
// "button" where earlier releases said "push button"; the helper reads both as
// "push button". Two hidden Firefoxes starting together may pick the same
// display number; each takes only the display whose lock names its own Xvfb.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const tests=path.dirname(fileURLToPath(import.meta.url));
const linux={skip:process.platform!=='linux'?'Firefox mode requires Linux':false};
const run=(file,name)=>spawnSync('/usr/bin/python3',['-B',path.join(tests,file),name],{encoding:'utf8',timeout:120000});

for(const [file,name] of [['firefox_native_test.py','RoleNameTests'],
                          ['firefox_secure_test.py','DocumentTests.test_private_control_lookup_matches_a_button_role_as_push_button']]){
  test(`native helper reads the AT-SPI role "button" as "push button": ${name}`,linux,()=>{
    const result=run(file,name);
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stderr,/\nOK\s*$/);
  });
}

test('two hidden Firefox helpers starting together do not share a display number',linux,()=>{
  const result=run('firefox_native_test.py','HiddenDisplayRaceTests');
  assert.equal(result.status,0,result.stdout+result.stderr);
  assert.match(result.stderr,/\nOK\s*$/);
});
