import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as build from '../tools/build-release.js';
test('R4 logs stay outside the tested tree and packed bytes equal tested bytes',t=>{
 assert.equal(typeof build.validateTestLog,'function');assert.equal(typeof build.testedTree,'function');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'r4-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const pkg=path.join(root,'pkg');fs.mkdirSync(path.join(pkg,'native'),{recursive:true});
 const helper=path.join(pkg,'native','helper.ps1');fs.writeFileSync(helper,'tested');
 assert.throws(()=>build.validateTestLog(helper,pkg),/outside/);
 fs.symlinkSync(path.join(pkg,'native'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir');
 assert.throws(()=>build.validateTestLog(path.join(root,'alias','helper.ps1'),pkg),/outside/);
 assert.equal(build.validateTestLog(path.join(root,'tests.tap'),pkg),path.join(root,'tests.tap'));
 const before=build.testedTree(pkg);fs.writeFileSync(helper,'changed after tests');
 assert.throws(()=>build.assertTestedTree(pkg,before),/changed/);
 assert.throws(()=>build.assertPackedBytes(helper,'native/helper.ps1',before),/tested/);
});
