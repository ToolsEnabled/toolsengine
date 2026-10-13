// Nothing but the files of the package may be packed, and so nothing else may
// reach a release archive. "npm pack" takes the folders bin, src, docs and
// native whole, ignored files included.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKAGE_FILES, PACKED_FOLDERS, strayFiles, comparePacked } from '../tools/package-files.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));

test('the packed folders hold the files of the package and no other file', () => {
  assert.deepEqual(strayFiles(PACKAGE), [], 'a file in bin, src, docs or native that is not a file of the package would be shipped');
  for (const name of PACKAGE_FILES) assert.ok(fs.statSync(path.join(PACKAGE, name)).isFile(), `${name} is missing`);
  // The list and the "files" of package.json describe the same package.
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
  for (const folder of PACKED_FOLDERS) assert.ok(manifest.files.includes(folder), `${folder} is not in "files"`);
  const alwaysPacked = ['package.json', 'README.md', 'LICENSE', 'NOTICE'];
  for (const name of PACKAGE_FILES)
    assert.ok(alwaysPacked.includes(name) || manifest.files.includes(name) || manifest.files.includes(name.split('/')[0]), `${name} would not be packed`);
});

test('a stray file in a packed folder is found, wherever it sits and whatever git thinks of it', t => {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsengine-package-'));
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }));
  for (const name of PACKAGE_FILES) {
    fs.mkdirSync(path.dirname(path.join(copy, name)), { recursive: true });
    fs.writeFileSync(path.join(copy, name), '');
  }
  assert.deepEqual(strayFiles(copy), []);
  fs.writeFileSync(path.join(copy, 'src', 'notes-to-self.js'), '');
  fs.mkdirSync(path.join(copy, 'docs', 'drafts'));
  fs.writeFileSync(path.join(copy, 'docs', 'drafts', 'validation.md'), '');
  fs.writeFileSync(path.join(copy, 'native', '.env'), '');
  // Outside the packed folders a file is not packed and is none of this check's business.
  fs.mkdirSync(path.join(copy, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(copy, 'tests', 'x.test.js'), '');
  assert.deepEqual(strayFiles(copy), ['docs/drafts/validation.md', 'native/.env', 'src/notes-to-self.js']);
});

test('the documents that ship use no name that only means something where this was built', () => {
  // "LIVE" is the name of one build of the ToolsEnabled desktop app, "Fleet"
  // of another ToolsEnabled product. A stranger reading the README or the
  // NOTICE knows neither.
  for (const name of ['README.md', 'NOTICE', 'SECURITY.md', 'docs/clients.md']) {
    const text = fs.readFileSync(path.join(PACKAGE, name), 'utf8');
    assert.doesNotMatch(text, /\bLIVE\b/, `${name} names the LIVE app`);
    assert.doesNotMatch(text, /\bFleet\b/, `${name} names Fleet`);
  }
  // The NOTICE still says where the Windows adapter comes from, to the revision.
  const notice = fs.readFileSync(path.join(PACKAGE, 'NOTICE'), 'utf8');
  assert.match(notice, /derives from the MIT-licensed ToolsEnabled\s+desktop app, revision 092a87516d9a4005bb4b3340eecfb7869d715c94/);
  assert.match(notice, /shell\/accessibility-desktop\.cjs\s+and shell\/accessibility-desktop\.ps1/);
});

test('a packed list is compared with the files of the package in both directions', () => {
  assert.deepEqual(comparePacked([...PACKAGE_FILES]), { unexpected: [], missing: [] });
  assert.deepEqual(comparePacked([...PACKAGE_FILES, 'src/notes-to-self.js', 'docs/validation.md']), { unexpected: ['docs/validation.md', 'src/notes-to-self.js'], missing: [] });
  assert.deepEqual(comparePacked(PACKAGE_FILES.filter(name => name !== 'NOTICE' && name !== 'src/web.js')), { unexpected: [], missing: ['NOTICE', 'src/web.js'] });
});


test('the extension regression and its support module are audited release files', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE, 'package.json'), 'utf8'));
  for (const name of ['tests/browser-extension.test.js', 'tests/support/browser-under-test.js']) {
    assert.ok(PACKAGE_FILES.includes(name), `${name} is missing from the audited release`);
    assert.ok(manifest.files.includes(name), `${name} is missing from npm pack`);
  }
});
