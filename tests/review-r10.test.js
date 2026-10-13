import test from 'node:test';
import assert from 'node:assert/strict';
import {pasteNote} from '../installer/install.mjs';
test('R10 paste advice covers delayed expansion and quoted executable invocation precisely',()=>{
 assert.match(pasteNote(['claude.cmd','D:\\!NAME!\\ws'],'win32')||'',/delayed expansion|v:off/i);
 assert.equal(pasteNote(['claude.cmd','D:\\R&D work\\ws'],'win32'),null);
 assert.match(pasteNote(['C:\\Program Files\\client.exe','arg'],'win32')||'',/invocation|&/);
 assert.match(pasteNote(['claude.cmd','D:\\R&D\\ws'],'win32')||'',/without.*space|no.*space/i);
});
