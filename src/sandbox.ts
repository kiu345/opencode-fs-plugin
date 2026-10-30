import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A resolved target: the absolute path to operate on plus whether its real
 * (symlink-resolved) location escapes the sandbox root ("outside").
 *
 * Outside targets are NOT rejected here — they are reported so the caller can
 * gate them with the `external_directory` permission, exactly like the
 * built-in read/write tools. Only the sandbox root itself is a hard stop.
 */
export interface ResolvedTarget {
  /** Absolute path to operate on. */
  full: string;
  /** True when the real location escapes the sandbox root. */
  outside: boolean;
}

/**
 * An error thrown when a path cannot be resolved / accessed at all, or when a
 * hard-safety violation would occur (e.g. removing the sandbox root itself).
 *
 * The `code` is a stable, machine-readable reason so callers (and tests) can
 * distinguish the different failure modes.
 */
export type SandboxErrorCode =
  | "empty"
  | "not-found"
  | "not-directory"
  | "not-file"
  | "not-empty"
  | "outside"
  | "access"
  | "exists"
  | "io";

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  constructor(message: string, code: SandboxErrorCode) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
  }
}

/**
 * A filesystem sandbox rooted at an absolute, real (symlink-resolved) directory.
 *
 * Every public method resolves its target against the sandbox root with symlink
 * awareness: resolution follows symlinks for every *traversed* path component
 * and re-checks containment against the *real* root, so a symlink inside the
 * project that points outside (e.g. `somedir -> /`) is detected.
 *
 * Targets whose real location escapes the root are reported (`outside: true`)
 * so the caller can gate them with the `external_directory` permission, like
 * the built-in read/write tools. The design still distinguishes two cases:
 *  - Traversing *through* a symlink to reach something outside is EXTERNAL
 *    (permission-gated).
 *  - Removing the symlink *itself* (as the final path component) is INTERNAL
 *    (it never touches the target, so no external approval is needed).
 *
 * Hard stop: the sandbox root itself can never be an rm/rmdir target.
 */
export class Sandbox {
  /** The canonical (realpath-resolved) sandbox root. */
  readonly root: string;
  private readonly rootSep: string;

  constructor(rawRoot: string) {
    if (typeof rawRoot !== "string" || rawRoot.length === 0) {
      throw new SandboxError("Sandbox root is empty.", "empty");
    }
    let root: string;
    try {
      // Resolve the root to its real location so containment checks compare
      // apples to apples even if the project dir itself is a symlink.
      root = fs.realpathSync(path.resolve(rawRoot));
    } catch {
      // The root may not exist yet (e.g. a fresh worktree). Fall back to the
      // lexical absolute path; containment still protects us.
      root = path.resolve(rawRoot);
    }
    this.root = root;
    this.rootSep = root.endsWith(path.sep) ? root : root + path.sep;
  }

  /** True when `p` is the root itself or a sub-path of the root. */
  private isWithin(p: string): boolean {
    return p === this.root || p.startsWith(this.rootSep);
  }

  /**
   * Walk up from `abs` until a component exists (lstat, so broken symlinks
   * count as existing). Returns the real path of that deepest existing
   * ancestor plus the still-missing relative tail.
   */
  private deepestExistingAncestor(abs: string): { real: string; tail: string[] } {
    let node = abs;
    const tail: string[] = [];
    for (;;) {
      try {
        fs.lstatSync(node);
        break;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          const base = path.basename(node);
          const parent = path.dirname(node);
          // Reached the filesystem root without finding an existing node.
          if (base === "" || parent === node) break;
          tail.unshift(base);
          node = parent;
          continue;
        }
        throw new SandboxError(`Cannot access path: ${(e as Error)?.message ?? String(e)}`, "access");
      }
    }
    let real: string;
    try {
      real = fs.realpathSync(node);
    } catch (e) {
      throw new SandboxError(`Cannot resolve path: ${(e as Error)?.message ?? String(e)}`, "access");
    }
    return { real, tail };
  }

  /**
   * Resolve a target that is about to be CREATED (mkdir). Returns the path to
   * create plus whether its real location escapes the sandbox. The deepest
   * existing ancestor is resolved with symlink awareness; the missing tail is
   * appended as relative segments.
   */
  resolveForCreate(target: string): ResolvedTarget {
    if (typeof target !== "string" || target.length === 0) {
      throw new SandboxError("Target path is empty.", "empty");
    }
    const abs = path.resolve(this.root, target);
    const { real, tail } = this.deepestExistingAncestor(abs);
    return {
      full: tail.length > 0 ? path.join(real, ...tail) : real,
      outside: !this.isWithin(real),
    };
  }

  /**
   * Resolve a target that must EXIST for deletion (rm, rmdir).
   *
   * Only the *parent* of the target is resolved. The final component is
   * intentionally NOT followed: if it is a symlink we still operate on the
   * link itself (safe, and therefore INTERNAL), but any symlink further up the
   * path that points outside marks the target as EXTERNAL.
   *
   * Returns the absolute path to operate on plus the `outside` flag.
   *
   * Hard stop: the sandbox root itself can never be a target.
   */
  resolveExisting(target: string): ResolvedTarget {
    if (typeof target !== "string" || target.length === 0) {
      throw new SandboxError("Target path is empty.", "empty");
    }
    const abs = path.resolve(this.root, target);
    if (abs === this.root) {
      throw new SandboxError(
        `Blocked: the sandbox root itself (${this.root}) can never be removed.`,
        "outside",
      );
    }

    // The target must exist (file, directory, or symlink).
    let st: fs.Stats;
    try {
      st = fs.lstatSync(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new SandboxError(`Not found: "${target}"`, "not-found");
      }
      throw new SandboxError(`Cannot access "${target}": ${(e as Error)?.message ?? String(e)}`, "access");
    }
    void st;

    // Resolve the parent chain with symlink awareness; outside-ness is
    // reported, not rejected.
    const parentAbs = path.dirname(abs);
    const { real: parentReal, tail } = this.deepestExistingAncestor(parentAbs);
    return { full: abs, outside: tail.length > 0 || !this.isWithin(parentReal) };
  }

  /** lstat a path; returns the stats or throws a SandboxError. */
  lstat(p: string): fs.Stats {
    try {
      return fs.lstatSync(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new SandboxError(`Not found: "${p}"`, "not-found");
      }
      throw new SandboxError(`Cannot access "${p}": ${(e as Error)?.message ?? String(e)}`, "access");
    }
  }
}
