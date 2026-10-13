import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createWorkspaceTools } from "../src/workspace.js";

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "toolsengine-workspace-"));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  t.after(async () => {
    await rm(base, { force: true, recursive: true });
  });
  const tools = Object.fromEntries(createWorkspaceTools({ workspace }).map((tool) => [tool.name, tool]));
  return { base, tools, workspace };
}

async function hardlinkFixture(t) {
  const result = await fixture(t);
  const outside = path.join(result.base, "outside.txt");
  await writeFile(outside, "outside hard-link content");
  try {
    await link(outside, path.join(result.workspace, "alias.txt"));
  } catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP", "EXDEV"].includes(error?.code)) {
      t.skip(`platform refused hard-link fixture (${error.code})`);
      return null;
    }
    throw error;
  }
  return { ...result, outside };
}

function rejectsWithCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("workspace tools expose the portable handler contract", async (t) => {
  const { tools } = await fixture(t);
  assert.deepEqual(Object.keys(tools), [
    "workspace.list",
    "workspace.read_file",
    "workspace.write_file",
    "workspace.search",
  ]);
  for (const tool of Object.values(tools)) {
    assert.equal(typeof tool.description, "string");
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.annotations, "object");
    assert.equal(typeof tool.handler, "function");
  }
});

test("a missing folder or file is said in plain words, without the system error", async (t) => {
  const { tools, workspace } = await fixture(t);
  const plain = (pattern) => (error) => {
    assert.match(error.message, pattern);
    assert.doesNotMatch(error.message, /ENOENT|lstat|no such file/);
    assert.ok(!error.message.includes(workspace), error.message);
    return true;
  };
  await assert.rejects(tools["workspace.write_file"].handler({ path: "notes/a.txt", content: "x" }),
    plain(/^The folder notes does not exist in the workspace\. workspace\.write_file does not create folders/));
  await assert.rejects(tools["workspace.write_file"].handler({ path: "notes/deeper/a.txt", content: "x" }),
    plain(/^The folder notes\/deeper does not exist in the workspace/));
  await assert.rejects(tools["workspace.read_file"].handler({ path: "missing.txt" }),
    plain(/^missing\.txt does not exist in the workspace\./));
  await assert.rejects(tools["workspace.list"].handler({ path: "nowhere" }),
    plain(/^nowhere does not exist in the workspace\./));
  // Once the folder exists the same call works.
  await mkdir(path.join(workspace, "notes"));
  await tools["workspace.write_file"].handler({ path: "notes/a.txt", content: "x" });
  assert.equal(await readFile(path.join(workspace, "notes", "a.txt"), "utf8"), "x");
});

test("workspace paths reject traversal and absolute forms", async (t) => {
  const { base, tools, workspace } = await fixture(t);
  await writeFile(path.join(base, "outside.txt"), "outside");
  await writeFile(path.join(workspace, "inside.txt"), "inside");

  for (const rejectedPath of ["../outside.txt", "sub/../../outside.txt", path.join(base, "outside.txt"), "C:\\Windows\\win.ini", "C:win.ini"]) {
    await assert.rejects(
      tools["workspace.read_file"].handler({ path: rejectedPath }),
      rejectsWithCode("PATH_OUTSIDE_WORKSPACE"),
    );
  }

});

test("workspace.read_file rejects file symlinks when the platform permits the fixture", async (t) => {
  const { base, tools, workspace } = await fixture(t);
  await writeFile(path.join(base, "outside.txt"), "outside");
  try {
    await symlink(path.join(base, "outside.txt"), path.join(workspace, "outside-link.txt"), "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`platform refused file-symlink fixture (${error.code})`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    tools["workspace.read_file"].handler({ path: "outside-link.txt" }),
    rejectsWithCode("SYMLINK_REJECTED"),
  );
});

test("workspace root rejects a directory junction independently of file-symlink support", async (t) => {
  const { base, workspace } = await fixture(t);
  const linkedRoot = path.join(base, "linked-root");
  try {
    await symlink(workspace, linkedRoot, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`platform refused directory-junction fixture (${error.code})`);
      return;
    }
    throw error;
  }
  const linkedTools = Object.fromEntries(createWorkspaceTools({ workspace: linkedRoot }).map((tool) => [tool.name, tool]));
  await assert.rejects(
    linkedTools["workspace.list"].handler({}),
    rejectsWithCode("SYMLINK_REJECTED"),
  );
});

test("workspace.read_file rejects hard-linked file aliases", async (t) => {
  const result = await hardlinkFixture(t);
  if (!result) return;
  await assert.rejects(
    result.tools["workspace.read_file"].handler({ path: "alias.txt" }),
    rejectsWithCode("HARDLINK_REJECTED"),
  );
});

