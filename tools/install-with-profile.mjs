// Run a ToolsEngine installer with a stated account profile.
//
//   node tools/install-with-profile.mjs PROFILE path/to/install.mjs [installer arguments]
//
// The installer takes the account's own profile from the operating system,
// never from the environment and never from an option: that is what keeps it
// from changing another account's client configuration. The tests, and the
// check of a release from a throwaway home, need an installer that treats a
// throwaway folder as that profile. This harness is the one way to say so. It
// calls the installer's own function for it, and refuses an installer that
// has none, so that it can never fall back to the real profile.
//
// It is not part of the package or of a release archive.
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const [profile, installer, ...args] = process.argv.slice(2);
if (!profile || !installer) {
  console.error('usage: node install-with-profile.mjs PROFILE path/to/install.mjs [installer arguments]');
  process.exit(64);
}
// Windows fixture environment home follows USERPROFILE, independently of the
// explicit account-profile test seam below. A surrounding synthetic-profile
// preload must not collapse those two values or erase deliberate mismatch tests.
// This file is excluded from installed/release payloads. No SID/UID/token API changes.
if (process.platform === 'win32') {
  const environmentHome = process.env.USERPROFILE;
  if (!environmentHome || !path.isAbsolute(environmentHome)) {
    console.error('The Windows fixture needs an absolute USERPROFILE.');
    process.exit(64);
  }
  os.homedir = () => environmentHome;
}
const module = await import(pathToFileURL(path.resolve(installer)).href);
if (typeof module.useAccountProfile !== 'function') {
  console.error('This installer cannot be given an account profile, so it was not started: it would have used the real one.');
  process.exit(70);
}
module.useAccountProfile(path.resolve(profile));
process.exitCode = await module.main(args);
