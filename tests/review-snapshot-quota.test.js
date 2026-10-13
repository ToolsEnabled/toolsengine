// The page snapshot that the browser library writes after a click, a key, a
// navigation or any other browser call is written after the call has acted
// on the page. In 0.1.5 a full saved-output quota or a held output lock made
// that write throw, and the call that had already clicked "Place order" came
// back as an error saying nothing was saved, inviting a second click. And
// nothing ever removed old snapshots, so the quota filled after about 256
// browser calls in a workspace that is kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createArtifactBudget, ARTIFACT_LIMITS, AUTOMATIC_SNAPSHOT, snapshotShare } from '../src/artifacts.js';
import { reportUnsavedSnapshots } from '../src/browser.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'snapshot-quota-')));
  await fs.mkdir(path.join(root, 'artifacts', 'toolsengine'), { recursive: true });
  await fs.mkdir(path.join(root, '.toolsengine-runtime'));
  const budgets = [];
  t.after(async () => { for (const budget of budgets) await budget.close(); await fs.rm(root, { recursive: true, force: true }); });
  return {
    root,
    output: path.join(root, 'artifacts', 'toolsengine'),
    async open(limits = ARTIFACT_LIMITS) { const budget = await createArtifactBudget(root, limits); budgets.push(budget); return budget; },
  };
}
// The name the browser library gives an automatic snapshot: page-<UTC time>.yml.
const stamp = i => new Date(Date.UTC(2026, 9, 13, 10, 0, 0) + i * 1000).toISOString().replace(/[:.]/g, '-');
const snapshotName = i => `page-${stamp(i)}.yml`;
const snapshotsIn = async folder => (await fs.readdir(folder)).filter(name => AUTOMATIC_SNAPSHOT.test(name)).sort();

test('the automatic snapshot name is the one the browser library writes', () => {
  assert.match(snapshotName(0), AUTOMATIC_SNAPSHOT);
  assert.match(`page-${new Date().toISOString().replace(/[:.]/g, '-')}.yml`, AUTOMATIC_SNAPSHOT);
  for (const name of ['page-2026.yml', 'page-2026-10-13T10-00-00-000Z.png', 'mine-2026-10-13T10-00-00-000Z.yml', 'page-2026-10-13T10-00-00-000Z.yml.bak'])
    assert.doesNotMatch(name, AUTOMATIC_SNAPSHOT);
  assert.deepEqual(snapshotShare(ARTIFACT_LIMITS), { files: 64, bytes: 16 * 1024 * 1024 });
  assert.deepEqual(snapshotShare({ ...ARTIFACT_LIMITS, files: 1, bytes: 10 }), { files: 1, bytes: 2 });
});

test('300 browser calls in one workspace: every automatic snapshot is written, the oldest are removed, the person\'s files stay', async t => {
  const f = await fixture(t);
  const budget = await f.open();
  // What the person asked for: a screenshot under a name of their own, a
  // download, and a snapshot they named like an automatic one.
  const named = path.join(f.root, 'shot.png');
  budget.addOutput(named); await fs.writeFile(named, 'picture');
  const kept = path.join(f.output, snapshotName(-1));
  budget.addOutput(kept);
  // A write in between looks the index over before the named file exists.
  await fs.writeFile(path.join(f.output, snapshotName(-2)), 'automatic');
  await fs.writeFile(kept, 'a snapshot the person named');
  await budget.writeDownload(path.join(f.output, 'download-1-report.txt'), 'report');
  for (let i = 0; i < 300; i++) await fs.writeFile(path.join(f.output, snapshotName(i)), `snapshot ${i}\n`);
  const left = (await snapshotsIn(f.output)).filter(name => name !== snapshotName(-1));
  assert.equal(left.length, 64, 'the newest 64 automatic snapshots are kept');
  assert.equal(left[0], snapshotName(236));
  assert.equal(left.at(-1), snapshotName(299));
  assert.equal(await fs.readFile(named, 'utf8'), 'picture');
  assert.equal(await fs.readFile(kept, 'utf8'), 'a snapshot the person named');
  assert.equal(await fs.readFile(path.join(f.output, 'download-1-report.txt'), 'utf8'), 'report');
  assert.deepEqual(budget.takeUnsavedSnapshots(), []);
  // Room is left for what the person asks for next.
  const next = path.join(f.root, 'next.png');
  budget.addOutput(next); await fs.writeFile(next, 'second picture');
  // The index names only what is there.
  const index = JSON.parse(await fs.readFile(path.join(f.root, '.toolsengine-runtime', 'artifact-index.json'), 'utf8'));
  assert.equal(index.length, 64 + 4);
  for (const row of index) await fs.stat(path.join(f.root, row.path));
});

