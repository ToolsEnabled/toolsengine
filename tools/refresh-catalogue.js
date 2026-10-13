// Refresh public schemas while preserving all reviewed legacy curation decisions.
// Both catalogues are written from the descriptors the server itself offers,
// so the audit's comparison holds by construction after a refresh.
import fs from 'node:fs/promises';
import { createToolsEngine } from '../src/server.js';
import { desktopToolDescriptors } from '../src/desktop.js';
const { version } = JSON.parse(await fs.readFile('package.json', 'utf8'));
const engine = await createToolsEngine({ workspace: process.cwd(), headless: true });
try {
  const tools = engine.tools.map(({ handler, ...descriptor }) => descriptor);
  await fs.writeFile('docs/tool-catalogue.json', JSON.stringify({ version, count: tools.length, tools }, null, 2) + '\n');
  const curation = JSON.parse(await fs.readFile('../reference/curation.json', 'utf8'));
  curation.version = version; curation.publicToolCount = tools.length;
  curation.tools.find(row => row.id === 'browser.playwright_call').publicTools = tools.filter(t => t.name.startsWith('browser.')).map(t => t.name).sort();
  await fs.writeFile('../reference/curation.json', JSON.stringify(curation, null, 2) + '\n');
  const desktop = { version, condition: 'Windows; explicit --desktop-profile-root for current account', tools: desktopToolDescriptors() };
  await fs.writeFile('docs/desktop-catalogue.json', JSON.stringify(desktop, null, 2) + '\n');
} finally { await engine.close(); }
