/**
 * pi-fff: FFF-powered file search extension for pi
 *
 * Overrides built-in `find` and `grep` tools with FFF and adds FFF-backed
 * @-mention autocomplete suggestions to the interactive editor.
 */

import nodePath from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  type AutocompleteItem,
  type AutocompleteProvider,
  type Component,
  sliceByColumn,
  Text,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type {
  FileFinderApi,
  GrepCursor,
  GrepMode,
  GrepResult,
  MixedItem,
  SearchResult,
} from "../vendor/fff-node/dist/index.js";
import { Type } from "@sinclair/typebox";
import { AuxFinderPool, routePathConstraint } from "./aux-finders";
import { loadConfig } from "./config";
import { FilePickerFactory } from "./file-picker";
import { isFsRoot, isHomeDir, resolveDbPaths } from "./paths";
import { buildQuery, GLOB_WILDCARDS_RE, normalizedExcludeSegments } from "./query";

export { SCAN_TIMEOUT_MS } from "./sdk";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_GREP_LIMIT = 20;
const DEFAULT_FIND_LIMIT = 30;
const GREP_PAGE_SIZE_MAX = 50;
// Per-file match cap. Must stay decoupled from pageSize: grep cursors advance by
// file offset, so clamping this to pageSize makes same-file overflow unreachable
// on later pages (#825). Matches the engine default.
const GREP_MAX_MATCHES_PER_FILE = 200;
const GREP_CONTEXT_MAX = 20;
const GREP_MAX_LINE_LENGTH = 500;
const MENTION_MAX_RESULTS = 20;

// If we exceed 10 seconds for indexed grep - something is definitely off
const GREP_TIME_BUDGET_MS = 10_000;

const HOME_SCAN_STATUS_KEY = "fff";
const HOME_SCAN_POLL_MS = 1_000;
const HOME_SCAN_DISABLE_HINT =
  'You can prevent home dir indexing with --fff-enable-home-scan=false, FFF_ENABLE_HOME_SCAN=0, or "enableHomeDirScanning": false in pi-fff.json. ' +
  'To keep indexing but silence this warning use --fff-warn-home-scan=false, FFF_WARN_HOME_SCAN=0, or "warnOnHomeDirScan": false in pi-fff.json.';

// 固定工具名：pi-fff 安装后始终以 grep/find 覆盖 pi 内置同名工具。
const TOOL_NAMES = { grep: "grep", find: "find" } as const;

// ---------------------------------------------------------------------------
// Cursor store — simple bounded Map for pagination cursors
// ---------------------------------------------------------------------------

const cursorCache = new Map<string, GrepCursor>();
let cursorCounter = 0;

function storeCursor(cursor: GrepCursor): string {
  const id = `fff_c${++cursorCounter}`;
  cursorCache.set(id, cursor);
  if (cursorCache.size > 200) {
    const first = cursorCache.keys().next().value;
    if (first) cursorCache.delete(first);
  }
  return id;
}

function getCursor(id: string): GrepCursor | undefined {
  return cursorCache.get(id);
}

// find 翻页使用绝对偏移 cursor：原生 fileSearch 将 pageIndex 视为 skip 偏移，
// 记录下一页的绝对偏移与产生它的 query+limit；存储 token 对 agent 不透明。
interface FindCursor {
  query: string;
  pattern: string;
  pageSize: number;
  nextOffset: number;
  auxRoot?: string;
}

const findCursorCache = new Map<string, FindCursor>();
let findCursorCounter = 0;

function storeFindCursor(cursor: FindCursor): string {
  const id = `${++findCursorCounter}`;
  findCursorCache.set(id, cursor);
  if (findCursorCache.size > 200) {
    const first = findCursorCache.keys().next().value;
    if (first) findCursorCache.delete(first);
  }
  return id;
}

function getFindCursor(id: string): FindCursor | undefined {
  return findCursorCache.get(id);
}

// ---------------------------------------------------------------------------
// Output formatting helpers
// ---------------------------------------------------------------------------

