import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import https from "node:https";
import { Readable } from "node:stream";
import test from "node:test";

import { createWebTools } from "../src/web.js";
import { readFileSync } from "node:fs";

const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function toolMap(options) {
  return Object.fromEntries(createWebTools(options).map((tool) => [tool.name, tool]));
}

function rejectsWithCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function installHttpsMock(t, responses) {
  const calls = [];
  let responseIndex = 0;
  t.mock.method(https, "request", (url, options, callback) => {
    const call = { url: url.href, options, destroyed: false, destroyError: null };
    calls.push(call);
    const request = new EventEmitter();
    let destroyed = false;
    request.end = () => {
      const specification = responses[responseIndex++];
      if (!specification || specification.neverRespond) return;
      queueMicrotask(() => {
        if (destroyed) return;
        if (specification.requestError) {
          request.emit("error", specification.requestError);
          return;
        }
        const response = Readable.from(specification.chunks ?? []);
        // Like http.IncomingMessage: destroying the response emits "aborted"
        // at once, before destroy() returns.
        const destroyResponse = response.destroy.bind(response);
        response.destroy = (error) => {
          if (!response.aborted) { response.aborted = true; response.emit("aborted"); }
          return destroyResponse(error);
        };
        response.statusCode = specification.status ?? 200;
        response.headers = specification.headers ?? { "content-type": "text/plain; charset=utf-8" };
        callback(response);
      });
    };
    request.destroy = (error) => {
      destroyed = true;
      call.destroyed = true;
      call.destroyError = error ?? null;
      if (error) queueMicrotask(() => request.emit("error", error));
    };
    return request;
  });
  return calls;
}

test("web tools expose only the bounded startup-configured contract", () => {
  const tools = toolMap();
  assert.deepEqual(Object.keys(tools), ["web.fetch", "web.extract"]);
  assert.equal(tools["web.fetch"].inputSchema.additionalProperties, false);
  assert.equal("allowLocalNetwork" in tools["web.fetch"].inputSchema.properties, false);
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.handler, "function");
    assert.equal(typeof tool.annotations, "object");
  }
});

test("web.fetch accepts bounded HTTPS JSON without exposing cookies or credentials", async (t) => {
  const calls = installHttpsMock(t, [
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-length": "17",
        "set-cookie": "session=not-returned",
      },
      chunks: ["{\"ok\":true,\"n\":1}"],
    },
  ]);
  const result = await toolMap()["web.fetch"].handler({ url: "https://example.com/data" });

  assert.equal(result.status, 200);
  assert.equal(result.body, '{"ok":true,"n":1}');
  assert.deepEqual(result.json, { ok: true, n: 1 });
  assert.equal("headers" in result, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.method, "GET");
  assert.equal("cookie" in calls[0].options.headers, false);
  assert.equal("authorization" in calls[0].options.headers, false);
  // The site is told which version asked: the package version, not a fixed "0.1".
  assert.equal(calls[0].options.headers["user-agent"], `ToolsEngine/${PACKAGE_VERSION}`);
  // The certificate check is asked for by name. Left to Node's default, it is
  // switched off by NODE_TLS_REJECT_UNAUTHORIZED=0 in the server's environment.
  assert.equal(calls[0].options.rejectUnauthorized, true);
});

test("web.fetch blocks local networks unless enabled at construction", async (t) => {
  const calls = installHttpsMock(t, [
    { headers: { "content-type": "text/plain" }, chunks: ["local test"] },
  ]);
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://127.0.0.1/private" }),
    rejectsWithCode("LOCAL_NETWORK_BLOCKED"),
  );
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://example.com", allowLocalNetwork: true }),
    rejectsWithCode("INVALID_INPUT"),
  );
  assert.equal(calls.length, 0);

  const result = await toolMap({ allowLocalNetwork: true })["web.fetch"].handler({
    url: "https://127.0.0.1/test",
  });
  assert.equal(result.body, "local test");
  assert.equal(calls.length, 1);
});

test("web.fetch revalidates every redirect and rejects downgrade or local targets", async (t) => {
  const calls = installHttpsMock(t, [
    { status: 302, headers: { location: "https://next.example/final" } },
    { status: 200, headers: { "content-type": "text/plain" }, chunks: ["done"] },
  ]);
  const result = await toolMap()["web.fetch"].handler({ url: "https://example.com/start" });
  assert.equal(result.body, "done");
  assert.equal(result.redirects.length, 1);
  assert.equal(result.redirects[0].to, "https://next.example/final");
  assert.deepEqual(calls.map((call) => call.url), [
    "https://example.com/start",
    "https://next.example/final",
  ]);

  t.mock.restoreAll();
  const downgradeCalls = installHttpsMock(t, [
    { status: 302, headers: { location: "http://example.com/plain" } },
  ]);
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://example.com/start" }),
    rejectsWithCode("HTTPS_REQUIRED"),
  );
  assert.equal(downgradeCalls.length, 1);

  t.mock.restoreAll();
  const localCalls = installHttpsMock(t, [
    { status: 307, headers: { location: "https://127.0.0.1/internal" } },
  ]);
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://example.com/start" }),
    rejectsWithCode("LOCAL_NETWORK_BLOCKED"),
  );
  assert.equal(localCalls.length, 1);
});

test("web.fetch caps redirects", async (t) => {
  const responses = Array.from({ length: 6 }, (_, index) => ({
    status: 302,
    headers: { location: `https://example.com/step-${index + 1}` },
  }));
  const calls = installHttpsMock(t, responses);
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://example.com/start" }),
    rejectsWithCode("TOO_MANY_REDIRECTS"),
  );
  assert.equal(calls.length, 6);
});

