import * as fs from "node:fs";
import * as path from "node:path";
import { Plugin } from "@opencode/plugin";
import { Sandbox, SandboxError, type ResolvedTarget } from "./sandbox.js";

/**
 * OpenCode 2 plugin that adds safe filesystem tools: `mkdir`, `rmdir` and `rm`.
 *
 * All three tools are rooted at the current project directory (the sandbox
 * root). Paths are resolved with symlink awareness and re-checked against the
 * *real* project root, so a symlink inside the project that points outside
 * (e.g. `somedir -> /`) is detected. Targets whose real location escapes the
 * root are gated exactly like the built-in read/write tools:
 *
 *   - Traversing THROUGH such a symlink to reach the outside is EXTERNAL:
 *     it first requires an `external_directory` approval (absolute `dir/*`
 *     pattern), then the usual action approval with the absolute path.
 *   - Removing the symlink ITSELF (as the final path component) is INTERNAL:
 *     deleting the link never touches its target, so no external approval is
 *     needed.
 *
 * Hard stop: the sandbox root itself can never be an rm/rmdir target.
 *
 * Permission integration
 * ----------------------
 * Every tool asks OpenCode's permission engine for approval before touching the
 * filesystem, using the same action/resource model as the built-in `read`/`edit`
 * tools. This means you can configure them in `opencode.jsonc` exactly like the
 * built-ins, e.g.:
 *
 *   {
 *     "permissions": [
 *       { "action": "rm",    "resource": "*.env", "effect": "deny"  },
 *       { "action": "rm",    "resource": "*",     "effect": "ask"   },
 *       { "action": "mkdir", "resource": "*",     "effect": "allow" },
 *       { "action": "rmdir", "resource": "*",     "effect": "ask"   }
 *     ]
 *   }
 *
 * The matched resource is the target path RELATIVE to the project root (so glob
 * patterns like `*.env` or `build/**` work as expected) — exactly like the
 * built-in `read`/`edit` tools. External targets use the ABSOLUTE path as
 * resource (also like the built-ins), preceded by an `external_directory`
 * approval with the absolute `dir/*` pattern. In both cases "always allow"
 * persists the same patterns the built-in tools persist: `*` for the action,
 * and for the directory `<repoRoot>/*` where `<repoRoot>` is the nearest
 * ancestor of the target carrying a `.git`/`.hg` marker (or the directory
 * itself when none exists).
 *
 * A `deny` rule — or a rejection with feedback — rejects with a `Tool.Error`
 * that the model sees and continues from. A plain rejection ends the current
 * step. Both are deliberately *not* swallowed here and are propagated, per the
 * OpenCode plugin guidance ("Let these errors propagate rather than returning
 * them as tool output").
 *
 * The sandbox root defaults to the canonical project root of the loaded
 * location. Override it with the plugin option `root` (absolute path).
 */
