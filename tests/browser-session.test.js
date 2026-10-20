import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  chooseAgentBrowserSession,
  bindBrowserActions,
  agentBrowserStatus,
  agentBrowserHelperEnv,
  agentFirefoxProfileDir,
  AGENT_BROWSER_ACTIONS,
} from '../src/browser-session.js';
import { createFirefoxBrowserBridge } from '../src/firefox.js';

function helperProcess() {
  const helper = new EventEmitter();
  helper.stdin = new PassThrough();
  helper.stdout = new PassThrough();
  helper.stderr = new PassThrough();
  helper.kill = () => {};
  const calls = [];
  let buffer = '';
  helper.stdin.on('data', chunk => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const i = buffer.indexOf('\n');
      const request = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      calls.push(request);
      const result = request.op === 'tabs'
        ? [{ id: 'tab1', title: 'Fixture page', url: 'https://fixture.example/page', window: '1:0' }]
        : request.op === 'snapshot'
          ? 'Page URL: https://fixture.example/page\nPage Title: Fixture page'
          : request.op === 'screenshot'
            ? { image: 'png-hidden' }
            : request.op === 'click'
              ? 'clicked-hidden'
              : request.op === 'type'
                ? 'typed-hidden'
                : 'ok';
      helper.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    }
  });
  return { helper, calls };
}

test('default session is a hidden window and the visible screen is not selected', () => {
  const session = chooseAgentBrowserSession();
  const status = agentBrowserStatus({ firefoxDesktop: true, visibleDisplay: ':0', visibleWindow: 'owner-firefox' });
  assert.equal(session.target, 'hidden-window');
  assert.equal(session.usesVisibleScreen, false);
  assert.equal(session.selectedVisibleDisplay, null);
  assert.equal(session.selectedVisibleWindow, null);
  assert.equal(session.display, 'hidden');
  assert.notEqual(session.display, ':0');
  assert.equal(status.browserSession, 'hidden-window');
  assert.equal(status.browserWindowVisibility, 'hidden');
  assert.equal(status.browserUsesVisibleScreen, false);
  assert.equal(status.browserRejectedVisibleDisplay, ':0');
  assert.equal(status.browserRejectedVisibleWindow, 'owner-firefox');
  assert.equal(status.browserAuthSharing, 'dedicated-profile-only');
  console.log('ASSERT default-target=hidden-window');
  console.log('ASSERT visible-display-selected=false');
  console.log('ASSERT visible-window-selected=false');
  console.log(`ASSERT status-session=${status.browserSession}`);
});

test('unavailable hidden displays do not claim an unimplemented VM fallback', () => {
  assert.equal(chooseAgentBrowserSession({hiddenWindow:{available:true},vm:{available:true}}).target,'hidden-window');
  assert.throws(()=>chooseAgentBrowserSession({hiddenWindow:{available:false},vm:{available:true}}),/no virtual-machine backend/);
  assert.throws(()=>chooseAgentBrowserSession({hiddenWindow:{display:':0.0'},visibleDisplay:':0'}),/visible display/);
});

