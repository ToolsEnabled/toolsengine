// What every offered tool descriptor must state. Used by the package audit and
// by the test suite, so the two cannot drift apart.
import assert from 'node:assert/strict';

export const HINTS = Object.freeze(['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']);

export function assertReviewable(tool) {
  const where = `tool ${tool?.name}`;
  assert.match(tool.name, /^[a-z]+\.[a-z_]+$/, `${where}: name`);
  assert.equal(typeof tool.title, 'string', `${where}: a human-readable title is required`);
  assert.ok(tool.title.trim().length >= 5 && tool.title.length <= 60 && !/[._]/.test(tool.title), `${where}: title "${tool.title}" must read as words, not as an identifier`);
  assert.equal(tool.annotations?.title, tool.title, `${where}: annotations.title must repeat the title`);
  for (const hint of HINTS) assert.equal(typeof tool.annotations[hint], 'boolean', `${where}: ${hint} must be stated, not left to a default`);
  assert.deepEqual(Object.keys(tool.annotations).sort(), ['title', ...HINTS].sort(), `${where}: unexpected annotation`);
  assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), `${where}: a read-only tool cannot be destructive`);
  assert.ok(typeof tool.description === 'string' && tool.description.length >= 60 && tool.description.length <= 2000, `${where}: description length ${tool.description?.length}`);
  // The pinned browser dependency names its tools with an underscore. Those
  // names are not offered and must not appear in text shown to the assistant.
  assert.doesNotMatch(JSON.stringify(tool), /\bbrowser_[a-z_]+\b/, `${where}: names a tool that is not offered`);
  assert.equal(tool.inputSchema?.type, 'object', `${where}: input schema`);
  assert.equal(tool.inputSchema.additionalProperties, false, `${where}: unknown arguments must be refused`);
}

// Statements a reviewer checks first. Each is a fact about what the tool does;
// if the behaviour changes, change the text and this list together.
export const REQUIRED_STATEMENTS = Object.freeze({
  'workspace.write_file': [/replace the entire content/, /destroys the previous content/],
  'workspace.read_file': [/hidden files such as \.env included/],
  'web.fetch': [/site receives the request/],
  'browser.click': [/submit a form/, /purchase/, /delete/, /download that the page starts is saved into artifacts\/toolsengine/, /existing files are preserved/],
  'browser.navigate': [/download that the page starts is saved into artifacts\/toolsengine/, /existing files are preserved/],
  'browser.type': [/sent to its site/, /download that the page starts is saved into artifacts\/toolsengine/],
  'browser.press_key': [/submit a form/, /download that the page starts is saved into artifacts\/toolsengine/],
  'browser.file_upload': [/whole content of each file/, /hand local files to a website/],
  'browser.handle_dialog': [/deletion/, /download that the page starts is saved into artifacts\/toolsengine/],
  'browser.tabs': [/discards its page/, /download that the page starts is saved into artifacts\/toolsengine/],
  'browser.navigate_back': [/download that the page starts is saved into artifacts\/toolsengine/],
  'browser.select_option': [/download that the page starts is saved into artifacts\/toolsengine/],
  'browser.close': [/whole browser/, /every tab/, /not only the current page/],
  'browser.take_screenshot': [/personal data/],
  'desktop.inspect': [/Protected-page rule \(default\)/, /password, passcode, credential, api key, secret, sign in, log in, permission, confirm, approve or accessibility/, /inside a longer word/, /not listed at all/, /says which of those words matched/, /owner startup option --desktop-allow-sign-in/, /a tool call cannot enable it/,
    /Windows of these programs are not listed, going by the program's name/, /PowerShell ISE/, /Other terminal programs, .* are listed like any other app/],
  'desktop.act': [/send, submit, delete or close/, /not that the app did what was intended/, /protected-page rule/, /resized to half the width/],
  'desktop.capture': [/does not redact/, /cannot promise that a captured picture holds no credential/, /protected-page rule/],
  'desktop.pointer': [/real mouse cursor/, /never moves the window/, /--desktop-left-half/, /left half/, /protected-page rule/],
});

export const REQUIRED_HINTS = Object.freeze({
  'workspace.write_file': { readOnlyHint: false, destructiveHint: true },
  'workspace.read_file': { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  'web.fetch': { readOnlyHint: true, openWorldHint: true },
  'browser.click': { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  'browser.type': { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  'browser.file_upload': { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  'browser.close': { readOnlyHint: false, destructiveHint: true },
  'browser.take_screenshot': { readOnlyHint: false, destructiveHint: false },
  'desktop.inspect': { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  'desktop.capture': { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  'desktop.act': { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  'desktop.pointer': { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
});

export function assertStatedEffects(tools) {
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  for (const [name, patterns] of Object.entries(REQUIRED_STATEMENTS)) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is missing from the descriptors under review`);
    for (const pattern of patterns) assert.match(tool.description, pattern, `${name}: the description no longer says ${pattern}`);
  }
  for (const [name, expected] of Object.entries(REQUIRED_HINTS)) {
    const tool = byName.get(name);
    assert.ok(tool, `${name} is missing from the descriptors under review`);
    for (const [hint, value] of Object.entries(expected)) assert.equal(tool.annotations[hint], value, `${name}: ${hint}`);
  }
}