test("workspace.write_file refuses to inspect or overwrite hard-linked aliases", async (t) => {
  const result = await hardlinkFixture(t);
  if (!result) return;
  await assert.rejects(
    result.tools["workspace.write_file"].handler({
      path: "alias.txt",
      content: "replacement",
      expectedSha256: "0".repeat(64),
    }),
    rejectsWithCode("HARDLINK_REJECTED"),
  );
  assert.equal(await readFile(result.outside, "utf8"), "outside hard-link content");
});

test("workspace.search skips and reports hard-linked aliases", async (t) => {
  const result = await hardlinkFixture(t);
  if (!result) return;
  const search = await result.tools["workspace.search"].handler({ query: "hard-link" });
  assert.deepEqual(search.matches, []);
  assert.equal(search.skipped.hardlinkedFiles, 1);
});

test("workspace.write_file creates atomically and refuses stale or unconditional overwrites", async (t) => {
  const { tools, workspace } = await fixture(t);
  const write = tools["workspace.write_file"].handler;
  const read = tools["workspace.read_file"].handler;

  const created = await write({ path: "notes.txt", content: "first" });
  assert.equal(created.created, true);
  assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "first");

  await assert.rejects(
    write({ path: "notes.txt", content: "unconditional" }),
    rejectsWithCode("PRECONDITION_REQUIRED"),
  );

  const firstRead = await read({ path: "notes.txt" });
  await writeFile(path.join(workspace, "notes.txt"), "external change");
  await assert.rejects(
    write({ path: "notes.txt", content: "lost update", expectedSha256: firstRead.sha256 }),
    rejectsWithCode("STALE_WRITE"),
  );
  assert.equal(await readFile(path.join(workspace, "notes.txt"), "utf8"), "external change");

  const current = await read({ path: "notes.txt" });
  const replaced = await write({
    path: "notes.txt",
    content: "replacement",
    expectedSha256: current.sha256,
  });
  assert.equal(replaced.created, false);
  assert.equal((await read({ path: "notes.txt" })).content, "replacement");
  assert.deepEqual(
    (await readdir(workspace)).filter((name) => name.includes(".toolsengine-")),
    [],
  );
});

test("workspace reads and writes enforce byte and UTF-8 bounds", async (t) => {
  const { tools, workspace } = await fixture(t);
  await writeFile(path.join(workspace, "large.txt"), Buffer.alloc(1_048_577, 0x61));
  await writeFile(path.join(workspace, "binary.txt"), Buffer.from([0xc3, 0x28]));

  await assert.rejects(
    tools["workspace.read_file"].handler({ path: "large.txt" }),
    rejectsWithCode("FILE_TOO_LARGE"),
  );
  await assert.rejects(
    tools["workspace.read_file"].handler({ path: "binary.txt" }),
    rejectsWithCode("INVALID_UTF8"),
  );
  await assert.rejects(
    tools["workspace.write_file"].handler({ path: "too-large.txt", content: "é".repeat(524_289) }),
    rejectsWithCode("FILE_TOO_LARGE"),
  );
});

test("workspace.search is literal, bounded, and reports hidden/link skips", async (t) => {
  const { base, tools, workspace } = await fixture(t);
  await mkdir(path.join(workspace, "visible"));
  await mkdir(path.join(workspace, ".hidden"));
  await writeFile(path.join(workspace, "visible", "one.txt"), "Needle .* Needle\nsecond needle");
  await writeFile(path.join(workspace, "visible", "large.txt"), "Needle in a file over the selected cap");
  await writeFile(path.join(workspace, ".hidden", "secret.txt"), "Needle must not be searched");
  await mkdir(path.join(base, "outside-dir"));
  await writeFile(path.join(base, "outside-dir", "outside.txt"), "Needle must not escape");

  let linkCreated = true;
  try {
    await symlink(
      path.join(base, "outside-dir"),
      path.join(workspace, "outside-dir-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      linkCreated = false;
      t.diagnostic(`symlink skip count assertion skipped: platform refused test link (${error.code})`);
    } else {
      throw error;
    }
  }

  const bounded = await tools["workspace.search"].handler({
    query: "Needle .*",
    maxResults: 1,
  });
  assert.equal(bounded.matches.length, 1);
  assert.equal(bounded.matches[0].path, "visible/one.txt");
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.truncationReasons.includes("result_limit"));

  const caseInsensitive = await tools["workspace.search"].handler({
    query: "needle",
    caseSensitive: false,
    maxResults: 10,
  });
  assert.ok(caseInsensitive.matches.every((match) => !match.path.includes(".hidden")));
  assert.ok(caseInsensitive.matches.every((match) => !match.path.includes("outside-dir-link")));
  assert.equal(caseInsensitive.skipped.hiddenDirectories, 1);
  if (linkCreated) assert.equal(caseInsensitive.skipped.symlinks, 1);

  const smallFilesOnly = await tools["workspace.search"].handler({
    query: "Needle",
    maxFileBytes: 8,
  });
  assert.equal(smallFilesOnly.matches.length, 0);
  assert.equal(smallFilesOnly.skipped.oversizedFiles, 2);
});

