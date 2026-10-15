// The files of the package, exactly.
//
// "npm pack" takes whole folders (bin, src, docs, native) and does not ask
// git: a file left in one of them, even an ignored one, is packed and would
// be shipped inside a release archive. The package audit, the release build
// and a test all hold the packed list to this one, so such a file stops the
// build instead of travelling with it.
import fs from 'node:fs';
import path from 'node:path';

export const PACKAGE_FILES = Object.freeze([
  '.agents/plugins/marketplace.json',
  '.codex-plugin/mcp.json',
  '.codex-plugin/plugin.json',
  '.codex-plugin/start.mjs',
  'codex-skills/toolsengine/SKILL.md',
  'docs/CODEX.md',
  'PRIVACY.md',
  'LICENSE',
  'NOTICE',
  'README.md',
  'SECURITY.md',
  'bin/toolsengine.js',
  'docs/clients.md',
  'docs/desktop-catalogue.json',
  'docs/tool-catalogue.json',
  'docs/windows-focus-recovery.md',
  'native/accessibility-desktop.cjs',
  'native/accessibility-desktop.ps1',
  'npm-shrinkwrap.json',
  'package.json',
  'src/artifacts.js',
  'src/browser.js',
  'src/config.js',
  'src/desktop.js',
  'src/extension-worker.js',
  'src/server.js',
  'src/web.js',
  'src/workspace.js',
  'tests/browser-extension.test.js',
  'tests/support/browser-under-test.js',
]);

// The folders that are packed whole.
export const PACKED_FOLDERS = Object.freeze(['bin', 'docs', 'native', 'src', '.codex-plugin', 'codex-skills']);

// Files in the packed folders that are not files of the package.
export function strayFiles(packageDirectory) {
  const found = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(packageDirectory, relative), { withFileTypes: true })) {
      const name = `${relative}/${entry.name}`;
      if (entry.isDirectory()) visit(name);
      else if (!PACKAGE_FILES.includes(name)) found.push(name);
    }
  };
  for (const folder of PACKED_FOLDERS) if (fs.existsSync(path.join(packageDirectory, folder))) visit(folder);
  return found.sort();
}

// Compare a list of packed paths with the package's files. Returns what is
// there and should not be, and what should be there and is not.
export function comparePacked(paths) {
  return {
    unexpected: paths.filter(name => !PACKAGE_FILES.includes(name)).sort(),
    missing: PACKAGE_FILES.filter(name => !paths.includes(name)),
  };
}