function truncateLine(line: string, max = GREP_MAX_LINE_LENGTH): string {
  const trimmed = line.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}...`;
}

// Clamp caller-supplied context to a non-negative bounded integer so a large
// value cannot multiply output size past the model window.
function clampContext(context: number | undefined): number {
  if (!context || context < 0) return 0;
  return Math.min(Math.floor(context), GREP_CONTEXT_MAX);
}

const HOT_FRECENCY = 25;
const WARM_FRECENCY = 20;

// Shared annotation helper for both find-output paths and grep-output file
// headers. Returns at most ONE tag so output stays scannable. Priority:
// git-dirty (most actionable — file is changing right now) beats frecency
// (historically often-touched). Keeping one function ensures the two tools
// never drift in how they surface git/frecency signal.
export function fffFileAnnotation(item: {
  gitStatus?: string;
  totalFrecencyScore?: number;
  accessFrecencyScore?: number;
}): string {
  const git = item.gitStatus;
  if (git && git !== "clean" && git !== "unknown" && git !== "") {
    return `  [${git} in git]`;
  }

  const frecency = item.totalFrecencyScore ?? item.accessFrecencyScore ?? 0;
  if (frecency >= HOT_FRECENCY) return "  [VERY often touched file]";
  if (frecency >= WARM_FRECENCY) return "  [often touched file]";

  return "";
}

// Appends bracketed notices (pagination tips, weak-match warnings) to tool output.
function appendNotices(output: string, notices: string[]): string {
  return notices.length > 0 ? `${output}\n\n[${notices.join(". ")}]` : output;
}

// DO NOT ATTEMPT TO RESORT OUTPUT HERE IT ONLY CONFUSES MODELS
function formatGrepOutput(result: GrepResult): string {
  if (result.items.length === 0) return "No matches found";

  // Build file-grouped output in the order files first appear in the result.
  // This preserves native frecency ordering across files without re-sorting.
  const lines: string[] = [];
  let currentFile = "";

  for (const match of result.items) {
    if (match.relativePath !== currentFile) {
      if (lines.length > 0) lines.push("");
      currentFile = match.relativePath;
      lines.push(`${currentFile}${fffFileAnnotation(match)}`);
    }

    match.contextBefore?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber - match.contextBefore!.length + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });

    lines.push(` ${match.lineNumber}: ${truncateLine(match.lineContent)}`);

    match.contextAfter?.forEach((line: string, i: number) => {
      const lineNum = match.lineNumber + 1 + i;
      lines.push(` ${lineNum}- ${truncateLine(line)}`);
    });
  }

  return lines.join("\n");
}

// 弱匹配阈值按查询长度缩放（对照 crates/fff-core/src/score.rs 计分公式）：
// 阈值为 len*12 的 50%，低于即视为散落的模糊噪声，输出截断为小样本。
const FIND_WEAK_SAMPLE_SIZE = 5;

function weakScoreThreshold(pattern: string): number {
  const perfect = pattern.length * 12;
  return Math.floor((perfect * 50) / 100);
}

interface FormattedFind {
  output: string;
  weak: boolean;
  shownCount: number;
}

function formatFindOutput(
  result: SearchResult,
  limit: number,
  pattern: string,
): FormattedFind {
  if (result.items.length === 0) {
    return {
      output: "No files found matching pattern",
      weak: false,
      shownCount: 0,
    };
  }

  // NO CUSTOM SORTING — trust native frecency order from the engine.
  const reordered = result.items.map((item) => ({ item }));

  // Peek at the top native score to decide whether results are scattered
  // fuzzy noise (query length-scaled threshold from score.rs).
  const topScore = result.scores[0]?.total ?? 0;
  // glob 约束型查询跳过 weak 降噪：约束查询的弱分数是命中信号而非模糊噪声
  const weak =
    topScore < weakScoreThreshold(pattern) && !hasGlobWildcards(pattern);
  const effective = weak ? Math.min(FIND_WEAK_SAMPLE_SIZE, limit) : limit;
  const shown = reordered.slice(0, effective);

  return {
    output: shown
      .map((p) => `${p.item.relativePath}${fffFileAnnotation(p.item)}`)
      .join("\n"),
    weak,
    shownCount: shown.length,
  };
}

// ---------------------------------------------------------------------------
// Mention autocomplete helpers
// ---------------------------------------------------------------------------

function extractAtPrefix(textBeforeCursor: string): string | null {
  const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
  return match?.[1] ?? null;
}

function buildAtCompletionValue(path: string): string {
  return path.includes(" ") ? `@"${path}"` : `@${path}`;
}

function createFffMentionProvider(
  getItems: (query: string, signal: AbortSignal) => Promise<AutocompleteItem[]>,
): AutocompleteProvider {
  return {
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const currentLine = lines[cursorLine] || "";
      const prefix = extractAtPrefix(currentLine.slice(0, cursorCol));
      if (!prefix || options.signal.aborted) return null;

      const query = prefix.startsWith('@"') ? prefix.slice(2) : prefix.slice(1);
      const items = await getItems(query, options.signal);
      return options.signal.aborted || items.length === 0
        ? null
        : { items, prefix };
    },
    applyCompletion(_lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = _lines[cursorLine] || "";
      const before = currentLine.slice(0, cursorCol - prefix.length);
      const after = currentLine.slice(cursorCol);
      const newLine = before + item.value + after;
      const newCursorCol = cursorCol - prefix.length + item.value.length;
      return {
        lines: [
          ..._lines.slice(0, cursorLine),
          newLine,
          ..._lines.slice(cursorLine + 1),
        ],
        cursorLine,
        cursorCol: newCursorCol,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function fffExtension(pi: ExtensionAPI) {
  let mainFinder: FileFinderApi | null = null;
  let finderCwd: string | null = null;
  // Concurrent ensureFinder() callers share the same in-flight promise so
  // FileFinder.create() (which takes native DB locks) runs at most once per
  // base path at a time — otherwise parallel tool calls would race and
  // deadlock at the native layer (issue #403).
  let finderPromise: Promise<FileFinderApi> | null = null;
  let activeCwd = process.cwd();

  const config = loadConfig();

  // All startup options use the same flag > env > file > fallback order.
  function getConfigValue<T>(
    flagName: string,
    envName: string,
    fileValue: T | undefined,
    fallback: T,
    parse: (value: unknown) => T | undefined = (value) => value as T,
  ): T {
    const flagValue = pi.getFlag(flagName);
    if (flagValue !== undefined) {
      const value = parse(flagValue);
      if (value !== undefined) return value;
    }

    const envValue = process.env[envName];
    if (envValue !== undefined) {
      const value = parse(envValue);
      if (value !== undefined) return value;
    }

    return fileValue ?? fallback;
  }

  function parseBoolean(value: unknown): boolean | undefined {
    if (typeof value === "boolean") return value;
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
    return undefined;
  }

  // prepareSession 完成后置 true（激活工具或 opt-out 通知已发）；作为
  // session_start / before_agent_start 重入守卫，保证 opt-out 通知只发一次。
  let sessionPrepared = false;
  let resolvedDbPaths: ReturnType<typeof resolveDbPaths>;
  let enableFsRootScanning = false;
  let enableHomeDirScanning = true;
  let warnOnHomeDirScan = true;
  let followSymlinks = true;

  function resolveStartupConfig(): void {
    resolvedDbPaths = resolveDbPaths({
      frecency: getConfigValue(
        "fff-frecency-db",
        "FFF_FRECENCY_DB",
        config.frecencyDbPath,
        undefined,
      ),
      history: getConfigValue(
        "fff-history-db",
        "FFF_HISTORY_DB",
        config.historyDbPath,
        undefined,
      ),
    });

    // Root scanning opt-in: FFF refuses to init at / unless this is set.
    enableFsRootScanning = getConfigValue(
      "fff-enable-root-scan",
      "FFF_ENABLE_ROOT_SCAN",
      config.enableFsRootScanning,
      false,
      parseBoolean,
    );
    // Home dir scanning is on by default (launching pi from $HOME is a normal
    // flow), but configurable so users with huge $HOME trees can opt out.
    enableHomeDirScanning = getConfigValue(
      "fff-enable-home-scan",
      "FFF_ENABLE_HOME_SCAN",
      config.enableHomeDirScanning,
      true,
      parseBoolean,
    );
    warnOnHomeDirScan = getConfigValue(
      "fff-warn-home-scan",
      "FFF_WARN_HOME_SCAN",
      config.warnOnHomeDirScan,
      true,
      parseBoolean,
    );
    // On by default: worktree and stow layouts reach their files through links,
    // and an agent silently missing them is worse than the extra walk.
    followSymlinks = getConfigValue(
      "fff-follow-symlinks",
      "FFF_FOLLOW_SYMLINKS",
      config.followSymlinks,
      true,
      parseBoolean,
    );
  }

  // Set on session_start; the only handle to the UI outside an event handler.
  // setStatus is TUI/RPC-only, hence optional.
  let uiCtx: {
    ui: {
      notify: (message: string, type?: "info" | "warning" | "error") => void;
      setStatus?: (key: string, text: string | undefined) => void;
    };
  } | null = null;
  let homeScanTimer: ReturnType<typeof setInterval> | null = null;

  function warnHomeDirScan(root: string): void {
    if (!warnOnHomeDirScan) return;
    uiCtx?.ui.notify(
      `(fff): Your cwd (${root}) is too large. Indexing will take additional time and resources.\n${HOME_SCAN_DISABLE_HINT}`,
      "warning",
    );
  }

  let pickers: FilePickerFactory | null = null;
  let auxPool: AuxFinderPool | null = null;

  function initializeFinderFactories(): void {
    if (pickers) return;

    pickers = new FilePickerFactory({
      frecencyDbPath: resolvedDbPaths.frecency,
      historyDbPath: resolvedDbPaths.history,
      onDbFailure: (error) =>
        uiCtx?.ui.notify(
          `(fff): Failed to open frecency/history database (${error}). Continuing without frecency persistence.`,
          "error",
        ),
    });
    auxPool = new AuxFinderPool({
      enableFsRootScanning,
      enableHomeDirScanning,
      followSymlinks,
      onHomeDirScan: warnHomeDirScan,
      pickers,
    });
  }

  // The native layer refuses a picker rooted at $HOME / the fs root unless the
  // matching opt-in is set (crates/fff-core/src/file_picker.rs). Detect that here
  // so the opt-out reads as "search off" instead of an init failure (issue #857).
  function scanOptOutReason(cwd: string): string | null {
    if (!enableHomeDirScanning && isHomeDir(cwd))
      return `(fff): cwd is $HOME and "enableHomeDirScanning" is false, so FFF search is disabled for this session. Start pi from a project directory, or set "enableHomeDirScanning": true / --fff-enable-home-scan=true to index $HOME.`;
    if (!enableFsRootScanning && isFsRoot(cwd))
      return `(fff): cwd is the filesystem root and "enableFsRootScanning" is false, so FFF search is disabled for this session. Start pi from a project directory, or set "enableFsRootScanning": true / --fff-enable-root-scan=true to index it.`;
    return null;
  }

  // in case cwd changes we need to figure this out
  function ensureFinder(cwd: string): Promise<FileFinderApi> {
    const optOut = scanOptOutReason(cwd);
    if (optOut) return Promise.reject(new Error(optOut));

    if (mainFinder && !mainFinder.isDestroyed && finderCwd === cwd)
      return Promise.resolve(mainFinder);

    if (finderPromise) return finderPromise;

    finderPromise = (async () => {
      if (mainFinder && !mainFinder.isDestroyed) {
        mainFinder.destroy();
        mainFinder = null;
        finderCwd = null;
      }

      // if the dbs can't be opened the factory falls back to a db-less picker,
      // e.g. when some other process corrupts the lock
      if (!pickers) throw new Error("FFF picker factory is not initialized");
      mainFinder = await pickers.create({
        basePath: cwd,
        enableHomeDirScanning,
        enableFsRootScanning,
        followSymlinks,
      });
      finderCwd = cwd;
      return mainFinder;
    })().finally(() => {
      finderPromise = null;
    });

    return finderPromise;
  }

  function stopHomeScanStatus(): void {
    if (homeScanTimer) {
      clearInterval(homeScanTimer);
      homeScanTimer = null;
    }
    uiCtx?.ui.setStatus?.(HOME_SCAN_STATUS_KEY, undefined);
  }

  // waitForScan() resolves on timeout too, so the scan can still be running.
  // Poll the live progress until it settles, then clear the footer.
  function trackHomeScanStatus(): void {
    stopHomeScanStatus();
    if (!uiCtx?.ui.setStatus) return;

    const tick = () => {
      const progress = mainFinder?.getScanProgress?.();
      if (!progress?.ok || !progress.value.isScanning) {
        stopHomeScanStatus();
        return;
      }
      uiCtx?.ui.setStatus?.(
        HOME_SCAN_STATUS_KEY,
        `Agent is indexing $HOME (${progress.value.scannedFilesCount} files), this can lead to high CPU`,
      );
    };

    homeScanTimer = setInterval(tick, HOME_SCAN_POLL_MS);
    // Must not hold the process open once pi is done.
    (homeScanTimer as { unref?: () => void }).unref?.();
    tick();
  }

  function destroyFinder() {
    stopHomeScanStatus();
    if (mainFinder && !mainFinder.isDestroyed) {
      mainFinder.destroy();
      mainFinder = null;
      finderCwd = null;
    }

    auxPool?.destroy();
    auxPool = null;
    pickers = null;
  }

  async function resolveFinderForPath(
    pathParam: string | undefined,
    pattern: string,
    exclude: string | string[] | undefined,
  ): Promise<{ finder: FileFinderApi; query: string; root: string } | null> {
    const route = routePathConstraint(pathParam, activeCwd);
    if (!route) return null;
    if (!auxPool)
      throw new Error("FFF auxiliary finder pool is not initialized");
    const aux = await auxPool.acquire(route.root);
    // A broader covering picker may have been reused; rebase the suffix so the
    // constraint stays relative to the picker's actual root.
    const rebase = nodePath
      .relative(aux.root, route.root)
      .replaceAll(nodePath.sep, "/");
    const suffix = [rebase, route.suffix].filter(Boolean).join("/");
    const query = buildQuery(suffix || undefined, pattern, exclude, aux.root);
    return { finder: aux.finder, query, root: aux.root };
  }

  async function getMentionItems(
    query: string,
    signal: AbortSignal,
  ): Promise<AutocompleteItem[]> {
    if (signal.aborted) return [];
    const f = await ensureFinder(activeCwd);
    if (signal.aborted) return [];

    const result = f.mixedSearch(query, { pageSize: MENTION_MAX_RESULTS });
    if (!result.ok) return [];

    return result.value.items
      .slice(0, MENTION_MAX_RESULTS)
      .map((mixed: MixedItem) => {
        if (mixed.type === "directory") {
          return {
            value: buildAtCompletionValue(mixed.item.relativePath),
            label: mixed.item.dirName,
            description: mixed.item.relativePath,
          };
        }
        return {
          value: buildAtCompletionValue(mixed.item.relativePath),
          label: mixed.item.fileName,
          description: mixed.item.relativePath,
        };
      });
  }

  function registerAutocompleteProvider(ctx: {
    ui: {
      addAutocompleteProvider?: (
        factory: (current: AutocompleteProvider) => AutocompleteProvider,
      ) => void;
    };
  }) {
    // pi forks (e.g. omp) may not expose addAutocompleteProvider; skip UI wiring
    // and let tools continue to work instead of failing session_start.
    if (typeof ctx.ui.addAutocompleteProvider !== "function") return;

    ctx.ui.addAutocompleteProvider((current) => {
      const mentionProvider = createFffMentionProvider(getMentionItems);
      // True when the FFF provider served the current suggestions: applying a
      // selection must then go through the FFF completion, not pi's native one.
      let fffServed = false;

      return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
          try {
            const mentionResult = await mentionProvider.getSuggestions(
              lines,
              cursorLine,
              cursorCol,
              options,
            );
            if (mentionResult) {
              fffServed = true;
              return mentionResult;
            }
          } catch {
            // Delegate when FFF lookup is unavailable.
          }
          fffServed = false;

          return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
          return (fffServed ? mentionProvider : current).applyCompletion(
            lines,
            cursorLine,
            cursorCol,
            item,
            prefix,
          );
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
          return (
            current.shouldTriggerFileCompletion?.(
              lines,
              cursorLine,
              cursorCol,
            ) ?? true
          );
        },
      };
    });
  }

  // --- Flags / lifecycle ---

  pi.registerFlag("fff-frecency-db", {
    description:
      "Path to the frecency database (overrides FFF_FRECENCY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-history-db", {
    description:
      "Path to the query history database (overrides FFF_HISTORY_DB env)",
    type: "string",
  });

  pi.registerFlag("fff-enable-root-scan", {
    description:
      "Allow indexing when launched from the filesystem root (also: FFF_ENABLE_ROOT_SCAN env)",
    type: "boolean",
  });

  pi.registerFlag("fff-enable-home-scan", {
    description:
      "Index the home dir when launched from $HOME (default true; disable with --fff-enable-home-scan=false or FFF_ENABLE_HOME_SCAN=0)",
    type: "boolean",
  });

  pi.registerFlag("fff-follow-symlinks", {
    description:
      "Index through directory symlinks, e.g. a git worktree or stow layout (default true; disable with --fff-follow-symlinks=false or FFF_FOLLOW_SYMLINKS=0)",
    type: "boolean",
  });

  pi.registerFlag("fff-warn-home-scan", {
    description:
      "Warn when indexing $HOME (default true; silence with --fff-warn-home-scan=false or FFF_WARN_HOME_SCAN=0)",
    type: "boolean",
  });

  function reportInitFailure(ctx: ExtensionContext, error: unknown): void {
    ctx.ui.notify(
      `FFF init failed: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }

  function prepareSession(ctx: ExtensionContext): void {
    activeCwd = ctx.cwd;
    uiCtx = ctx;
    if (sessionPrepared) return;

    resolveStartupConfig();
    initializeFinderFactories();

    // pi 会无条件激活扩展工具（includeAllExtensionTools），opt-out 目录无法靠
    // "不激活"隐身，需显式把 grep/find 从激活集移除，仅通知用户禁用的原因。
    const optOut = scanOptOutReason(activeCwd);
    if (optOut) {
      sessionPrepared = true;
      ctx.ui.notify(optOut, "warning");
      pi.setActiveTools(
        pi
          .getActiveTools()
          .filter(
            (name) => name !== TOOL_NAMES.grep && name !== TOOL_NAMES.find,
          ),
      );
      return;
    }

    // 去重合并：不覆盖 pi 已激活的其他工具，仅追加 grep/find。
    pi.setActiveTools([
      ...new Set([...pi.getActiveTools(), TOOL_NAMES.grep, TOOL_NAMES.find]),
    ]);
    sessionPrepared = true;
  }

  pi.on("session_start", async (_event, ctx) => {
    try {
      prepareSession(ctx);
      registerAutocompleteProvider(ctx);

      // 用户已对该 cwd 选择 opt-out；prepareSession 已发通知，这里直接跳过
      // 索引初始化，避免原生层拒绝以 init 失败的形式报错（issue #857）。
      if (scanOptOutReason(activeCwd)) return;

      await ensureFinder(activeCwd);

      // Warn when launched from $HOME with home scanning on: indexing a large
      // home tree can run for a long time in the background (issue #743).
      const atHome = enableHomeDirScanning && isHomeDir(activeCwd);
      if (atHome) {
        warnHomeDirScan(activeCwd);
        ctx.ui.setStatus?.(
          HOME_SCAN_STATUS_KEY,
          "Agent is indexing $HOME, this can lead to high CPU",
        );
      }

      // waitForScan() also resolves on timeout, so poll until the scan really
      // settles before clearing the footer.
      if (atHome) trackHomeScanStatus();
    } catch (error: unknown) {
      reportInitFailure(ctx, error);
    }
  });

  // SDK callers can prompt without binding session_start. Prepare on the first
  // agent turn as a fallback so the tools still reach that turn's tool set.
  pi.on("before_agent_start", (_event, ctx) => {
    if (sessionPrepared) return;
    try {
      prepareSession(ctx);
    } catch (error: unknown) {
      reportInitFailure(ctx, error);
    }
  });

  pi.on("session_shutdown", async () => {
    destroyFinder();
    // 会话替换/新会话可能复用同一扩展实例：复位守卫，下次 session_start 重新
    // 评估激活与 opt-out（工厂已随 destroyFinder 销毁，不复位将无法重建）。
    sessionPrepared = false;
  });

  // --- Shared render helpers ---

  class CollapsedText implements Component {
    constructor(
      private readonly preview: string,
      private readonly suffix: string,
      private readonly marker: string,
    ) {}

    render(width: number): string[] {
      const availableWidth = Math.max(1, width);
      if (!this.suffix) {
        if (visibleWidth(this.preview) <= availableWidth) return [this.preview];
        const markerWidth = visibleWidth(this.marker);
        if (markerWidth >= availableWidth) {
          return [sliceByColumn(this.marker, 0, availableWidth, true)];
        }
        return [
          `${sliceByColumn(this.preview, 0, availableWidth - markerWidth, true)}${this.marker}`,
        ];
      }

      const suffixWidth = visibleWidth(this.suffix);
      if (suffixWidth >= availableWidth) {
        return [sliceByColumn(this.suffix, 0, availableWidth, true)];
      }

      const previewWidth = availableWidth - suffixWidth - 1;
      if (visibleWidth(this.preview) <= previewWidth) {
        return [`${this.preview} ${this.suffix}`];
      }

      const markerWidth = visibleWidth(this.marker);
      return [
        `${sliceByColumn(this.preview, 0, Math.max(0, previewWidth - markerWidth), true)}${this.marker} ${this.suffix}`,
      ];
    }

    invalidate(): void {}
  }

  // Pi wraps returned components in its own click-to-expand MouseRegion and passes
  // the toggled state via options.expanded, so no custom mouse handling is needed.
  const renderCompactTextResult = (
    result: { content?: { type: string; text?: string }[] },
    options: { expanded?: boolean },
    theme: any,
    context: any,
  ): Component => {
    const output =
      result.content?.find((c) => c.type === "text")?.text?.trim() ?? "";
    if (!output) return new Text(theme.fg("muted", "No output"), 0, 0);

    const lines = output.split("\n");
    const color = context.isError ? "error" : "toolOutput";
    if (options.expanded) {
      return new Text(
        lines.map((line) => theme.fg(color, line)).join("\n"),
        0,
        0,
      );
    }

    const suffix =
      lines.length > 1
        ? theme.fg("muted", `... (${lines.length - 1} more lines)`)
        : "";
    return new CollapsedText(
      theme.fg(color, lines[0] ?? ""),
      suffix,
      theme.fg("muted", "..."),
    );
  };

  // --- grep tool ---

  // Shared by both tools: the path scope and exclusion syntax is identical.
  const pathExcludeSchema = {
    path: Type.Optional(
      Type.String({
        description:
          "Path constraint. Directory prefix (src/ or src/foo/), bare filename with extension (main.rs), or glob (*.ts, src/**/*.cc, {src,lib}/**). Applied to the full repo-relative path. Absolute, ~/, and ../ paths outside the workspace are also supported and searched with a separate index.",
      }),
    ),
    exclude: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String())], {
        description:
          "Exclude paths (comma/space-separated or array). Same syntax as path: directory prefix ('test/'), filename with extension ('config.json'), or glob ('*.min.js', '**/*.{rs,go}'). A leading '!' is optional and ignored — both 'test/' and '!test/' work. Example: 'test/,*.min.js,!vendor/'.",
      }),
    ),
  } as const;

  const grepSchema = Type.Object({
    pattern: Type.String({
      description: "Search pattern (literal text or regex)",
    }),
    ...pathExcludeSchema,
    caseSensitive: Type.Optional(
      Type.Boolean({
        description:
          "Force case-sensitive matching. Default uses smart-case (case-insensitive when pattern is all lowercase).",
      }),
    ),
    context: Type.Optional(
      Type.Number({
        description: `Context lines before+after each match (0-${GREP_CONTEXT_MAX})`,
      }),
    ),
    limit: Type.Optional(
      Type.Number({
        description: `Max matches (default ${DEFAULT_GREP_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  pi.registerTool({
    name: TOOL_NAMES.grep,
    label: TOOL_NAMES.grep,
    description: `Grep file contents. Smart-case, auto-detects regex vs literal, git-aware. Results are ranked by frecency (most-accessed files first); matches within a file stay in source order. Default limit ${DEFAULT_GREP_LIMIT}.`,
    promptSnippet: "Grep contents",
    promptGuidelines: [
      `${TOOL_NAMES.grep}: prefer bare identifiers as patterns. Literal queries are most efficient.`,
      `${TOOL_NAMES.grep}: use path for include ('src/', '*.ts') and exclude for noise ('test/,*.min.js').`,
      `${TOOL_NAMES.grep}: caseSensitive: true when you need exact case (smart-case otherwise).`,
      `${TOOL_NAMES.grep}: after 1-2 greps, read the top match instead of more greps.`,
    ],
    parameters: grepSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      const pattern = params.pattern;
      const aux = await resolveFinderForPath(
        params.path,
        pattern,
        params.exclude,
      );

      const picker = aux ? aux.finder : await ensureFinder(activeCwd);
      const effectiveLimit = Math.max(1, params.limit ?? DEFAULT_GREP_LIMIT);
      // pageSize caps TOTAL matches across all files (soft cap: the current file
      // is always finished first). maxMatchesPerFile stays decoupled at the engine
      // default so same-file overflow remains reachable via cursor (#825).
      const pageSize = Math.min(effectiveLimit, GREP_PAGE_SIZE_MAX);
      const context = clampContext(params.context);
      const query = aux
        ? aux.query
        : buildQuery(params.path, pattern, params.exclude, activeCwd);

      // Auto-detect: regex if the pattern has regex metacharacters AND parses
      // as a valid regex, otherwise plain literal. The fuzzy fallback below
      // only kicks in for plain mode — regex queries are intentional.
      const hasRegexSyntax =
        pattern !== pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

      let mode: GrepMode = hasRegexSyntax ? "regex" : "plain";
      if (mode === "regex") {
        try {
          new RegExp(pattern);
        } catch {
          mode = "plain";
        }
      }

      // Guard: the agent keeps calling grep with '.*' or similar wildcard-only regex
      // to try to read a whole file. That's not what grep is for — return a terse error
      // steering them to a real pattern, preventing dozens of wasted retries.
      const p = pattern.trim();
      const isWildcardOnly =
        hasRegexSyntax &&
        /^(?:[.^$]*(?:[.][*+?]|\*|\+)[.^$]*|[.^$\s]*|\.\*\??|\.\*[+?]?|\.\+\??|\.|\*|\?)$/.test(
          p,
        );

      if (isWildcardOnly) {
        return {
          content: [
            {
              type: "text",
              text: `Pattern '${params.pattern}' matches everything — grep needs a concrete substring or identifier. Example: \`pattern: 'MyClass'\` or \`pattern: 'export function'\`.`,
            },
          ],
          details: { totalMatched: 0, totalFiles: 0 },
        };
      }

      // caseSensitive override flips smartCase off; omitting it keeps smart-case
      // (case-insensitive when pattern is all lowercase).
      const smartCase = params.caseSensitive !== true;

      const grepResult = picker.grep(query, {
        mode,
        smartCase,
        maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
        pageSize,
        cursor: (params.cursor ? getCursor(params.cursor) : null) ?? null,
        beforeContext: context,
        afterContext: context,
        classifyDefinitions: true,
        timeBudgetMs: GREP_TIME_BUDGET_MS,
      });

      if (!grepResult.ok) throw new Error(grepResult.error);

      let result = grepResult.value;
      let fuzzyNotice: string | null = null;

      // if we hit the timeout do not run the fuzzy fallback
      // cause it will only consumer more time
      if (
        result.items.length === 0 &&
        !result.nextCursor &&
        !params.cursor &&
        mode !== "regex" &&
        // caseSensitive=true 为严格语义：0 精确命中直接返回，不启动 fuzzy 降级
        params.caseSensitive !== true
      ) {
        // When the caller pinned a specific file (path has an extension), the
        // fuzzy fallback broadens across the whole picker — the file may just
        // be misnamed. For directory constraints (or no path), we keep the
        // constrained query so the fallback does not leak matches from
        // excluded / out-of-scope directories.
        const lastSeg = params.path?.split(/[\\/]/).pop() ?? "";
        const pathTargetsFile = /\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSeg);
        const fuzzyQuery = pathTargetsFile ? pattern : query;
        const fuzzy = picker.grep(fuzzyQuery, {
          mode: "fuzzy",
          smartCase,
          maxMatchesPerFile: GREP_MAX_MATCHES_PER_FILE,
          pageSize,
          cursor: null,
          beforeContext: 0,
          afterContext: 0,
          classifyDefinitions: true,
          timeBudgetMs: GREP_TIME_BUDGET_MS,
        });

        if (fuzzy.ok && fuzzy.value.items.length > 0) {
          fuzzyNotice = `0 exact matches. Maybe you meant this?`;
          result = fuzzy.value;
        }
      }

      let output = formatGrepOutput(result);
      const notices: string[] = [];
      // 结果非空时探测段型排除项，拼错目录名的静默失效变为可见提示
      appendExcludeSegmentHints(
        notices,
        params.exclude,
        picker,
        aux?.root ?? activeCwd,
        result.items.length > 0,
      );
      if (result.regexFallbackError) {
        notices.push(
          `Invalid regex: ${result.regexFallbackError}, used literal match`,
        );
      }
      if (result.nextCursor) {
        notices.push(
          `Continue with cursor="${storeCursor(result.nextCursor)}"`,
        );
      }

      output = appendNotices(output, notices);
      if (fuzzyNotice) output = `[${fuzzyNotice}]\n${output}`;

      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
        },
      };
    },

    renderCall(args, theme, context) {
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(TOOL_NAMES.grep)) +
        " " +
        theme.fg("accent", `/${pattern}/`) +
        theme.fg("toolOutput", ` in ${path}`);
      const options: string[] = [];
      if (args?.limit !== undefined) options.push(`limit ${args.limit}`);
      if (args?.context !== undefined) options.push(`context ${args.context}`);
      if (options.length > 0)
        content += theme.fg("toolOutput", ` (${options.join(", ")})`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      return new CollapsedText(content, "", theme.fg("muted", "..."));
    },

    renderResult(result, options, theme, context) {
      return renderCompactTextResult(result, options, theme, context);
    },
  });

  // --- find tool ---

  const findSchema = Type.Object({
    pattern: Type.String({
      description:
        "Fuzzy filename search and glob search. Frecency-ranked, git-aware. Multi-word = narrower (AND) not bound to order, use for multi word related concept search. Prefer this over ls/find/bash as the first exploration step whenever the user names a concept, feature, or symbol — it surfaces the relevant files in one call. Only use ls/read on a directory when you specifically need the alphabetical layout of an unknown repo, or when a concept search returned nothing.",
    }),
    ...pathExcludeSchema,
    limit: Type.Optional(
      Type.Number({
        description: `Max results per page (default ${DEFAULT_FIND_LIMIT})`,
      }),
    ),
    cursor: Type.Optional(
      Type.String({ description: "Pagination cursor from previous result" }),
    ),
  });

  pi.registerTool({
    name: TOOL_NAMES.find,
    label: TOOL_NAMES.find,
    description: `Fuzzy path search and glob search. Matches against the whole repo-relative path, not just the filename. Frecency-ranked, git-aware. Multi-word = narrower (AND). Default limit ${DEFAULT_FIND_LIMIT}.`,
    promptSnippet: "Find files by path or glob",
    promptGuidelines: [
      `${TOOL_NAMES.find}: matches the WHOLE path, not just the filename — \`profile\` hits \`chrome/browser/profiles/x.cc\` too.`,
      `${TOOL_NAMES.find}: keep queries to 1-2 terms; extra words narrow.`,
      `${TOOL_NAMES.find}: use for paths, not content. Use ${TOOL_NAMES.grep} for content.`,
      `${TOOL_NAMES.find}: for exact path matches use a glob in \`path\` — e.g. path: '**/profile.h' for exact filename, or path: 'src/**/profile.h' scoped to a subtree. Bare patterns are fuzzy.`,
      `${TOOL_NAMES.find}: to list everything inside a directory, pass path: 'dir/**' with an empty or wildcard pattern instead of using pattern alone.`,
      `${TOOL_NAMES.find}: use exclude: 'test/,*.min.js' to cut noise in large repos.`,
    ],
    parameters: findSchema,

    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error("Operation aborted");

      // if resumed we use the same picker as before
      const resumed = params.cursor ? getFindCursor(params.cursor) : undefined;
      const pool = auxPool;
      if (!pool)
        throw new Error("FFF auxiliary finder pool is not initialized");
      const aux = resumed
        ? resumed.auxRoot
          ? {
              finder: (await pool.acquire(resumed.auxRoot, { exact: true }))
                .finder,
              root: resumed.auxRoot,
            }
          : null
        : await resolveFinderForPath(
            params.path,
            params.pattern,
            params.exclude,
          );

      const picker = aux ? aux.finder : await ensureFinder(activeCwd);
      const effectiveLimit = resumed
        ? resumed.pageSize
        : Math.max(1, params.limit ?? DEFAULT_FIND_LIMIT);

      const query = resumed
        ? resumed.query
        : aux && "query" in aux
          ? (aux as { query: string }).query
          : buildQuery(params.path, params.pattern, params.exclude, activeCwd);

      const pattern = resumed ? resumed.pattern : params.pattern;
      // 绝对偏移翻页：原生 page_index 即 skip 偏移（score.rs skip(offset).take(limit)），
      // 续页时以累计偏移续查，避免页码口径错配导致结果重叠。
      const offset = resumed?.nextOffset ?? 0;
      const auxRoot = resumed?.auxRoot ?? aux?.root;

      const searchResult = picker.fileSearch(query, {
        pageIndex: offset,
        pageSize: effectiveLimit,
      });
      if (!searchResult.ok) throw new Error(searchResult.error);

      const result = searchResult.value;
      const formatted = formatFindOutput(result, effectiveLimit, pattern);
      let output = formatted.output;

      // Infer hasMore: native fileSearch fills pageSize when more results
      // exist, so if we got a full page AND totalMatched exceeds what we've
      // shown so far there's another page to fetch.
      const shownSoFar = offset + result.items.length;
      const hasMore =
        result.items.length >= effectiveLimit &&
        result.totalMatched > shownSoFar;

      const notices: string[] = [];
      // 结果非空时探测段型排除项，拼错目录名的静默失效变为可见提示
      appendExcludeSegmentHints(
        notices,
        params.exclude,
        picker,
        aux?.root ?? activeCwd,
        result.items.length > 0,
      );
      if (formatted.weak && formatted.shownCount > 0)
        notices.push(
          `Query "${pattern}" produced only weak scattered fuzzy matches. Output capped at ${formatted.shownCount}/${result.totalMatched}.`,
        );

      if (!formatted.weak && hasMore) {
        const remaining = result.totalMatched - shownSoFar;
        const cursorId = storeFindCursor({
          query,
          pattern,
          pageSize: effectiveLimit,
          // 当次 offset + 本页条数 = 下一页的绝对偏移
          nextOffset: offset + result.items.length,
          auxRoot,
        });
        notices.push(
          `${remaining} more match${remaining === 1 ? "" : "es"} available. cursor="${cursorId}" to continue`,
        );
      }

      output = appendNotices(output, notices);
      return {
        content: [{ type: "text", text: output }],
        details: {
          totalMatched: result.totalMatched,
          totalFiles: result.totalFiles,
          // 本页起始的绝对偏移（原"页码"表述在新 offset 契约下不准确）
          pageIndex: offset,
          hasMore,
        },
      };
    },

    renderCall(args, theme, context) {
      const pattern = args?.pattern ?? "";
      const path = args?.path ?? ".";
      let content =
        theme.fg("toolTitle", theme.bold(TOOL_NAMES.find)) +
        " " +
        theme.fg("accent", pattern) +
        theme.fg("toolOutput", ` in ${path}`);
      if (args?.limit !== undefined)
        content += theme.fg("toolOutput", ` (limit ${args.limit})`);
      if (args?.cursor) content += theme.fg("muted", ` (page)`);
      return new CollapsedText(content, "", theme.fg("muted", "..."));
    },

    renderResult(result, options, theme, context) {
      return renderCompactTextResult(result, options, theme, context);
    },
  });

  // --- commands ---

  pi.registerCommand("fff-health", {
    description: "Show FFF file finder health and status",
    handler: async (_args, ctx) => {
      if (!mainFinder || mainFinder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }

      const health = mainFinder.healthCheck();
      if (!health.ok) {
        ctx.ui.notify(`Health check failed: ${health.error}`, "error");
        return;
      }

      const lines = [
        `FFF v${health.value.version}`,
        `Git: ${health.value.git.repositoryFound ? `yes (${health.value.git.workdir ?? "unknown"})` : "no"}`,
        `Picker: ${health.value.filePicker.initialized ? `${health.value.filePicker.indexedFiles ?? 0} files` : "not initialized"}`,
        `Frecency: ${health.value.frecency.initialized ? "active" : "disabled"}`,
        `Query tracker: ${health.value.queryTracker.initialized ? "active" : "disabled"}`,
      ];

      const progress = mainFinder.getScanProgress();
      if (progress.ok) {
        lines.push(
          `Scanning: ${progress.value.isScanning ? "yes" : "no"} (${progress.value.scannedFilesCount} files)`,
        );
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("fff-rescan", {
    description: "Trigger FFF to rescan files",
    handler: async (_args, ctx) => {
      if (!mainFinder || mainFinder.isDestroyed) {
        ctx.ui.notify("FFF not initialized", "warning");
        return;
      }

      const result = mainFinder.scanFiles();
      if (!result.ok) {
        ctx.ui.notify(`Rescan failed: ${result.error}`, "error");
        return;
      }

      ctx.ui.notify("FFF rescan triggered", "info");
    },
  });
}

// 检测查询串是否含 glob 通配符（* ? [ {），与 parser has_wildcards 同字符集
function hasGlobWildcards(pattern: string): boolean {
  return GLOB_WILDCARDS_RE.test(pattern);
}

// exclude 段存在性探测：段型排除项拼错（如 tests/ 而非 test/）会静默失效，
// 对每个段做最小查询（pageSize 1），0 命中即在 notices 追加提示并静默跳过失败。
function appendExcludeSegmentHints(
  notices: string[],
  exclude: string | string[] | undefined,
  picker: FileFinderApi,
  cwd: string,
  hasResults: boolean,
): void {
  if (!hasResults) return;
  for (const segment of normalizedExcludeSegments(exclude, cwd)) {
    try {
      const probe = picker.fileSearch(segment, { pageSize: 1 });
      if (probe.ok && probe.value.items.length === 0) {
        notices.push(
          `exclude '${segment}' did not exclude any paths — it looks like the directory is misspelled or not in the index`,
        );
      }
    } catch {
      // 探测失败静默跳过
    }
  }
}