test("workspace.list bounds results and names skipped links", async (t) => {
  const { base, tools, workspace } = await fixture(t);
  await Promise.all([
    writeFile(path.join(workspace, "a.txt"), "a"),
    writeFile(path.join(workspace, "b.txt"), "b"),
    writeFile(path.join(base, "outside.txt"), "outside"),
  ]);
  let linkCreated = true;
  try {
    await symlink(path.join(base, "outside.txt"), path.join(workspace, "outside.txt"), "file");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") linkCreated = false;
    else throw error;
  }

  const result = await tools["workspace.list"].handler({ limit: 1 });
  assert.equal(result.entries.length, 1);
  assert.equal(result.truncated, true);
  assert.equal(result.scanLimit, 2_000);
  if (linkCreated) assert.equal(result.skippedSymlinks, 1);
});

// The browser keeps folders of its own inside the workspace: its temporary
// files and temporary profile under .toolsengine-runtime, and the dedicated
// profile when --profile-dir names a folder in the workspace (a layout that
// installs use, and that stays allowed). A profile holds the browser's
// settings, its cookies and its sign-ins. With the file tools reaching into
// it, an assistant could edit the profile's settings and read what the
// browser tools never show.
test("the file tools stay out of the browser's own folders in the workspace", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "toolsengine-workspace-"));
  const workspace = path.join(base, "workspace");
  const profile = path.join(workspace, "browser-profile");
  const runtime = path.join(workspace, ".toolsengine-runtime", "tmp", "playwright_chromiumdev_profile-AbCdEf", "Default");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(path.join(workspace, "notes"));
  t.after(() => rm(base, { force: true, recursive: true }));
  const settings = JSON.stringify({ download: { default_directory: "/somewhere" }, marker: "needle-in-the-profile" });
  await writeFile(path.join(profile, "Default", "Preferences"), settings);
  await writeFile(path.join(runtime, "Preferences"), settings);
  await writeFile(path.join(workspace, "notes", "mine.txt"), "needle-in-the-profile is also a word in my notes");
  const tools = Object.fromEntries(createWorkspaceTools({ workspace, profileDir: profile }).map((tool) => [tool.name, tool]));
  const refused = rejectsWithCode("BROWSER_FOLDER");

  for (const inside of ["browser-profile/Default/Preferences", ".toolsengine-runtime/tmp/playwright_chromiumdev_profile-AbCdEf/Default/Preferences"]) {
    await assert.rejects(tools["workspace.read_file"].handler({ path: inside }), refused, `read ${inside}`);
    await assert.rejects(tools["workspace.write_file"].handler({ path: inside, content: "{}", expectedSha256: "0".repeat(64) }), refused, `replace ${inside}`);
  }
  for (const inside of ["browser-profile/new-file.txt", "browser-profile/Default/Extensions.json", ".toolsengine-runtime/new-file.txt", ".toolsengine-runtime/tmp/x.txt"])
    await assert.rejects(tools["workspace.write_file"].handler({ path: inside, content: "x" }), refused, `create ${inside}`);
  for (const inside of ["browser-profile", "browser-profile/Default", ".toolsengine-runtime", ".toolsengine-runtime/tmp"])
    await assert.rejects(tools["workspace.list"].handler({ path: inside }), refused, `list ${inside}`);
  await assert.rejects(tools["workspace.search"].handler({ path: "browser-profile", query: "needle" }), refused);
  // A path that does not exist there is refused in the same way: the refusal does not tell what the folder holds.
  await assert.rejects(tools["workspace.read_file"].handler({ path: "browser-profile/Default/Login Data" }), refused);
  // Nothing was changed in either folder.
  assert.equal(await readFile(path.join(profile, "Default", "Preferences"), "utf8"), settings);
  assert.deepEqual((await readdir(profile)).sort(), ["Default"]);
  assert.deepEqual(await readdir(path.join(workspace, ".toolsengine-runtime")), ["tmp"]);

  // The folders are still there to be seen in a listing of the workspace, and a search passes them by and says so.
  const listed = await tools["workspace.list"].handler({});
  assert.deepEqual(listed.entries.map((entry) => entry.name), [".toolsengine-runtime", "browser-profile", "notes"]);
  const found = await tools["workspace.search"].handler({ query: "needle-in-the-profile" });
  assert.deepEqual(found.matches.map((match) => match.path), ["notes/mine.txt"]);
  assert.equal(found.skipped.browserFolders, 1);
  assert.equal(found.skipped.hiddenDirectories, 1);

  // The rest of the workspace is as before, a folder with a similar name included.
  await mkdir(path.join(workspace, "browser-profile-backup"));
  const written = await tools["workspace.write_file"].handler({ path: "browser-profile-backup/list.txt", content: "mine" });
  assert.equal(written.created, true);
  assert.equal((await tools["workspace.read_file"].handler({ path: "notes/mine.txt" })).bytes > 0, true);

  // Without --profile-dir a folder of that name is an ordinary folder; the runtime folder is the browser's in any case.
  const plain = Object.fromEntries(createWorkspaceTools({ workspace }).map((tool) => [tool.name, tool]));
  assert.equal((await plain["workspace.read_file"].handler({ path: "browser-profile/Default/Preferences" })).content, settings);
  await assert.rejects(plain["workspace.read_file"].handler({ path: ".toolsengine-runtime/tmp/playwright_chromiumdev_profile-AbCdEf/Default/Preferences" }), refused);
  // A profile that lies outside the workspace changes nothing inside it.
  const elsewhere = Object.fromEntries(createWorkspaceTools({ workspace, profileDir: path.join(base, "profile-elsewhere") }).map((tool) => [tool.name, tool]));
  assert.equal((await elsewhere["workspace.read_file"].handler({ path: "browser-profile/Default/Preferences" })).content, settings);
});

