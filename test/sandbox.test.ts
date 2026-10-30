/*
 * SPDX-License-Identifier: EPL-2.0
 * license-wizard managed-header v1 EPL-2.0 short 73897e75828f
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Sandbox, SandboxError } from "../src/sandbox.ts";

let failures = 0;
const line = (s = "") => console.log(s);

function expectBlocked(label: string, fn: () => void) {
  try {
    fn();
    line(`  ✗ ${label}: expected BLOCKED, but it was NOT blocked`);
    failures++;
  } catch (e) {
    if (e instanceof SandboxError) {
      line(`  ✓ ${label}: blocked (code=${e.code})`);
    } else {
      line(`  ✗ ${label}: wrong error type: ${(e as Error).message}`);
      failures++;
    }
  }
}

function expectOk(label: string, fn: () => void) {
  try {
    fn();
    line(`  ✓ ${label}: ok`);
  } catch (e) {
    line(`  ✗ ${label}: expected ok, but error: ${(e as Error).message}`);
    failures++;
  }
}

// The sandbox no longer rejects escapes — it reports them so the caller can
// gate them with the `external_directory` permission (like the built-ins).
function expectOutside(label: string, fn: () => { outside: boolean }) {
  try {
    const t = fn();
    if (t.outside === true) line(`  ✓ ${label}: external (outside=true, permission-gated)`);
    else {
      line(`  ✗ ${label}: expected outside=true, got outside=${t.outside}`);
      failures++;
    }
  } catch (e) {
    line(`  ✗ ${label}: expected outside=true, but error: ${(e as Error).message}`);
    failures++;
  }
}

function expectInside(label: string, fn: () => { outside: boolean }) {
  try {
    const t = fn();
    if (t.outside === false) line(`  ✓ ${label}: internal (outside=false)`);
    else {
      line(`  ✗ ${label}: expected outside=false, got outside=${t.outside}`);
      failures++;
    }
  } catch (e) {
    line(`  ✗ ${label}: expected outside=false, but error: ${(e as Error).message}`);
    failures++;
  }
}

// Build an isolated sandbox root in a temp dir.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "fs-plugin-sandbox-"));
line(`Sandbox root: ${root}`);
line(`realpath(root): ${fs.realpathSync(root)}`);

// A file OUTSIDE the sandbox we must never be able to touch.
const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-plugin-outside-"));
const outsideFile = path.join(outsideDir, "secret.txt");
fs.writeFileSync(outsideFile, "top secret\n");

const sb = new Sandbox(root);

line("\n[1] Symlink escape: somedir -> /");
const link = path.join(root, "somedir");
fs.symlinkSync(fs.realpathSync("/"), link, "dir");
line(`  symlink ${link} -> ${fs.readlinkSync(link)}`);

expectOutside("rm somedir/etc/passwd (through symlink)", () => sb.resolveExisting("somedir/etc/passwd"));
expectOutside("mkdir somedir/etc/evil (through symlink)", () => sb.resolveForCreate("somedir/etc/evil"));
// Removing the symlink ITSELF is internal (removing a link never touches its
// target). Mirrors the real `rm` tool: lstat -> if symlink -> unlink.
expectInside("rm somedir (symlink itself -> internal, target / stays untouched)", () => {
  const t = sb.resolveExisting("somedir");
  const st = sb.lstat(t.full);
  if (st.isSymbolicLink()) fs.unlinkSync(t.full); // removes only the link
  else if (st.isDirectory()) fs.rmSync(t.full, { recursive: true });
  else fs.unlinkSync(t.full);
  return t;
});
line(`  symlink still exists afterwards? ${fs.existsSync(link) ? "YES (BAD)" : "NO (good)"}`);
line(`  / untouched? ${fs.existsSync("/etc") ? "YES (good)" : "NO (BAD)"}`);

line("\n[2] Lexical escape: ..");
// The outside file lives in a sibling temp dir; address it lexically via `..`
// so the target EXISTS and the sandbox must report it as external.
const outsideRel = path.relative(root, outsideFile);
line(`  relative path used: ${outsideRel}`);
expectOutside("rm ../<outside>/secret.txt (relative, ..)", () => sb.resolveExisting(outsideRel));
expectOutside("rm /etc/passwd (absolute)", () => sb.resolveExisting("/etc/passwd"));

line("\n[3] Legitimate operations inside the sandbox");
expectInside("mkdir build (inside)", () => {
  const t = sb.resolveForCreate("build");
  fs.mkdirSync(t.full, { recursive: true });
  return t;
});
expectInside("mkdir build/nested/deep (inside)", () => {
  const t = sb.resolveForCreate("build/nested/deep");
  fs.mkdirSync(t.full, { recursive: true });
  return t;
});
const innerFile = path.join(root, "build/nested/deep/a.txt");
fs.writeFileSync(innerFile, "hello");
expectInside("rm build/nested/deep/a.txt (file)", () => {
  const t = sb.resolveExisting("build/nested/deep/a.txt");
  fs.unlinkSync(t.full);
  return t;
});
expectInside("rmdir build/nested/deep (empty directory)", () => {
  const t = sb.resolveExisting("build/nested/deep");
  fs.rmdirSync(t.full);
  return t;
});

line("\n[4] rmdir: refuse symlinks");
const fileLink = path.join(root, "filelink");
fs.symlinkSync(outsideFile, fileLink);
expectBlocked("rmdir filelink (symlink)", () => {
  const t = sb.resolveExisting("filelink");
  const st = sb.lstat(t.full);
  if (st.isSymbolicLink()) throw new SandboxError("symlink", "not-directory");
  fs.rmdirSync(t.full);
});

line("\n[5] rm: symlink to an outside file -> internal, remove only the link, target stays");
expectInside("rm filelink (symlink itself)", () => {
  const t = sb.resolveExisting("filelink");
  fs.unlinkSync(t.full);
  return t;
});
line(`  outside file untouched? ${fs.existsSync(outsideFile) ? "YES (good)" : "NO (BAD)"}`);

line("\n[6] Project root itself cannot be removed (hard stop, even with approval)");
expectBlocked("rm . (root)", () => {
  const t = sb.resolveExisting(".");
  fs.rmSync(t.full, { recursive: true });
});

// Cleanup
fs.rmSync(root, { recursive: true, force: true });
fs.rmSync(outsideDir, { recursive: true, force: true });

line(`\n${failures === 0 ? "✅ ALL TESTS PASSED" : `❌ ${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
