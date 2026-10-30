// Test-only source selection. The actual pinned factory, extension, relay,
// Chrome APIs, production transfer worker and hidden target are unchanged.
import { createRequire } from 'node:module';
import { workerData } from 'node:worker_threads';
const require = createRequire(import.meta.url);
if (!workerData?.fixtureSource) throw new Error('Synthetic source fixture required.');
const key = require.resolve('playwright-core/lib/coreBundle');
const original = require(key);
const factory = original.tools.createBrowserWithInfo;
require.cache[key].exports = { ...original, tools: { ...original.tools,
  createBrowserWithInfo: (config, client, cli, binding) => factory({
    ...config, browser: { ...config.browser, userDataDir: workerData.fixtureSource.profile },
  }, client, { ...cli, executablePath: workerData.fixtureSource.executable, profileDirName: 'Default' }, binding),
} };