export default Plugin.define({
  id: "opencode-fs-plugin",
  async setup(ctx) {
    const rawRoot =
      (typeof ctx.options?.root === "string" && ctx.options.root) ||
      ctx.location?.project?.canonical ||
      ctx.location?.directory ||
      "";
    if (!rawRoot) {
      throw new Error("opencode-fs-plugin: could not determine a sandbox root (project directory).");
    }
    const sandbox = new Sandbox(rawRoot);

    // Lexical (as-seen-by-the-user) project root, used to build the permission
    // resource (a project-relative path) so glob rules match predictably. We
    // normalize to forward slashes because OpenCode's permission patterns use
    // them (e.g. `build/**`, `*.env`).
    const lexRoot = path.resolve(rawRoot);
    const resourceFor = (p: string): string => {
      if (!p) return ".";
      const rel = path.relative(lexRoot, path.resolve(lexRoot, p));
      return (rel === "" ? "." : rel).split(path.sep).join("/");
    };

    // Permission helper — mirrors the built-in read/write tools:
    //  - internal target -> the action is asserted on the project-relative
    //    path, "always allow" persists `*`;
    //  - external target -> an `external_directory` approval on the absolute
    //    `dir/*` boundary comes FIRST, then the action on the absolute path
    //    ("always allow" persists `*` for the action and
    //    `<nearest .git/.hg ancestor of dir>/*` for the directory).
    const slash = (s: string) => s.split(path.sep).join("/");
    // Nearest ancestor of `dir` that contains a `.git` or `.hg` marker — the
    // same convention the built-in `Project.root` uses — falling back to `dir`
    // itself. Used to compute the `external_directory` save pattern, so
    // "always allow" persists a rule at the owning project's level (e.g.
    // approving `/home/u/proj2/src` saves `/home/u/proj2/*` when proj2 is a
    // repository).
    const projectRootOf = (dir: string): string => {
      let current = dir;
      for (;;) {
        for (const marker of [".git", ".hg"]) {
          try {
            fs.lstatSync(path.join(current, marker));
            return current;
          } catch {
            // no marker here — keep walking up
          }
        }
        const parent = path.dirname(current);
        if (parent === current) return dir;
        current = parent;
      }
    };
    const assertPermission = async (
      context: { sessionID: string; agent: string; messageID: string; id: string },
      action: string,
      target: ResolvedTarget,
      resource: string,
      boundaryDir: string,
    ) => {
      const base = {
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool" as const, messageID: context.messageID, id: context.id },
      };
      if (target.outside) {
        const dir = slash(boundaryDir);
        const saveDir = slash(projectRootOf(boundaryDir));
        await ctx.permission.assert({
          ...base,
          action: "external_directory",
          resources: [`${dir}/*`],
          save: [`${saveDir}/*`],
        });
        await ctx.permission.assert({
          ...base,
          action,
          resources: [slash(target.full)],
          save: ["*"],
        });
        return;
      }
      await ctx.permission.assert({
        ...base,
        action,
        resources: [resource],
        save: ["*"],
      });
    };

    const register = async () => {
      await ctx.tool.transform((editor) => {
        editor.add({
          name: "mkdir",
          description:
            "Creates a directory inside the project directory (sandbox). " +
            "`parents` (default: true) also creates missing intermediate directories. " +
            "Targets outside the project directory (including via symlinks) require an `external_directory` approval.",
          input: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path of the directory to create, relative to the project directory or absolute (inside the project directory).",
              },
              parents: {
                type: "boolean",
                description:
                  "Also create missing intermediate directories (like `mkdir -p`). Default: true.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const p = (input as { path?: string }).path ?? "";
            const parents = (input as { parents?: boolean }).parents !== false;
            const target = sandbox.resolveForCreate(p);
            // External boundary: the directory being created itself.
            await assertPermission(context, "mkdir", target, resourceFor(p), target.full);
            return run(() => {
              const full = target.full;
              let exists = false;
              let isDir = false;
              try {
                isDir = sandbox.lstat(full).isDirectory();
                exists = true;
              } catch {
                // does not exist yet -> fine
              }
              if (exists && isDir) {
                return `Directory already exists (no-op): ${p}`;
              }
              if (exists) {
                throw new SandboxError(`Already exists, but is not a directory: ${p}`, "exists");
              }
              fs.mkdirSync(full, { recursive: parents });
              return `Directory created: ${p}${full !== p ? ` (real: ${full})` : ""}`;
            });
          },
        });

        editor.add({
          name: "rmdir",
          description:
            "Removes an EMPTY directory inside the project directory (sandbox). " +
            "Refuses non-empty directories and symlinks (use `rm` for those). " +
            "Targets outside the project directory (including via symlinks) require an `external_directory` approval.",
          input: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path of the empty directory to remove, relative to the project directory or absolute (inside the project directory).",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const p = (input as { path?: string }).path ?? "";
            const target = sandbox.resolveExisting(p);
            // External boundary: the directory itself.
            await assertPermission(context, "rmdir", target, resourceFor(p), target.full);
            return run(() => {
              const full = target.full;
              const st = sandbox.lstat(full);
              if (st.isSymbolicLink()) {
                throw new SandboxError(`"${p}" is a symlink – use "rm" to remove the link.`, "not-directory");
              }
              if (!st.isDirectory()) {
                throw new SandboxError(`"${p}" is not a directory.`, "not-directory");
              }
              try {
                fs.rmdirSync(full);
              } catch (e) {
                const code = (e as NodeJS.ErrnoException)?.code;
                if (code === "ENOTEMPTY" || code === "ENOTDIR") {
                  throw new SandboxError(`"${p}" is not empty.`, "not-empty");
                }
                throw new SandboxError(`Removal failed: ${(e as Error).message ?? String(e)}`, "io");
              }
              return `Empty directory removed: ${p}${full !== p ? ` (real: ${full})` : ""}`;
            });
          },
        });

        editor.add({
          name: "rm",
          description:
            "Removes a file, a symlink, or (with `recursive: true`) a directory inside the project directory (sandbox). " +
            "Symlinks are removed ONLY as the link itself – their target is never touched. " +
            "Directories require `recursive: true`. " +
            "Targets outside the project directory (including via symlinks) require an `external_directory` approval.",
          input: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path of the file/symlink/directory to remove, relative to the project directory or absolute (inside the project directory).",
              },
              recursive: {
                type: "boolean",
                description: "Remove a directory recursively (like `rm -r`). Default: false.",
              },
            },
            required: ["path"],
            additionalProperties: false,
          },
          execute: async (input, context) => {
            const p = (input as { path?: string }).path ?? "";
            const recursive = (input as { recursive?: boolean }).recursive === true;
            const target = sandbox.resolveExisting(p);
            // External boundary: the directory containing the target (the
            // target itself when it is a real directory).
            let boundary = path.dirname(target.full);
            try {
              const st = sandbox.lstat(target.full);
              if (!st.isSymbolicLink() && st.isDirectory()) boundary = target.full;
            } catch {
              // not found yet -> run() will report it
            }
            await assertPermission(context, "rm", target, resourceFor(p), boundary);
            return run(() => {
              const full = target.full;
              const st = sandbox.lstat(full);
              if (st.isSymbolicLink()) {
                fs.unlinkSync(full);
                return `Symlink removed (target untouched): ${p}`;
              }
              if (st.isDirectory()) {
                if (!recursive) {
                  throw new SandboxError(
                    `"${p}" is a directory – pass "recursive: true" to remove it.`,
                    "not-file",
                  );
                }
                fs.rmSync(full, { recursive: true, force: false });
                return `Directory removed: ${p}${full !== p ? ` (real: ${full})` : ""}`;
              }
              fs.unlinkSync(full);
              return `File removed: ${p}${full !== p ? ` (real: ${full})` : ""}`;
            });
          },
        });
      });
    };

    await register();
    console.log(`opencode-fs-plugin: mkdir/rmdir/rm active, sandbox root: ${sandbox.root}`);
  },
});

/**
 * Run a tool body and convert domain failures (sandbox violations, I/O errors)
 * into a model-visible `content` result so the model can adapt.
 *
 * NOTE: permission rejections are deliberately NOT handled here. `ctx.permission.assert()`
 * is awaited *before* this wrapper, so a deny/reject propagates out of the tool
 * (as required by OpenCode: "Let these errors propagate rather than returning
 * them as tool output").
 */
function run(body: () => string) {
  try {
    const text = body();
    return { content: text, metadata: { ok: true } };
  } catch (e) {
    if (e instanceof SandboxError) {
      return { content: `BLOCKED: ${e.message}`, metadata: { ok: false, blocked: true, code: e.code } };
    }
    return { content: `ERROR: ${(e as Error)?.message ?? String(e)}`, metadata: { ok: false, blocked: false } };
  }
}
