# opencode-fs-plugin

An OpenCode 2 (V2) plugin that adds the missing filesystem tools **`mkdir`**, **`rmdir`** and **`rm`** — with a strict sandbox and full OpenCode permission integration. Operations inside the project directory are plain and fast; targets that would escape the project directory (e.g. through a symlink) are gated by OpenCode's `external_directory` permission — exactly like the built-in `read`/`write` tools. The project directory itself can never be removed.

## Why a custom plugin?

OpenCode V2 does not ship a generic `mkdir`/`rmdir`/`rm`. This plugin fills that gap and is explicitly **symlink-aware**: a symlink inside the project that points outside (e.g. `somedir -> /`) is detected and treated as an *external* target — it requires an explicit `external_directory` approval before anything on the other side of the link can be created or removed.

## Installing

From a release (recommended):

1. Download the `opencode-fs-plugin-<version>.tgz` artifact from the release's pipeline run (Gitea → repository → Actions → the run → **Artifacts**).
2. Install it into your project:

   ```bash
   npm install ./opencode-fs-plugin-0.1.0.tgz
   ```

Or from a source checkout:

```bash
npm install /path/to/opencode-fs-plugin
```

The plugin ships as an ESM module (`type: module`, export `.` → `./src/index.ts`).

## Loading

Choose one of the two options:

### 1. Via configuration (`opencode.jsonc`)

```jsonc
{
  "plugins": ["opencode-fs-plugin"]
}
```

### 2. As a project plugin

Place the plugin under `.opencode/plugins/` (or symlink it there) and OpenCode loads it automatically.

## Options

| Option  | Type     | Description                                                      |
| ------- | -------- | ---------------------------------------------------------------- |
| `root`  | `string` | Sandbox root (absolute path). Default: the canonical project root. |

```jsonc
{
  "plugins": [
    {
      "path": "opencode-fs-plugin",
      "options": { "root": "/absolute/project/dir" }
    }
  ]
}
```

> By default, `ctx.location.project.canonical` (or `ctx.location.directory`) is used as the sandbox root.

## Permission config

All three tools are protected by OpenCode's permission engine — **exactly like the built-in** `read`/`edit` tools. Before touching the filesystem, each tool asserts with `ctx.permission.assert({ action, resources, save })`:

- **Internal targets** (the normal case):
    - **`action`** = `mkdir`, `rmdir` or `rm`.
    - **`resources`** = the target path **relative to the project directory** (normalized with `/`), so patterns like `*.env` or `build/*` match as in the OpenCode examples.
    - **`save`** = `*` — the same pattern the built-in `read`/`write` tools persist for in-project paths.
