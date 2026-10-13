import fs from 'node:fs/promises';
import { createToolsEngine } from '../src/server.js';
const { version } = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const source = JSON.parse(await fs.readFile(new URL('../../reference/public-source.json', import.meta.url), 'utf8'));
const legacy = JSON.parse(await fs.readFile(new URL('../../reports/tool-inventory.json', import.meta.url), 'utf8'));
const engine = await createToolsEngine({ workspace: process.cwd(), headless: true });
const offered = engine.tools.map(({ handler, ...tool }) => tool);
await engine.close();
const publicNames = offered.map(t => t.name).sort();
const replacement = {
  'system.status': ['system.status'], 'capability.find': ['capability.find'],
  'web.fetch': ['web.fetch'], 'web.extract': ['web.extract'],
  'host.read_file': ['workspace.read_file'], 'repo.read_file': ['workspace.read_file'],
  'host.write_file': ['workspace.write_file'], 'repo.write_file': ['workspace.write_file'],
  'host.patch_file': ['workspace.read_file', 'workspace.write_file'], 'repo.patch_file': ['workspace.read_file', 'workspace.write_file'],
  'host.list_dir': ['workspace.list'], 'repo.list_dir': ['workspace.list'],
  'search.query': ['workspace.search'],
  'browser.start': ['browser.navigate'], 'browser.stop': ['browser.close'],
  'browser.status': ['system.status', 'browser.tabs'],
  'browser.playwright_status': ['system.status', 'browser.tabs'],
  'browser.playwright_tools': ['capability.find'],
  'browser.playwright_call': publicNames.filter(n => n.startsWith('browser.')),
};
const decide = id => {
  if (replacement[id]) return {
    decision: 'replace', publicTools: replacement[id],
    reason: id.startsWith('browser.') ? 'Explicit reviewed browser methods replace the generic legacy gateway. Dedicated default; optional startup-selected CDP attachment.'
      : /^(host|repo)\./.test(id) ? 'Workspace-only UTF-8 operations replace profile/repository-wide legacy handlers; writes require a current content hash. Legacy receipt/patch protocol is not imported.'
      : id === 'search.query' ? 'Bounded literal workspace search; no legacy persistent index.'
      : 'Portable implementation with bounded public schema; legacy policy/credential/runtime dependencies are not imported.',
  };
  if (/^(agent|agent_comms|task|t_ledger|r_ledger|a_ledger|ledger|memory)\./.test(id)) return {
    decision: 'separate', publicTools: [], reason: 'Fleet owns delegation, durable coordination and ledgers. Install/configure Fleet separately; this package neither loads nor modifies it.',
  };
  if (/^(pay|payment_method|purchase|stripe|billing|paddle|p_ledger|owner_forms|owner_prompts|ide)\./.test(id)
    || /credential|account|kill_switch|consent/.test(id)) return {
    decision: 'exclude', publicTools: [], reason: 'Credential/account custody, owner-consent controls or financial operations do not belong in this general browser/workspace shipment.',
  };
  if (/^(host\.exec|http\.request|sandbox\.|cloud\.|model\.|settings\.|app\.|overnight_advisory\.)/.test(id)) return {
    decision: 'exclude', publicTools: [], reason: 'Privileged execution, broad HTTP/host control or product-internal runtime configuration is outside this package. Use an independently configured client or integration.',
  };
  return { decision: 'defer', publicTools: [], reason: 'Potentially useful optional adapter, but needs its own platform/provider/permission contract and tests. It is absent from discovery and dispatch in this release.' };
};
const rows = source.ids.map(id => ({ id, ...decide(id) }));
const counts = Object.fromEntries([...new Set(rows.map(r => r.decision))].map(key => [key, rows.filter(r => r.decision === key).length]));
const comparison = legacy.source.comparisonToLive;
await fs.mkdir('docs', { recursive: true });
await fs.writeFile('docs/tool-catalogue.json', JSON.stringify({ version, count: offered.length, tools: offered }, null, 2) + '\n');
await fs.writeFile('../reference/curation.json', JSON.stringify({
  version, status: 'implemented-candidate',
  source: { ...source, ids: undefined },
  liveSource: { commit: comparison.liveCommit, catalogueCount: comparison.liveCatalogueCount },
  sourceMethod: 'Latest public main reviewed as source; new portable implementation. No legacy engine registry/provider modules are loaded.',
  sourceDefinitionScope: '261 explicit core define declarations; optional owner tool packs are not counted or shipped.',
  counts, publicToolCount: offered.length,
  addedSinceLive: comparison.mainOnly,
  absentFromPublicMain: comparison.liveOnly,
  tools: rows,
}, null, 2) + '\n');
console.log(JSON.stringify({ publicTools: offered.length, reviewed: rows.length, counts }));