test('an automatic snapshot that cannot be saved is skipped and reported, and the call does not fail', async t => {
  const f = await fixture(t);
  // Quota full of the person's own files: there is no older snapshot to remove.
  await fs.writeFile(path.join(f.output, 'mine-1.txt'), 'one');
  await fs.writeFile(path.join(f.output, 'mine-2.txt'), 'two');
  const budget = await f.open({ ...ARTIFACT_LIMITS, files: 2 });
  const snapshot = path.join(f.output, snapshotName(0));
  await fs.writeFile(snapshot, 'page');
  await assert.rejects(fs.stat(snapshot), /ENOENT/);
  const [quota] = budget.takeUnsavedSnapshots();
  assert.equal(quota.name, snapshotName(0));
  assert.match(quota.reason, /limit/);
  assert.doesNotMatch(quota.reason, new RegExp(f.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual((await fs.readdir(f.output)).sort(), ['mine-1.txt', 'mine-2.txt']);
  // A file the person asked for is still refused: nothing was saved.
  await assert.rejects(fs.writeFile(path.join(f.output, 'asked-for.png'), 'x'), /limit.*nothing was saved/);
});

test('a held output lock skips the automatic snapshot after a short wait, and still refuses a file the person asked for', async t => {
  const f = await fixture(t);
  const budget = await f.open();
  const lock = path.join(f.root, '.toolsengine-runtime', 'artifact-write.lock');
  await fs.writeFile(lock, '');
  const began = Date.now();
  const snapshot = path.join(f.output, snapshotName(0));
  await fs.writeFile(snapshot, 'page');
  assert.ok(Date.now() - began < 10000);
  await assert.rejects(fs.stat(snapshot), /ENOENT/);
  const [held] = budget.takeUnsavedSnapshots();
  assert.match(held.reason, /artifact-write\.lock/);
  // A lock that is still the same one is not waited for again.
  const again = Date.now();
  await fs.writeFile(path.join(f.output, snapshotName(1)), 'page');
  assert.ok(Date.now() - again < 1000, 'the same leftover lock is not waited for at every call');
  assert.equal(budget.takeUnsavedSnapshots().length, 1);
  const asked = path.join(f.root, 'asked.png');
  budget.addOutput(asked);
  await assert.rejects(fs.writeFile(asked, 'x'), /artifact-write\.lock.*nothing was saved/);
  // Once the other writer is done, snapshots are saved again.
  await fs.unlink(lock);
  await fs.writeFile(path.join(f.output, snapshotName(2)), 'page');
  assert.equal(await fs.readFile(path.join(f.output, snapshotName(2)), 'utf8'), 'page');
  assert.deepEqual(budget.takeUnsavedSnapshots(), []);
});

test('a lock that another writer holds briefly is waited for, not refused', async t => {
  const f = await fixture(t);
  const budget = await f.open();
  const lock = path.join(f.root, '.toolsengine-runtime', 'artifact-write.lock');
  await fs.writeFile(lock, '');
  setTimeout(() => { fs.unlink(lock).catch(() => {}); }, 300);
  const asked = path.join(f.root, 'asked.png');
  budget.addOutput(asked);
  await fs.writeFile(asked, 'picture');
  assert.equal(await fs.readFile(asked, 'utf8'), 'picture');
});

test('a workspace that an earlier version filled with snapshots is trimmed when the server starts', async t => {
  const f = await fixture(t);
  // As 0.1.5 left it: 250 automatic snapshots in the index as plain artifacts,
  // beside a file the person put there, which is not in the index.
  const rows = [];
  for (let i = 0; i < 250; i++) {
    await fs.writeFile(path.join(f.output, snapshotName(i)), 'old');
    rows.push({ path: path.join('artifacts', 'toolsengine', snapshotName(i)), kind: 'artifact' });
  }
  const placed = path.join(f.output, snapshotName(-5));
  await fs.writeFile(placed, 'placed by hand, not written by ToolsEngine');
  await fs.writeFile(path.join(f.root, '.toolsengine-runtime', 'artifact-index.json'), JSON.stringify(rows));
  const budget = await f.open();
  const left = await snapshotsIn(f.output);
  assert.equal(left.length, 64 + 1);
  assert.equal(left[0], snapshotName(-5), 'a snapshot-named file that is not in the index is never removed');
  assert.equal(left[1], snapshotName(186));
  assert.equal(left.at(-1), snapshotName(249));
  // The person can save again at once.
  const asked = path.join(f.root, 'asked.png');
  budget.addOutput(asked); await fs.writeFile(asked, 'x');
});

test('the browser answer says the action was carried out and only the snapshot file was not saved', () => {
  const name = snapshotName(0);
  const result = { content: [{ type: 'text', text: `### Ran Playwright code\n### Page\n- Page URL: http://127.0.0.1/\n### Snapshot\n- [Snapshot](artifacts/toolsengine/${name})` }] };
  const reported = reportUnsavedSnapshots(result, [{ name, reason: 'the saved-output limit is reached' }]);
  assert.notEqual(reported.isError, true);
  const text = reported.content.map(part => part.text).join('\n');
  assert.doesNotMatch(text, /\[Snapshot\]\(/, 'no link to a file that does not exist');
  assert.match(text, /The action was carried out/);
  assert.match(text, /Do not repeat the action/);
  assert.match(text, /the saved-output limit is reached/);
  assert.match(text, /browser\.snapshot/);
  const failed = reportUnsavedSnapshots({ isError: true, content: [{ type: 'text', text: '### Error\nError: something else' }] }, [{ name, reason: 'busy' }]);
  assert.equal(failed.isError, true);
  assert.doesNotMatch(failed.content.map(part => part.text).join('\n'), /was carried out/);
});

test('older snapshots are not deleted for a new one that would be refused anyway', async t => {
  const f = await fixture(t);
  const budget = await f.open({ ...ARTIFACT_LIMITS, files: 8, bytes: 4096, fileBytes: 1024 });
  for (let i = 0; i < 2; i++) await fs.writeFile(path.join(f.output, snapshotName(i)), 'small');
  // Larger than a file may be.
  await fs.writeFile(path.join(f.output, snapshotName(2)), 'x'.repeat(2000));
  assert.deepEqual(await snapshotsIn(f.output), [snapshotName(0), snapshotName(1)]);
  assert.match(budget.takeUnsavedSnapshots()[0].reason, /limit/);
  // A file put there by other means takes the bytes: there is no room even
  // with both older snapshots gone.
  writeFileSync(path.join(f.output, 'put-there.bin'), Buffer.alloc(4095));
  await fs.writeFile(path.join(f.output, snapshotName(3)), 'small');
  assert.deepEqual(await snapshotsIn(f.output), [snapshotName(0), snapshotName(1)]);
  assert.match(budget.takeUnsavedSnapshots()[0].reason, /limit/);
});
