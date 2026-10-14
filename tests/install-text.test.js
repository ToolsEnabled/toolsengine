// INSTALL.txt, the first file a person reads in an extracted archive, says
// where the install goes when HOME or USERPROFILE is not the account's own
// profile, that --home DIR chooses the folder, and that the installer prints
// the client commands and ends with exit code 2 instead of running them when
// the environment's home or a client's configuration folder is not the
// person's own. The README said all of this; INSTALL.txt did not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { installText } from '../tools/build-release.js';

const release = { version: '0.1.7' };

test('INSTALL.txt names --home DIR, the own-profile rule and the exit-2 case, on both systems', () => {
  const linux = installText({ system: 'Linux', launcher: 'install.sh' }, release);
  const windows = installText({ system: 'Windows', launcher: 'install.cmd' }, release);
  for (const [text, home, variable] of [[linux, '~/ToolsEngine', 'HOME'], [windows, 'C:\\Users\\YOU\\ToolsEngine', 'USERPROFILE']]) {
    assert.match(text, /^  --home DIR {11}install under DIR instead of your profile \(DIR[\\/]ToolsEngine\)$/m);
    assert.match(text, new RegExp(`is your account's own profile as the system records it, even when\\r?\\n  ${variable} points elsewhere; --home DIR installs under DIR instead\\.`));
    assert.match(text, new RegExp(`The installer runs a client only when ${variable} is your account's own profile and\\r?\\n  CLAUDE_CONFIG_DIR / CODEX_HOME, if set, point inside it\\.`));
    assert.match(text, /with --register it\r?\n  ends with exit code 2 because the registration was not done\. --home DIR changes\r?\n  where ToolsEngine is installed and plays no part in this\./);
    assert.ok(text.includes(`${home}${home.startsWith('C:') ? '\\' : '/'}0.1.7`), 'the install folder is named');
  }
  // The option sits in the OPTIONS list, between --browser and --headed, where the README's list has it.
  const options = linux.split('\n').filter(line => /^  --[a-z-]+/.test(line)).map(line => line.trim().split(/\s+/)[0]);
  assert.deepEqual(options, ['--workspace', '--browser', '--home', '--headed', '--replace', '--dry-run']);
  assert.ok(!linux.includes('\r'), 'Linux text uses LF');
  assert.ok(windows.split('\n').every(line => line === '' || line.endsWith('\r')), 'Windows text uses CRLF');
});