test('browser actions bind to the hidden session and not the visible display', async t => {
  const visible = ':0';
  const { helper, calls } = helperProcess();
  let spawned = null;
  const bridge = await createFirefoxBrowserBridge(
    { visibleDisplay: visible, visibleWindow: 'owner-firefox' },
    {
      spawnHelper: (command, args, options) => {
        spawned = { command, args, options };
        return helper;
      },
    },
  );
  t.after(() => bridge.close());
  assert.equal(bridge.session.target, 'hidden-window');
  assert.equal(bridge.session.usesVisibleScreen, false);
  assert.notEqual(spawned.options.env.DISPLAY, visible);
  assert.equal(spawned.options.env.TOOLSENGINE_BROWSER_TARGET, 'hidden-window');
  assert.equal(spawned.options.env.TOOLSENGINE_VISIBLE_DISPLAY, visible);
  const boundNames = bridge.binding.map(item => item.name);
  for (const name of AGENT_BROWSER_ACTIONS) assert.ok(boundNames.includes(name), name);
  for (const item of bridge.binding) {
    assert.equal(item.target, 'hidden-window');
    assert.equal(item.usesVisibleScreen, false);
    assert.notEqual(item.display, visible);
  }
  for (const tool of bridge.tools) {
    assert.equal(tool.sessionTarget, 'hidden-window');
    assert.equal(tool.usesVisibleScreen, false);
    assert.match(tool.description, /hidden Firefox window/);
    assert.doesNotMatch(tool.description, /owner's own signed-in Firefox/);
  }
  const navigate = bridge.tools.find(tool => tool.name === 'browser.navigate');
  const snapshot = bridge.tools.find(tool => tool.name === 'browser.snapshot');
  const tabs = bridge.tools.find(tool => tool.name === 'browser.tabs');
  const click = bridge.tools.find(tool => tool.name === 'browser.click');
  const type = bridge.tools.find(tool => tool.name === 'browser.type');
  const screenshot = bridge.tools.find(tool => tool.name === 'browser.take_screenshot');
  const navigated = await navigate.handler({ url: 'https://fixture.example/page' });
  assert.match(navigated.content[0].text, /ok|fixture|https:\/\/fixture\.example\/page/);
  const shot = await snapshot.handler({});
  assert.match(shot.content[0].text, /Fixture page/);
  await tabs.handler({ action: 'list' });
  const clicked = await click.handler({ ref: 'fixture-ref' });
  assert.match(clicked.content[0].text, /clicked-hidden/);
  const typed = await type.handler({ ref: 'fixture-ref', text: 'hello' });
  assert.match(typed.content[0].text, /typed-hidden/);
  const image = await screenshot.handler();
  assert.equal(image.content[0].type, 'image');
  assert.equal(image.content[0].data, 'png-hidden');
  assert.equal(image.content[0].mimeType, 'image/png');
  assert.equal(calls[0].sessionTarget, 'hidden-window');
  assert.equal(calls[0].display, 'hidden');
  assert.notEqual(calls[0].display, visible);
  assert.ok(calls.some(call => call.op === 'snapshot' && call.sessionTarget === 'hidden-window'));
  const agentProfile = agentFirefoxProfileDir();
  assert.equal(bridge.agentProfileDir, agentProfile);
  assert.equal(spawned.options.env.TOOLSENGINE_FIREFOX_PROFILE, agentProfile);
  for (const name of ['browser.click', 'browser.type', 'browser.take_screenshot']) {
    const item = bridge.binding.find(bound => bound.name === name);
    assert.equal(item.target, 'hidden-window');
    assert.equal(item.usesVisibleScreen, false);
    assert.equal(item.profile, agentProfile);
    assert.notEqual(item.display, visible);
  }
  for (const op of ['click', 'type', 'screenshot']) {
    const call = calls.find(item => item.op === op);
    assert.ok(call, op);
    assert.equal(call.sessionTarget, 'hidden-window');
    assert.equal(call.profile, agentProfile);
    assert.notEqual(call.display, visible);
    assert.notEqual(call.display, spawned.options.env.TOOLSENGINE_VISIBLE_DISPLAY);
  }
  assert.equal(calls.find(call => call.op === 'click').ref, 'fixture-ref');
  assert.equal(calls.find(call => call.op === 'type').text, 'hello');
  assert.equal(calls.find(call => call.op === 'type').profile, calls.find(call => call.op === 'click').profile);
  assert.equal(calls.find(call => call.op === 'screenshot').profile, calls.find(call => call.op === 'click').profile);
  assert.throws(()=>chooseAgentBrowserSession({hiddenWindow:{available:false},visibleDisplay:visible}),/no virtual-machine backend/);
  const env = agentBrowserHelperEnv(bridge.session, { DISPLAY: visible, PATH: '/usr/bin' }, '/tmp/agent-profile');
  assert.notEqual(env.DISPLAY, visible);
  assert.equal(env.TOOLSENGINE_BROWSER_TARGET, 'hidden-window');
  console.log('ASSERT browser-actions-bound-to=hidden-window');
  console.log(`ASSERT action-ops=${calls.map(call => call.op).join(',')}`);
  console.log('ASSERT click-bound-to=hidden-window');
  console.log('ASSERT type-bound-to=hidden-window');
  console.log('ASSERT screenshot-bound-to=hidden-window');
  console.log('ASSERT click-type-screenshot-same-profile=true');
  console.log('ASSERT click-type-screenshot-not-visible-display=true');
  console.log('ASSERT helper-display-is-not-visible=true');
});