test("web.fetch enforces status, content type, body, UTF-8, and JSON response checks", async (t) => {
  const scenarios = [
    {
      response: { status: 404, headers: { "content-type": "text/plain" }, chunks: ["missing"] },
      code: "HTTP_STATUS",
    },
    {
      response: { headers: { "content-type": "application/octet-stream" }, chunks: ["binary"] },
      code: "CONTENT_TYPE_REJECTED",
    },
    {
      // No Content-Length (a chunked body): the limit is met while reading.
      response: { headers: { "content-type": "text/plain" }, chunks: ["12345", "67890"] },
      args: { maxBytes: 8 },
      code: "RESPONSE_TOO_LARGE",
    },
    {
      // Content-Length already over the limit: refused before reading.
      response: { headers: { "content-type": "text/plain", "content-length": "10" }, chunks: ["12345", "67890"] },
      args: { maxBytes: 8 },
      code: "RESPONSE_TOO_LARGE",
    },
    {
      response: { headers: { "content-type": "text/plain" }, chunks: [Buffer.from([0xc3, 0x28])] },
      code: "INVALID_UTF8",
    },
    {
      response: { headers: { "content-type": "application/json" }, chunks: ["{broken"] },
      code: "INVALID_JSON",
    },
  ];

  for (const scenario of scenarios) {
    t.mock.restoreAll();
    installHttpsMock(t, [scenario.response]);
    await assert.rejects(
      toolMap()["web.fetch"].handler({ url: "https://example.com/test", ...scenario.args }),
      rejectsWithCode(scenario.code),
    );
  }
});

test("web.fetch applies an end-to-end timeout", async (t) => {
  const calls = installHttpsMock(t, [{ neverRespond: true }]);
  const started = performance.now();
  await assert.rejects(
    toolMap()["web.fetch"].handler({ url: "https://example.com/slow", timeoutMs: 100 }),
    rejectsWithCode("FETCH_TIMEOUT"),
  );
  assert.ok(performance.now() - started < 2_000);
  assert.equal(calls[0].destroyed, true);
  assert.equal(calls[0].destroyError?.code, "FETCH_TIMEOUT");
});

test("web.fetch timeout keeps an otherwise idle process alive until rejection", { timeout: 5_000 }, async () => {
  const moduleUrl = new URL("../src/web.js", import.meta.url).href;
  const script = `
    import { EventEmitter } from "node:events";
    import https from "node:https";
    import { createWebTools } from ${JSON.stringify(moduleUrl)};
    https.request = () => {
      const request = new EventEmitter();
      request.end = () => {};
      request.destroy = error => queueMicrotask(() => request.emit("error", error));
      return request;
    };
    const fetch = createWebTools().find(tool => tool.name === "web.fetch");
    try {
      await fetch.handler({ url: "https://example.com/slow", timeoutMs: 100 });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(String(error.code));
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual({ code, signal, stdout, stderr }, {
    code: 0,
    signal: null,
    stdout: "FETCH_TIMEOUT",
    stderr: "",
  });
});

test("web.extract produces readable text and safe resolved links without script content", async () => {
  const html = `
    <!doctype html>
    <style>.hidden { display:none }</style>
    <h1>Example &amp; Test</h1>
    <p>Hello <strong>portable</strong> world.</p>
    <script>globalThis.compromised = true</script>
    <a href="/guide?q=1&amp;x=2"> Read the guide </a>
    <a href="https://other.example/page">Other site</a>
    <a href="javascript:alert(1)">Unsafe</a>
  `;
  const result = await toolMap()["web.extract"].handler({
    html,
    baseUrl: "https://example.com/docs/index.html",
  });

  assert.match(result.text, /Example & Test/);
  assert.match(result.text, /Hello portable world\./);
  assert.doesNotMatch(result.text, /display:none|compromised/);
  assert.deepEqual(result.links, [
    { href: "https://example.com/guide?q=1&x=2", text: "Read the guide" },
    { href: "https://other.example/page", text: "Other site" },
  ]);
});

// "İ" (U+0130) is one character, and two in lower case. The end of a script
// or a style was looked for in a lower-cased copy of the page and then used
// as a position in the page itself, so on a Turkish page script source came
// out as text and visible text after a style was dropped.
test("web.extract finds the end of a script or a style on a page that contains İ", async () => {
  const extract = toolMap()["web.extract"].handler;
  const menu = await extract({
    html: '<nav>İLETİŞİM GİRİŞ İLETİŞİM GİRİŞ</nav><script>function gtag(){dataLayer.push(arguments)}</script><p>Hello world</p>',
  });
  assert.match(menu.text, /İLETİŞİM GİRİŞ/);
  assert.match(menu.text, /Hello world/);
  assert.doesNotMatch(menu.text, /gtag|dataLayer/);
  const many = await extract({
    html: `<p>${"İ".repeat(30)}</p><style>p { color: red }</style><p>Hello world</p><p>Second</p><p>Tail text</p>`,
  });
  assert.match(many.text, /Hello world\nSecond\nTail text/);
  assert.doesNotMatch(many.text, /color/);
});

test("web.extract declares text, link, and HTML bounds", async () => {
  const extract = toolMap()["web.extract"].handler;
  const result = await extract({
    html: '<p>abcdefghij</p><a href="https://one.example">one</a><a href="https://two.example">two</a>',
    maxTextCharacters: 5,
    maxLinks: 1,
  });
  assert.equal(result.text.length, 5);
  assert.deepEqual(result.truncated, { text: true, links: true });
  assert.equal(result.links.length, 1);
  assert.equal(result.limits.maxHtmlBytes, 1_048_576);

  await assert.rejects(
    extract({ html: "é".repeat(524_289) }),
    rejectsWithCode("HTML_TOO_LARGE"),
  );
});