// Names that Linux allows and Windows does not (a colon, a trailing dot or
// space, a device name such as aux) made one such name anywhere in the tree
// fail the whole search, and the matches already found were lost.
test("workspace.search passes by names Windows cannot use, counts them, and keeps its matches", { skip: process.platform === "win32" ? "such names cannot be made on Windows" : false }, async (t) => {
  const { tools, workspace } = await fixture(t);
  for (const folder of ["notes", "logs", "odd: folder"]) await mkdir(path.join(workspace, folder));
  await writeFile(path.join(workspace, "notes", "a.txt"), "the needle is here");
  await writeFile(path.join(workspace, "logs", "server-2026-10-13T10:00:00.log"), "a needle in a log");
  await writeFile(path.join(workspace, "odd: folder", "b.txt"), "needle");
  await writeFile(path.join(workspace, "aux.c"), "needle");
  await writeFile(path.join(workspace, "trailing."), "needle");
  const found = await tools["workspace.search"].handler({ query: "needle" });
  assert.deepEqual(found.matches.map((match) => match.path), ["notes/a.txt"]);
  assert.equal(found.skipped.nonPortableNames, 4);
  assert.equal((await tools["workspace.search"].handler({ path: "logs", query: "needle" })).skipped.nonPortableNames, 1);
  assert.equal((await tools["workspace.search"].handler({ path: "notes", query: "needle" })).skipped.nonPortableNames, 0);
});

// "İ" (U+0130) is one character, and two in lower case: the column of a
// case-insensitive match after it was off by one for each.
test("workspace.search reports columns in the line as written when lower case is longer", async (t) => {
  const { tools, workspace } = await fixture(t);
  await writeFile(path.join(workspace, "tr.txt"), "İİİİ token\nİstanbul TOKEN and Token");
  const found = await tools["workspace.search"].handler({ query: "token", caseSensitive: false });
  assert.deepEqual(found.matches.map(({ line, column }) => [line, column]), [[1, 6], [2, 10], [2, 20]]);
  assert.equal(found.matches[0].text, "İİİİ token");
  const exact = await tools["workspace.search"].handler({ query: "TOKEN", caseSensitive: true });
  assert.deepEqual(exact.matches.map(({ line, column }) => [line, column]), [[2, 10]]);
});

// The temporary file was named after the target with about 42 bytes added,
// so names of about 214 to 255 bytes failed with the system's ENAMETOOLONG
// text and the workspace's absolute path.
test("workspace.write_file writes a name of 255 bytes, and refuses a longer one without the workspace's path", { skip: process.platform === "win32" ? "Windows limits the whole path instead" : false }, async (t) => {
  const { tools, workspace } = await fixture(t);
  const name = `${"n".repeat(251)}.txt`;
  assert.equal(Buffer.byteLength(name), 255);
  const written = await tools["workspace.write_file"].handler({ path: name, content: "x" });
  assert.equal(written.created, true);
  assert.equal(await readFile(path.join(workspace, name), "utf8"), "x");
  const tooLong = (error) => {
    assert.equal(error?.code, "NAME_TOO_LONG");
    assert.ok(!error.message.includes(workspace), error.message);
    assert.doesNotMatch(error.message, /ENAMETOOLONG/);
    return true;
  };
  await assert.rejects(tools["workspace.write_file"].handler({ path: `${"n".repeat(300)}.txt`, content: "x" }), tooLong);
  await assert.rejects(tools["workspace.read_file"].handler({ path: `${"n".repeat(300)}.txt` }), tooLong);
  assert.deepEqual((await readdir(workspace)).filter((entry) => entry.includes(".toolsengine-")), []);
});
