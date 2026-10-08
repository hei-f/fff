# @hf-pi/fff

A [pi](https://github.com/badlogic/pi-mono) extension that replaces the built-in `find` and `grep` tools with [FFF](https://github.com/dmtrKovalenko/fff) — a Rust-native, SIMD-accelerated file finder with built-in memory.

## What it does

| Built-in tool                     | pi-fff replacement                          | Improvement                                                    |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| `find` (spawns `fd`)              | `find` (FFF `fileSearch`)                   | Fuzzy matching, frecency ranking, git-aware, pre-indexed       |
| `grep` (spawns `rg`)              | `grep` (FFF `grep`)                         | SIMD-accelerated, frecency-ordered, mmap-cached, no subprocess |
| `@` file autocomplete (fd-backed) | `@` file autocomplete (FFF-backed, default) | Fuzzy ranking from FFF index/frecency                          |

### Key advantages over built-in tools

- **No subprocess spawning** — FFF is a Rust native library called through the Node binding. No `fd`/`rg` process per call.
- **Pre-indexed** — files are indexed in the background at session start. Searches are instant.
- **Frecency ranking** — files you access often rank higher. Learns across sessions.
- **Query history** — remembers which files were selected for which queries. Combo boost.
- **Git-aware** — modified/staged/untracked files are boosted in results.
- **Smart case** — case-insensitive when query is all lowercase, case-sensitive otherwise.
- **Fuzzy file search** — `find` uses fuzzy matching, not glob-only. Typo-tolerant. Glob-constrained queries (`*.rs`, `src/**`) return full results directly.
- **Cursor pagination** — grep and find results include a cursor for fetching the next page; find cursors resume from absolute offsets, so pages do not overlap.

## Install

Requirements:

- pi

### Install as a pi package

**Via npm (recommended):**

```bash
pi install npm:@hf-pi/fff
```

Project-local install:

```bash
pi install -l npm:@hf-pi/fff
```

**Via git:**

```bash
pi install git:github.com/dmtrKovalenko/fff
```

Pin to a release:

```bash
pi install git:github.com/dmtrKovalenko/fff@v0.3.0
```

### Local development / manual install

```bash
git clone https://github.com/dmtrKovalenko/fff.git
cd fff/packages/pi-fff
npm install
```

Then add to your pi `settings.json`:

```json
{
  "extensions": ["/path/to/fff/packages/pi-fff/src/index.ts"]
}
```

Or test directly:

```bash
pi -e /path/to/fff/packages/pi-fff/src/index.ts
```

After install, this extension registers FFF-powered `grep` and `find` tools that override pi's built-in ones.

## Self-contained package

`@hf-pi/fff` bundles everything it needs at runtime: the Bun and Node SDK bindings (vendored under `vendor/fff-bun/` and `vendor/fff-node/`, including their rebuilt `dist/`) and a prebuilt native `libfff_c` library for every supported desktop platform are embedded in the npm package. There is no runtime dependency on the `@ff-labs/fff-*` registry packages — the vendored binary is resolved first, with the registry lookup kept only as a fallback. `ffi-rs` is a direct runtime dependency.

The native layer is built from the same source as upstream FFF by the release fork (hei-f/fff) in a GitHub Actions cross-compile matrix, so every platform ships the same code and version, including the native fixes in this release.

## Platform support

Prebuilt native libraries are embedded for 8 desktop targets: darwin-x64 / darwin-arm64, linux-x64 / linux-arm64 (gnu and musl), win32-x64 / win32-arm64 — all from the same source and version.

Android / Termux is not supported: on those platforms `grep` and `find` fail with a missing-native-library error (known limitation).

## Tools

Both tools share the same constraint syntax: `path` (include), `exclude` (noise), and `cursor` (pagination). Directory-style `exclude` segments (e.g. `test/`) are probed against the index whenever results are returned: a misspelled or absent directory surfaces a hint in the output instead of failing silently.

### `grep`

Search file contents. Smart case, auto-detects regex vs literal, git-aware.

`caseSensitive: true` forces strict matching: zero exact hits return no matches directly, without a fuzzy suggestion. In smart-case mode, a zero-hit literal query falls back to fuzzy and surfaces the best approximate hits.

Parameters:

- `pattern` — search text or regex
- `path` — directory/file constraint (e.g. `src/`, `*.ts`)
- `exclude` — exclude paths (comma/space-separated or array; leading `!` optional, e.g. `test/,*.min.js`)
- `caseSensitive` — force case-sensitive matching (default: smart case)
- `context` — context lines around matches
- `limit` — max matches (default: 20)
- `cursor` — pagination cursor from previous result

### `find`

Fuzzy file name search. Frecency-ranked. Matches the whole repo-relative path, not just the filename.

Glob-constrained queries return complete results directly — the weak-match gate caps output only for pure fuzzy queries. Pagination resumes from absolute offsets, so successive pages never overlap.

Parameters:

- `pattern` — fuzzy query (e.g. `main.ts`, `src/ config`)
- `path` — directory/file constraint (e.g. `src/`, `*.ts`)
- `exclude` — exclude paths (comma/space-separated or array; leading `!` optional, e.g. `test/,*.min.js`)
- `limit` — max results per page (default: 30)
- `cursor` — pagination cursor from previous result

## Commands

- `/fff-health` — show FFF status (indexed files, git info, frecency/history DB status)
- `/fff-rescan` — trigger a file rescan

## How it works

The extension works in a single fixed mode: it always registers `grep` and `find` tools that replace pi's built-ins after install, and activates them when a session starts. There is no mode to configure or switch.

## Configuration

For persistent global configuration, create `pi-fff.json` in pi's agent directory (`~/.pi/agent/pi-fff.json` by default; `PI_CODING_AGENT_DIR` is respected):

```json
{
  "$schema": "https://raw.githubusercontent.com/dmtrKovalenko/fff/main/packages/pi-fff/pi-fff.schema.json",
  "frecencyDbPath": "/path/to/frecency",
  "historyDbPath": "/path/to/history",
  "enableFsRootScanning": false,
  "enableHomeDirScanning": true,
  "warnOnHomeDirScan": true,
  "followSymlinks": true
}
```

All fields are optional:

| Field                   | Type             | Default           |
| ----------------------- | ---------------- | ----------------- |
| `$schema`               | non-empty string | none              |
| `frecencyDbPath`        | non-empty string | See [Data](#data) |
| `historyDbPath`         | non-empty string | See [Data](#data) |
| `enableFsRootScanning`  | boolean          | `false`           |
| `enableHomeDirScanning` | boolean          | `true`            |
| `warnOnHomeDirScan`     | boolean          | `true`            |
| `followSymlinks`        | boolean          | `true`            |

Starting a session in a directory the config opts out of indexing (`$HOME` with `enableHomeDirScanning: false`, `/` with `enableFsRootScanning: false`) disables FFF search for that session: pi unconditionally activates extension tools, so the extension removes `grep`/`find` from the active tool set and notifies the user once with the reason and how to enable indexing.

CLI flags take precedence over environment variables, which take precedence over this file. A missing file is ignored. Malformed JSON, unknown fields, and invalid values stop the extension from loading and report the file path and error.

The file is global only.

## Flags

- `--fff-frecency-db <path>` — path to frecency database (also: `FFF_FRECENCY_DB` env). Optional; see [Data](#data) for the default.
- `--fff-history-db <path>` — path to query history database (also: `FFF_HISTORY_DB` env). Optional; see [Data](#data) for the default.
- `--fff-enable-root-scan` — allow indexing when launched from `/` (also: `FFF_ENABLE_ROOT_SCAN=1` env). FFF refuses to init at the filesystem root by default.
- `--fff-enable-home-scan` — index the home directory when launched from `$HOME` (also: `FFF_ENABLE_HOME_SCAN` env). Enabled by default. Disable with `--fff-enable-home-scan=false` or `FFF_ENABLE_HOME_SCAN=0` if your `$HOME` contains huge trees (toolchains, kernel sources, build outputs) that make the background index run for a long time. When launched from `$HOME` with this enabled, pi shows a warning that the whole home tree is being indexed.
- `--fff-warn-home-scan` — show the warning notification when `$HOME` is indexed (also: `FFF_WARN_HOME_SCAN` env). Enabled by default. Disable with `--fff-warn-home-scan=false`, `FFF_WARN_HOME_SCAN=0`, or `"warnOnHomeDirScan": false` in `pi-fff.json`. Indexing and the footer status are unaffected.
- `--fff-follow-symlinks` — index through directory symlinks (also: `FFF_FOLLOW_SYMLINKS` env, or `"followSymlinks"` in `pi-fff.json`). Enabled by default: trees that reach their real files through links — a git worktree whose `docs/` links back to the main checkout, or a stowed dotfiles layout — would otherwise be missing from `@`-mentions and from find/grep with no visible sign. Disable with `--fff-follow-symlinks=false` or `FFF_FOLLOW_SYMLINKS=0` to keep the walk inside the real tree, which is worth doing when a linked target pulls in a large tree outside the workspace. Symlink cycles are detected and broken by the walker.

## Data

FFF uses two LMDB databases:

- frecency database - file access frequency/recency, used to rank results
- history database - query-to-file selection history

Each path is resolved independently, in this order:

1. CLI flag — `--fff-frecency-db` / `--fff-history-db`
2. Env var — `FFF_FRECENCY_DB` / `FFF_HISTORY_DB`
3. Global config — `frecencyDbPath` / `historyDbPath`
4. An existing [fff.nvim](https://github.com/dmtrKovalenko/fff.nvim) database, so pi reuses the frecency you built up in your editor:
   - frecency: `$XDG_CACHE_HOME/nvim/fff_nvim`
   - history: `$XDG_DATA_HOME/nvim/fff_queries`
   - `XDG_CACHE_HOME` defaults to `~/.cache` and `XDG_DATA_HOME` to `~/.local/share`; on Windows both fall back under `%LOCALAPPDATA%\nvim-data`. Only directories count — a plain file at those paths is ignored.
5. pi-local directory, created on demand — `$PI_CODING_AGENT_DIR/fff/{frecency,history}`, defaulting to `~/.pi/agent/fff/{frecency,history}`

The extension only reads these databases; it never records the agent's own searches into your Neovim history. If a database cannot be opened, the finder starts without persistence and pi shows a warning instead of failing.

No project files are uploaded anywhere by this extension. It runs locally and only uses the configured LLM through pi itself.

## Security

- No shell execution
- No network calls in the extension code
- No telemetry
- No credential handling beyond whatever pi and your configured model provider already do
- Search state is stored locally under `~/.pi/agent/fff/`