- **External targets** (the real location escapes the project directory, e.g. through a symlink):
    - **First** an `external_directory` approval: `resources` = the absolute boundary directory + `/*` (for a file: its parent directory; for a directory: the directory itself).
    - **Then** the usual action approval, with the **absolute** path as resource (also the built-ins' convention).
    - **`save`** = `<repoRoot>/*`, where `<repoRoot>` is the nearest ancestor of the boundary directory carrying a `.git`/`.hg` marker (or the boundary directory itself when none exists) — the same convention the built-in tools use, so "allow always" persists a rule at the owning project's level.

### Global rules

Rules are an **ordered array** — the **last matching rule wins**, so put broad rules first and specific exceptions after:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "permissions": [
    // rm: block .env files, ask for everything else
    { "action": "rm",    "resource": "*.env", "effect": "deny" },
    { "action": "rm",    "resource": "*",     "effect": "ask"  },
    // rmdir: allow the build dir, ask otherwise
    { "action": "rmdir", "resource": "build/*", "effect": "allow" },
    { "action": "rmdir", "resource": "*",     "effect": "ask"  },
    // mkdir: fully allowed inside the project
    { "action": "mkdir", "resource": "*",     "effect": "allow" },
    // external targets (symlink escapes): deny everything outside /tmp
    { "action": "external_directory", "resource": "/tmp/*", "effect": "deny" }
  ]
}
```

Notes:

- If **no rule matches**, OpenCode defaults to `ask`.
- `*` matches zero or more characters **including `/`**, and matches the whole normalized path.
- A project `opencode.jsonc` is merged with your global config; lower-priority config is loaded first, global rules are appended next.

### Per-agent rules

Agent rules go under `agents.<id>.permissions` and are **appended after** the global rules (they win on conflict):

```jsonc
{
  "permissions": [
    { "action": "rm", "resource": "*", "effect": "ask" }
  ],
  "agents": {
    "build": {
      "mode": "primary",
      "permissions": [
        { "action": "rm", "resource": "*.env", "effect": "deny" },
        { "action": "rm", "resource": "*",     "effect": "ask"  }
      ]
    }
  }
}
```

### Behavior on decision

| Outcome            | What happens                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------- |
| `allow`            | Operation runs without a prompt.                                                                    |
| `ask`              | OpenCode asks; you choose **once** / **always** / **reject**.                                       |
| `deny`             | Rejected with a `Tool.Error` — the model sees the reason and can continue.                          |
| Rejection (prompt) | Ends the current step; the error is **propagated** rather than wrapped as tool output.             |

Choosing **"allow always"** persists the tool's proposed pattern (the `save` value) as a **durable, project-scoped `allow` rule**: `*` for the action (allowed for the whole project), and for external targets `<repoRoot>/*` for the directory. Saved approvals never override a configured `deny`.

> **Note:** The sandbox (symlink/containment check) is an **additional** layer that applies independently of the permission config. It decides *how* a target is approved (internal vs. `external_directory`), and it enforces one hard rule: the **project directory itself can never be an `rm`/`rmdir` target** — not even with an explicit `allow`.

## Tools

### `mkdir`
Creates a directory inside the project directory.

| Parameter | Type      | Default | Description                                              |
| --------- | --------- | ------- | -------------------------------------------------------- |
| `path`    | `string`  | –       | Path (relative to the project dir, or absolute but inside it). |
| `parents` | `boolean` | `true`  | Also create missing intermediate directories (`mkdir -p`). |

### `rmdir`
Removes an **empty** directory inside the project directory.

| Parameter | Type     | Description                                                   |
| --------- | -------- | ------------------------------------------------------------- |
| `path`    | `string` | Path of the empty directory. Symlinks are refused (use `rm`). |

### `rm`
Removes a file, a symlink, or (with `recursive: true`) a directory.

| Parameter   | Type      | Default | Description                                          |
| ----------- | --------- | ------- | ---------------------------------------------------- |
| `path`      | `string`  | –       | Path of the file/symlink/directory.                  |
| `recursive` | `boolean` | `false` | Remove a directory recursively (`rm -r`).            |

All paths are relative to the project directory **or** absolute. Targets whose *real* location escapes the project directory (e.g. through a symlink) are treated as **external** and require an `external_directory` approval before the action itself.

## Security model

The core is `src/sandbox.ts`. The central idea:

1. The **sandbox root** is resolved once to its *real* path (`realpath`). This way we always compare apples to apples — even if the project directory itself is a symlink.
2. **Resolving the target:**
    - For **creation** (`mkdir`): the *deepest existing* ancestor is found and resolved via `realpath`. The still-missing segments are appended as relative segments.
    - For **existing** targets (`rm`, `rmdir`): the *parent path* is resolved via `realpath`. The final component is **not** followed.
    - In both cases the result carries an `outside` flag: `true` when the real location escapes the sandbox root.
3. **What the flag means:**
    - `outside = true` → the target is **EXTERNAL**: it first requires an `external_directory` approval (absolute `dir/*`), then the usual action approval (absolute path) — the same two-step scheme the built-in `read`/`write` tools use.
    - `outside = false` → the target is **INTERNAL**: plain action approval on the project-relative path.
    - Removing the symlink **itself** as the final component is always **INTERNAL**, because deleting the link never touches its target.
4. **Hard stop:** the sandbox root itself can never be an `rm`/`rmdir` target — even with an explicit `allow` rule.

### Example: the classic attack

```
project/
└── somedir -> /          # symlink to the filesystem root
```

- `rm somedir/etc/passwd` → **EXTERNAL** (the parent `somedir` resolves to `/` in reality) → requires `external_directory` approval for `/etc/*`, then `rm` approval for `/etc/passwd`.
- `mkdir somedir/etc/evil` → **EXTERNAL** (the ancestor `somedir` is outside in reality) → requires `external_directory` approval for `/etc/evil/*`, then `mkdir` approval.
- `rm somedir` → **INTERNAL** (only the symlink itself is removed; `/` is untouched) → plain `rm` approval for `somedir`.
- `rm .` → **BLOCKED, always** (the project directory itself can never be removed).

## Error handling

Errors are not thrown as unhandled tool errors but returned as a model-visible `content` result:

- `BLOCKED: …` — a sandbox violation (with `metadata.blocked = true` and `metadata.code`).
- `ERROR: …` — any other error (e.g. `not-found`, `not-empty`, `io`).

Stable error codes: `empty`, `not-found`, `not-directory`, `not-file`, `not-empty`, `outside`, `access`, `exists`, `io`.

## Project structure

```
src/
├── index.ts     # Plugin.define + registration of the three tools
└── sandbox.ts   # Symlink-safe path resolution + containment (dependency-free)
```

## Release pipeline

`.gitea/workflows/release.yml` runs on Gitea Actions when a release is published:
it executes the prod build (`npm install --omit=dev --omit=peer --omit=optional`
+ `npm pack`) and uploads the resulting `opencode-fs-plugin-<version>.tgz`
tarball as a run artifact. `workflow_dispatch` allows triggering it manually.

## Development

```bash
npm install
npx tsc --noEmit   # type check
```

`src/sandbox.ts` is deliberately kept dependency-free so it can be tested standalone.
