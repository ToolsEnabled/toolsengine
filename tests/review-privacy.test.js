import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
test('P7 disclosure names model transmission, retained files and deletion limits',()=>{
 const text=fs.readFileSync(new URL('../README.md',import.meta.url),'utf8');
 assert.match(text,/## Data, storage and stopping/);
 assert.match(text,/host\/model provider/);
 assert.match(text,/Uninstall preserves the workspace/);
 assert.match(text,/does not erase the host.*conversation/s);
 assert.match(text,/no automatic retention sweep/);
 assert.match(text,/no package-provided on-screen\s+indicator/);
});
