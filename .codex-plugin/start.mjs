// Codex's narrow local-file/public-web connection. No installer or network at startup.
import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
const workspace=process.env.TOOLSENGINE_CODEX_WORKSPACE;
if(!workspace||!isAbsolute(workspace)){console.error('ToolsEngine Codex: set TOOLSENGINE_CODEX_WORKSPACE to your existing absolute project directory before starting Codex.');process.exit(1);}
const require = createRequire(import.meta.url);
try {
  require.resolve('@modelcontextprotocol/sdk/server/stdio.js');
} catch {
  console.error('ToolsEngine Codex setup required: in the installed plugin folder, run npm ci --omit=dev --ignore-scripts after reviewing docs/CODEX.md. Startup downloads nothing.');
  process.exit(1);
}
// The host supplies the explicit project environment. Keep physical workspace checks.
process.argv = [process.execPath, new URL('../bin/toolsengine.js', import.meta.url).pathname,
  '--workspace', workspace, '--no-browser'];
await import('../bin/toolsengine.js');
