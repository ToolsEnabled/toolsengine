import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { browserCapabilityStatus, createToolsEngine } from '../src/server.js';

// browserSandbox is the setting the server asks for, not something it has
// looked at: like the connection and the sign-in, it is never "verified".
const common = {
  browserSandboxVerified: false,
  browserConnectionVerified: false,
  browserAuthenticationVerified: false,
};

test('browser status distinguishes disabled and isolated headless/headed sessions', () => {
  assert.deepEqual(browserCapabilityStatus({ headless: true }, false), {
    browserEnabled: false,
    browserMode: 'disabled',
    browserSession: 'none',
    browserLaunchState: 'not-applicable',
    headless: null,
    browserWindowMode: 'none',
    browserWindowVisibility: 'not-applicable',
    browserAuthSharing: 'none',
    browserSandbox: null,
    ...common,
  });
  assert.deepEqual(browserCapabilityStatus({ headless: true }, true), {
    browserEnabled: true,
    browserMode: 'isolated',
    browserSession: 'dedicated-ephemeral-profile',
    browserLaunchState: 'not-probed',
    headless: true,
    browserWindowMode: 'headless',
    browserWindowVisibility: 'not-visible',
    browserAuthSharing: 'none',
    browserSandbox: true,
    ...common,
  });
  assert.deepEqual(browserCapabilityStatus({ headless: false }, true), {
    browserEnabled: true,
    browserMode: 'isolated',
    browserSession: 'dedicated-ephemeral-profile',
    browserLaunchState: 'not-probed',
    headless: false,
    browserWindowMode: 'headed',
    browserWindowVisibility: 'visible-when-launched',
    browserAuthSharing: 'none',
    browserSandbox: true,
    ...common,
  });
});

test('browser status distinguishes dedicated persistent headless/headed sessions', () => {
  for (const headless of [true, false]) {
    assert.deepEqual(browserCapabilityStatus({ profileDir: 'configured', headless }, true), {
      browserEnabled: true,
      browserMode: 'dedicated-persistent',
      browserSession: 'dedicated-persistent-profile',
      browserLaunchState: 'not-probed',
      headless,
      browserWindowMode: headless ? 'headless' : 'headed',
      browserWindowVisibility: headless ? 'not-visible' : 'visible-when-launched',
      browserAuthSharing: 'dedicated-profile-only',
      browserSandbox: true,
      ...common,
    });
  }
});

test('the sandbox is reported on for a browser the server starts, off only when it was switched off, and unknown otherwise', async t => {
  // What is reported is the request, and the tool says so.
  const engine = await createToolsEngine({ workspace: process.cwd(), browser: false, headless: true });
  t.after(() => engine.close());
  assert.match(engine.tools.find(tool => tool.name === 'system.status').description, /browserSandbox is the setting the server asks for when it starts a browser, not a check of a running browser\./);
  for (const config of [{ headless: true }, { headless: true, browserSandbox: false }, { profileDir: 'configured' }, { cdpEndpoint: 'configured' }])
    assert.equal(browserCapabilityStatus(config, true).browserSandboxVerified, false, JSON.stringify(config));
  assert.equal(browserCapabilityStatus({ headless: true, browserSandbox: false }, true).browserSandbox, false);
  assert.equal(browserCapabilityStatus({ profileDir: 'configured', browserSandbox: false }, true).browserSandbox, false);
  assert.equal(browserCapabilityStatus({ headless: true, browserSandbox: undefined }, true).browserSandbox, true);
  assert.equal(browserCapabilityStatus({ cdpEndpoint: 'configured', browserSandbox: false }, true).browserSandbox, null);
  assert.equal(browserCapabilityStatus({ browserSandbox: false }, false).browserSandbox, null);
});

test('attached status does not claim control of visibility, connection or authentication', () => {
  for (const headless of [true, false]) {
    assert.deepEqual(browserCapabilityStatus({ cdpEndpoint: 'configured', headless }, true), {
      browserEnabled: true,
      browserMode: 'attached',
      browserSession: 'attached-existing',
      browserLaunchState: 'external-not-managed',
      headless: null,
      browserWindowMode: 'external',
      browserWindowVisibility: 'not-verified',
      browserAuthSharing: 'selected-existing-session',
      browserSandbox: null,
      ...common,
    });
  }
});

test('system.status returns the capability metadata without starting a browser', async t => {
  const engine = await createToolsEngine({ workspace: process.cwd(), browser: false, headless: true });
  t.after(() => engine.close());
  const result = await engine.call('system.status', {});
  assert.equal(result.isError, undefined);
  const status = JSON.parse(result.content[0].text);
  assert.equal(status.version, '0.1.9-rc.1');
  assert.deepEqual({
    browserEnabled: status.browserEnabled,
    browserMode: status.browserMode,
    browserSession: status.browserSession,
    browserLaunchState: status.browserLaunchState,
    headless: status.headless,
    browserWindowMode: status.browserWindowMode,
    browserWindowVisibility: status.browserWindowVisibility,
    browserAuthSharing: status.browserAuthSharing,
    browserSandboxVerified: status.browserSandboxVerified,
    browserConnectionVerified: status.browserConnectionVerified,
    browserAuthenticationVerified: status.browserAuthenticationVerified,
  }, {
    browserEnabled: false,
    browserMode: 'disabled',
    browserSession: 'none',
    browserLaunchState: 'not-applicable',
    headless: null,
    browserWindowMode: 'none',
    browserWindowVisibility: 'not-applicable',
    browserAuthSharing: 'none',
    ...common,
  });
});

test('package, shrinkwrap, runtime status and CLI report release 0.1.9-rc.1', async t => {
  const expected = '0.1.9-rc.1';
  const packageJson = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url)));
  const shrinkwrap = JSON.parse(await fs.readFile(new URL('../npm-shrinkwrap.json', import.meta.url)));
  assert.equal(packageJson.version, expected);
  assert.equal(shrinkwrap.version, expected);
  assert.equal(shrinkwrap.packages[''].version, expected);

  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/toolsengine.js', import.meta.url)), '--version'], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.trim(), `ToolsEngine ${expected}`);

  const engine = await createToolsEngine({ workspace: process.cwd(), browser: false, headless: true });
  t.after(() => engine.close());
  const result = await engine.call('system.status', {});
  assert.equal(JSON.parse(result.content[0].text).version, expected);
});
