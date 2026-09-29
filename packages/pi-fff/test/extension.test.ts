import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type MockFinder = {
  isDestroyed: boolean;
  waitForScan: ReturnType<typeof mock>;
  mixedSearch: ReturnType<typeof mock>;
  grep: ReturnType<typeof mock>;
  fileSearch: ReturnType<typeof mock>;
  getScanProgress: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
};

const createCalls: unknown[] = [];
let finders: MockFinder[] = [];
let mixedSearchImpl: ((query: string, options: unknown) => unknown) | undefined;
let grepImpl: ((query: string, options: unknown) => unknown) | undefined;
let fileSearchImpl: ((query: string, options: unknown) => unknown) | undefined;
let scanProgressImpl: (() => unknown) | undefined;

function createMockFinder(): MockFinder {
  return {
    isDestroyed: false,
    waitForScan: mock(async () => undefined),
    getScanProgress: mock(() => {
      if (scanProgressImpl) return scanProgressImpl();
      return {
        ok: true,
        value: {
          scannedFilesCount: 0,
          isScanning: false,
          isWatcherReady: true,
          isWarmupComplete: true,
        },
      };
    }),
    mixedSearch: mock((query: string, options: unknown) => {
      if (mixedSearchImpl) return mixedSearchImpl(query, options);
      return {
        ok: true,
        value: {
          items: [],
          scores: [],
          totalMatched: 0,
          totalFiles: 0,
          totalDirs: 0,
        },
      };
    }),
    grep: mock((query: string, options: unknown) => {
      if (grepImpl) return grepImpl(query, options);
      return {
        ok: true,
        value: {
          items: [],
          totalMatched: 0,
          totalFiles: 0,
          totalFilesSearched: 0,
          filteredFileCount: 0,
          nextCursor: null,
        },
      };
    }),
    fileSearch: mock((query: string, options: unknown) => {
      if (fileSearchImpl) return fileSearchImpl(query, options);
      return {
        ok: true,
        value: {
          items: [],
          scores: [],
          totalMatched: 0,
          totalFiles: 0,
        },
      };
    }),
    destroy: mock(function (this: MockFinder) {
      this.isDestroyed = true;
    }),
  };
}

const NATIVE_ROOT_REFUSAL =
  "Failed to init file picker: Can not run certain FFF features in a file system root or home directories. Consider smaller per-project directories.";

// Mirrors the native guard in crates/fff-core/src/file_picker.rs: a picker rooted
// at $HOME or `/` is refused unless the matching opt-in is set.
function nativeRefusal(options: {
  basePath: string;
  enableHomeDirScanning?: boolean;
  enableFsRootScanning?: boolean;
}): boolean {
  const base = path.resolve(options.basePath);
  if (
    options.enableHomeDirScanning === false &&
    base === path.resolve(os.homedir())
  )
    return true;
  return options.enableFsRootScanning === false && path.dirname(base) === base;
}

// 原生层默认行为；测试可经 mockImplementation 注入失败以覆盖 init 失败路径。
function defaultCreate(options: any) {
  createCalls.push(options);
  if (nativeRefusal(options)) return { ok: false, error: NATIVE_ROOT_REFUSAL };
  const finder = createMockFinder();
  finders.push(finder);
  return { ok: true, value: finder };
}

const finderModule = {
  FileFinder: {
    create: mock(defaultCreate),
  },
};

mock.module("@ff-labs/fff-node", () => finderModule);
mock.module("@ff-labs/fff-bun", () => finderModule);

mock.module("@earendil-works/pi-tui", () => ({
  MouseRegion: class MouseRegion {
    constructor(
      public component: any,
      public onMouse: (event: any) => unknown,
    ) {}
  },
  Text: class Text {
    text: string;
    constructor(text: string) {
      this.text = text;
    }
    setText(text: string) {
      this.text = text;
    }
  },
  sliceByColumn: (text: string, _start: number, end: number) =>
    text.slice(0, end),
  visibleWidth: (text: string) => text.length,
}));

const schema = (type: string) => (options?: unknown) => ({ type, options });

mock.module("@sinclair/typebox", () => ({
  Type: {
    Array: (items: unknown, options?: unknown) => ({
      type: "array",
      items,
      options,
    }),
    Boolean: schema("boolean"),
    Number: schema("number"),
    Object: (properties: unknown, options?: unknown) => ({
      type: "object",
      properties,
      options,
    }),
    Optional: (value: Record<string, unknown>) => ({
      ...value,
      optional: true,
    }),
    String: schema("string"),
    Union: (items: unknown[], options?: unknown) => ({
      type: "union",
      items,
      options,
    }),
  },
}));

const { default: fffExtension } = await import("../src/index");

type EventHandler = (...args: any[]) => unknown;

function createPi(flags: Record<string, unknown> = {}) {
  const events = new Map<string, EventHandler>();
  const commands = new Map<string, any>();
  const registeredFlags = new Set<string>();
  let flagsReady = false;

  const pi = {
    getFlag: mock((name: string) => {
      if (!flagsReady || !registeredFlags.has(name)) return undefined;
      return flags[name];
    }),
    on: mock((event: string, handler: EventHandler) => {
      events.set(event, (...args) => {
        flagsReady = true;
        return handler(...args);
      });
    }),
    registerCommand: mock((name: string, command: any) => {
      commands.set(name, {
        ...command,
        handler: (...args: any[]) => {
          flagsReady = true;
          return command.handler(...args);
        },
      });
    }),
    registerFlag: mock((name: string) => {
      registeredFlags.add(name);
    }),
    registerTool: mock((_tool: any) => undefined),
    getActiveTools: mock(() => ["read"] as string[]),
    setActiveTools: mock((_names: string[]) => undefined),
    appendEntry: mock((_customType: string, _data: unknown) => undefined),
  };

  return { pi, events, commands };
}

function createContext(cwd = "/tmp/workspace") {
  return {
    cwd,
    // Signatures mirror the real pi UI surface so mock.calls stays typed.
    ui: {
      addAutocompleteProvider: mock(
        (_factory: (current: any) => any) => undefined,
      ),
      notify: mock((_message: string, _level?: string) => undefined),
      setEditorComponent: mock(() => undefined),
      setStatus: mock((_key: string, _text?: string) => undefined),
    },
  };
}

async function start(cwd?: string, flags: Record<string, unknown> = {}) {
  const setup = createPi(flags);
  const ctx = createContext(cwd);
  fffExtension(setup.pi as any);

  const sessionStart = setup.events.get("session_start");
  expect(sessionStart).toBeDefined();
  await sessionStart?.({ reason: "startup" }, ctx);

  return { ...setup, ctx };
}

async function shutdown(setup: { events: Map<string, EventHandler> }) {
  await setup.events.get("session_shutdown")?.({}, undefined);
}

function currentProvider(
  result = { items: [{ value: "base", label: "base" }], prefix: "ba" },
) {
  return {
    getSuggestions: mock(async () => result),
    applyCompletion: mock(() => ({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    })),
    shouldTriggerFileCompletion: mock(() => false),
  };
}

function abortOptions() {
  return { signal: new AbortController().signal };
}

const CONFIG_ENV_KEYS = [
  "PI_CODING_AGENT_DIR",
  "FFF_FRECENCY_DB",
  "FFF_HISTORY_DB",
  "FFF_ENABLE_ROOT_SCAN",
  "FFF_ENABLE_HOME_SCAN",
  "FFF_WARN_HOME_SCAN",
  "FFF_FOLLOW_SYMLINKS",
] as const;

const savedEnv: Record<string, string | undefined> = {};
for (const key of CONFIG_ENV_KEYS) savedEnv[key] = process.env[key];

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-fff-extension-"));
const configPath = path.join(agentDir, "pi-fff.json");

beforeEach(() => {
  createCalls.length = 0;
  finders = [];
  mixedSearchImpl = undefined;
  grepImpl = undefined;
  fileSearchImpl = undefined;
  scanProgressImpl = undefined;
  finderModule.FileFinder.create.mockImplementation(defaultCreate);

  for (const key of CONFIG_ENV_KEYS) delete process.env[key];
  process.env.PI_CODING_AGENT_DIR = agentDir;
  fs.rmSync(configPath, { force: true });
});

afterAll(() => {
  for (const key of CONFIG_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
});

describe("pi-fff global config", () => {
  test("applies every supported startup option", async () => {
    writeConfig({
      frecencyDbPath: "/config/frecency",
      historyDbPath: "/config/history",
      enableFsRootScanning: true,
      enableHomeDirScanning: false,
      followSymlinks: false,
    });

    const setup = await start();
    const toolNames = setup.pi.registerTool.mock.calls.map(
      ([tool]) => tool.name,
    );

    expect(toolNames).toEqual(["grep", "find"]);
    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining(["grep", "find"]),
    );
    expect(createCalls[0]).toEqual({
      basePath: "/tmp/workspace",
      frecencyDbPath: "/config/frecency",
      historyDbPath: "/config/history",
      aiMode: true,
      enableHomeDirScanning: false,
      enableFsRootScanning: true,
      followSymlinks: false,
    });
    await shutdown(setup);
  });

  test("keeps flag and environment precedence", async () => {
    writeConfig({
      frecencyDbPath: "/config/frecency",
      historyDbPath: "/config/history",
      enableFsRootScanning: true,
      enableHomeDirScanning: false,
    });
    process.env.FFF_FRECENCY_DB = "/env/frecency";
    process.env.FFF_HISTORY_DB = "/env/history";
    process.env.FFF_ENABLE_ROOT_SCAN = "1";
    process.env.FFF_ENABLE_HOME_SCAN = "1";
    process.env.FFF_FOLLOW_SYMLINKS = "1";

    const setup = await start(undefined, {
      "fff-frecency-db": "/flag/frecency",
      "fff-enable-root-scan": false,
      "fff-follow-symlinks": false,
    });
    const toolNames = setup.pi.registerTool.mock.calls.map(
      ([tool]) => tool.name,
    );

    expect(toolNames).toEqual(["grep", "find"]);
    expect(createCalls[0]).toEqual({
      basePath: "/tmp/workspace",
      frecencyDbPath: "/flag/frecency",
      historyDbPath: "/env/history",
      aiMode: true,
      enableHomeDirScanning: true,
      enableFsRootScanning: false,
      followSymlinks: false,
    });
    await shutdown(setup);
  });

  // #627: worktree and stow layouts reach their files through symlinks, so following
  // them is the default and the environment is the way out.
  test("stops following symlinks when the environment disables them", async () => {
    process.env.FFF_FOLLOW_SYMLINKS = "0";

    const setup = await start();

    expect((createCalls[0] as { followSymlinks: boolean }).followSymlinks).toBe(
      false,
    );
    await shutdown(setup);
  });
});

function writeConfig(config: Record<string, unknown>): void {
  fs.writeFileSync(configPath, JSON.stringify(config));
}

// 固定 override 行为：grep/find 定义在扩展加载期注册，首次会话准备时去重合并进
// 激活工具列表；opt-out 目录则完全不触碰激活列表，只通知原因。
describe("pi-fff tool registration and activation", () => {
  test("registers grep/find at load time and activates on session_start", async () => {
    const setup = createPi();
    const ctx = createContext();
    fffExtension(setup.pi as any);

    // 加载期：定义已注册，尚未触碰激活列表。
    expect(setup.pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(
      ["grep", "find"],
    );
    expect(setup.pi.setActiveTools).not.toHaveBeenCalled();

    // pi 内建 grep 已处于激活态：合并必须去重并保持顺序。
    setup.pi.getActiveTools.mockReturnValue(["read", "grep"]);
    await setup.events.get("session_start")?.({ reason: "startup" }, ctx);

    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "grep",
      "find",
    ]);

    const tools = setup.pi.registerTool.mock.calls.map(([tool]) => tool);
    const grep = tools.find((tool) => tool.name === "grep");
    expect(grep).toBeDefined();
    const theme = {
      bold: (text: string) => text,
      fg: (_color: string, text: string) => text,
    };
    const call = grep!.renderCall({ pattern: "TODO", path: "." }, theme, {
      state: {},
      invalidate: mock(() => undefined),
      isError: false,
    });
    expect(call.render(80)).toEqual(["grep /TODO/ in ."]);
    expect(grep!.promptGuidelines[0].startsWith("grep:")).toBe(true);
    await shutdown(setup);
  });

  test("registers tools before an unbound SDK session's first agent turn", async () => {
    const setup = createPi();
    const ctx = createContext();
    fffExtension(setup.pi as any);

    expect(setup.pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(
      ["grep", "find"],
    );
    expect(setup.pi.setActiveTools).not.toHaveBeenCalled();

    await setup.events.get("before_agent_start")?.({}, ctx);

    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith(
      expect.arrayContaining(["grep", "find"]),
    );
    expect(createCalls).toHaveLength(0);

    // sessionPrepared 重入守卫：随后再触发一次 session_start 不得重复激活。
    await setup.events.get("session_start")?.({ reason: "startup" }, ctx);
    expect(setup.pi.setActiveTools).toHaveBeenCalledTimes(1);
    await shutdown(setup);
  });

  // SDK 直调场景只有 before_agent_start：opt-out 目录同样只通知一次原因，
  // 不激活工具、不初始化索引。
  test("opted-out cwd is notified once when only before_agent_start fires", async () => {
    process.env.FFF_ENABLE_HOME_SCAN = "0";
    const setup = createPi();
    const ctx = createContext(os.homedir());
    fffExtension(setup.pi as any);

    await setup.events.get("before_agent_start")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = ctx.ui.notify.mock.calls[0];
    expect(message).toContain("enableHomeDirScanning");
    expect(level).toBe("warning");
    // pi 无条件激活扩展工具：opt-out 时显式把 grep/find 从激活集移除。
    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith(["read"]);
    expect(createCalls).toHaveLength(0);
    await shutdown(setup);
  });

  // 激活集残留 grep/find（用户手动启用过内置工具）时，opt-out 会话中调用会命中
  // ensureFinder 的防御性 reject，携带禁用原因而非伪装成初始化失败。
  test("invoking grep in an opted-out cwd rejects with the opt-out reason", async () => {
    process.env.FFF_ENABLE_HOME_SCAN = "0";
    const setup = await start(os.homedir());
    const tools = setup.pi.registerTool.mock.calls.map(([tool]) => tool);
    const grep = tools.find((tool) => tool.name === "grep");
    expect(grep).toBeDefined();

    await expect(
      grep!.execute("call-1", { pattern: "TODO" }, abortOptions().signal),
    ).rejects.toThrow("search is disabled");

    await shutdown(setup);
  });

  // 会话替换/新会话复用同一扩展实例：session_shutdown 复位守卫后，新的
  // session_start 应重新激活 grep/find（工厂随销毁后需重建）。
  test("re-prepares after session_shutdown so a replacement session re-activates", async () => {
    const setup = createPi();
    const ctx = createContext();
    fffExtension(setup.pi as any);

    await setup.events.get("session_start")?.({ reason: "startup" }, ctx);
    expect(setup.pi.setActiveTools).toHaveBeenCalledTimes(1);

    await shutdown(setup);
    await setup.events.get("session_start")?.({ reason: "startup" }, ctx);

    expect(setup.pi.setActiveTools).toHaveBeenCalledTimes(2);
    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith([
      "read",
      "grep",
      "find",
    ]);
    await shutdown(setup);
  });
});

// Regression for #743: launching from $HOME must be visible and interruptible.
describe("pi-fff $HOME scan warning", () => {
  test("warns and pins a status when cwd is $HOME", async () => {
    const setup = await start(os.homedir());

    expect(setup.ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = setup.ctx.ui.notify.mock.calls[0];
    expect(message).toContain(os.homedir());
    expect(level).toBe("warning");
    expect(setup.ctx.ui.setStatus).toHaveBeenCalledWith(
      "fff",
      "Agent is indexing $HOME, this can lead to high CPU",
    );
    await shutdown(setup);
  });

  test("stays silent outside $HOME", async () => {
    const { ctx } = await start();

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(ctx.ui.setStatus).not.toHaveBeenCalled();
  });

  test("clears the status once the scan settles", async () => {
    const setup = await start(os.homedir());

    expect(setup.ctx.ui.setStatus).toHaveBeenLastCalledWith("fff", undefined);
    await shutdown(setup);
  });

  // waitForScan resolves on timeout, so a slow $HOME walk keeps the footer up.
  test("keeps reporting live progress while the scan is still running", async () => {
    scanProgressImpl = () => ({
      ok: true,
      value: {
        scannedFilesCount: 12345,
        isScanning: true,
        isWatcherReady: false,
        isWarmupComplete: false,
      },
    });
    const setup = await start(os.homedir());

    const lastStatus = setup.ctx.ui.setStatus.mock.calls.at(-1);
    expect(lastStatus?.[0]).toBe("fff");
    expect(lastStatus?.[1]).toContain("12345 files");

    // session_shutdown must stop the poller and clear the footer.
    await shutdown(setup);
    expect(setup.ctx.ui.setStatus).toHaveBeenLastCalledWith("fff", undefined);
  });

  // #857: opt-out 必须跳过索引初始化、不得把原生拒绝当成初始化错误。pi 会无条件
  // 激活扩展工具，opt-out 分支显式从激活集移除 grep/find（注册定义仍保留，
  // 渲染器可用）。
  test("skips the picker and stays out of the way when home scanning is off", async () => {
    process.env.FFF_ENABLE_HOME_SCAN = "0";
    const setup = await start(os.homedir());

    expect(createCalls).toHaveLength(0);
    expect(setup.ctx.ui.setStatus).not.toHaveBeenCalled();
    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith(["read"]);

    const [message, level] = setup.ctx.ui.notify.mock.calls[0];
    expect(setup.ctx.ui.notify).toHaveBeenCalledTimes(1);
    expect(level).toBe("warning");
    expect(message).not.toContain("FFF init failed");
    expect(message).toContain("enableHomeDirScanning");

    const toolNames = setup.pi.registerTool.mock.calls.map(
      ([tool]) => tool.name,
    );
    expect(toolNames).toEqual(["grep", "find"]);
    await shutdown(setup);
  });

  test("skips the picker at the filesystem root without root scanning", async () => {
    const setup = await start(path.parse(process.cwd()).root);

    expect(createCalls).toHaveLength(0);
    expect(setup.pi.setActiveTools).toHaveBeenLastCalledWith(["read"]);
    const [message, level] = setup.ctx.ui.notify.mock.calls[0];
    expect(level).toBe("warning");
    expect(message).toContain("enableFsRootScanning");
    await shutdown(setup);
  });

  test("still indexes $HOME when the opt-out is not set", async () => {
    const setup = await start(os.homedir());

    expect(createCalls).toHaveLength(1);
    expect((createCalls[0] as { basePath: string }).basePath).toBe(
      os.homedir(),
    );
    await shutdown(setup);
  });

  // #806: muting the warning must not turn the scan or the footer off.
  test("FFF_WARN_HOME_SCAN=0 mutes the warning but keeps indexing", async () => {
    process.env.FFF_WARN_HOME_SCAN = "0";
    const setup = await start(os.homedir());

    expect(setup.ctx.ui.notify).not.toHaveBeenCalled();
    expect(setup.ctx.ui.setStatus).toHaveBeenCalledWith(
      "fff",
      "Agent is indexing $HOME, this can lead to high CPU",
    );
    expect(
      (createCalls[0] as { enableHomeDirScanning: boolean })
        .enableHomeDirScanning,
    ).toBe(true);
    await shutdown(setup);
  });

  test("--fff-warn-home-scan=false mutes the warning", async () => {
    const setup = await start(os.homedir(), {
      "fff-warn-home-scan": false,
    });

    expect(setup.ctx.ui.notify).not.toHaveBeenCalled();
    await shutdown(setup);
  });

  test("warnOnHomeDirScan in the config file mutes the warning", async () => {
    writeConfig({ warnOnHomeDirScan: false });
    const setup = await start(os.homedir());

    expect(setup.ctx.ui.notify).not.toHaveBeenCalled();
    await shutdown(setup);
  });
});

describe("pi-fff autocomplete registration", () => {
  test("session_start registers a provider without replacing the editor", async () => {
    const { ctx } = await start();

    expect(ctx.ui.addAutocompleteProvider).toHaveBeenCalledTimes(1);
    expect(ctx.ui.setEditorComponent).not.toHaveBeenCalled();
    expect(createCalls).toEqual([
      {
        basePath: "/tmp/workspace",
        // Resolved defaults are host-dependent; covered by test/db-paths.test.ts.
        frecencyDbPath: expect.any(String),
        historyDbPath: expect.any(String),
        aiMode: true,
        enableHomeDirScanning: true,
        enableFsRootScanning: false,
        followSymlinks: true,
      },
    ]);
  });

  test("FFF_ENABLE_HOME_SCAN=0 disables home dir scanning", async () => {
    process.env.FFF_ENABLE_HOME_SCAN = "0";
    await start();

    const opts = createCalls[0] as { enableHomeDirScanning: boolean };
    expect(opts.enableHomeDirScanning).toBe(false);
  });

  test("session_start survives hosts without addAutocompleteProvider", async () => {
    const setup = createPi();
    const ctx = {
      cwd: "/tmp/workspace",
      ui: {
        notify: mock(() => undefined),
        setEditorComponent: mock(() => undefined),
      },
    };
    fffExtension(setup.pi as any);

    const sessionStart = setup.events.get("session_start");
    await sessionStart?.({ reason: "startup" }, ctx);

    expect(ctx.ui.notify).not.toHaveBeenCalled();
    expect(createCalls).toHaveLength(1);
  });

  test("delegates non-@ completions to the current provider", async () => {
    const { ctx } = await start();
    const factory = ctx.ui.addAutocompleteProvider.mock.calls[0][0];
    const current = currentProvider();
    const provider = factory(current);

    const result = await provider.getSuggestions(
      ["hello"],
      0,
      5,
      abortOptions(),
    );

    expect(result).toEqual({
      items: [{ value: "base", label: "base" }],
      prefix: "ba",
    });
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
    expect(finders[0].mixedSearch).not.toHaveBeenCalled();
  });

  test("returns FFF-backed @ mention suggestions", async () => {
    mixedSearchImpl = (query, options) => {
      expect(query).toBe("src");
      expect(options).toEqual({ pageSize: 20 });
      return {
        ok: true,
        value: {
          items: [
            {
              type: "file",
              item: {
                relativePath: "src/index.ts",
                fileName: "index.ts",
                size: 1,
                modified: 1,
                accessFrecencyScore: 0,
                modificationFrecencyScore: 0,
                totalFrecencyScore: 0,
                gitStatus: "clean",
              },
            },
            {
              type: "directory",
              item: {
                relativePath: "src/components/",
                dirName: "components/",
                maxAccessFrecency: 0,
              },
            },
          ],
          scores: [],
          totalMatched: 2,
          totalFiles: 1,
          totalDirs: 1,
        },
      };
    };

    const { ctx } = await start();
    const factory = ctx.ui.addAutocompleteProvider.mock.calls[0][0];
    const current = currentProvider();
    const provider = factory(current);

    const result = await provider.getSuggestions(
      ["open @src"],
      0,
      9,
      abortOptions(),
    );

    expect(result).toEqual({
      prefix: "@src",
      items: [
        {
          value: "@src/index.ts",
          label: "index.ts",
          description: "src/index.ts",
        },
        {
          value: "@src/components/",
          label: "components/",
          description: "src/components/",
        },
      ],
    });
    expect(current.getSuggestions).not.toHaveBeenCalled();

    // FFF 提供的建议被选中时，走 FFF 自己的 applyCompletion（而非委托原生）。
    const applied = provider.applyCompletion(
      ["open @src"],
      0,
      9,
      { value: "@src/index.ts", label: "index.ts" },
      "@src",
    );
    expect(applied).toEqual({
      lines: ["open @src/index.ts"],
      cursorLine: 0,
      cursorCol: 18,
    });
    expect(current.applyCompletion).not.toHaveBeenCalled();
  });

  test("delegates when FFF lookup fails", async () => {
    mixedSearchImpl = () => {
      throw new Error("native lookup failed");
    };

    const { ctx } = await start();
    const factory = ctx.ui.addAutocompleteProvider.mock.calls[0][0];
    const current = currentProvider();
    const provider = factory(current);

    const result = await provider.getSuggestions(
      ["@src"],
      0,
      4,
      abortOptions(),
    );

    expect(result).toEqual({
      items: [{ value: "base", label: "base" }],
      prefix: "ba",
    });
    expect(current.getSuggestions).toHaveBeenCalledTimes(1);
  });

  test("completion application and file-completion trigger delegate to current provider", async () => {
    const { ctx } = await start();
    const factory = ctx.ui.addAutocompleteProvider.mock.calls[0][0];
    const current = currentProvider();
    const provider = factory(current);

    const applied = provider.applyCompletion(
      ["@src"],
      0,
      4,
      { value: "@src/index.ts", label: "index.ts" },
      "@src",
    );
    const shouldTrigger = provider.shouldTriggerFileCompletion(["@src"], 0, 4);

    expect(applied).toEqual({
      lines: ["applied"],
      cursorLine: 0,
      cursorCol: 7,
    });
    expect(shouldTrigger).toBe(false);
    expect(current.applyCompletion).toHaveBeenCalledTimes(1);
    expect(current.shouldTriggerFileCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("compact tool rendering", () => {
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };

  function toolByName(
    setup: { pi: { registerTool: ReturnType<typeof mock> } },
    name: string,
  ) {
    const tool = setup.pi.registerTool.mock.calls
      .map(([tool]) => tool)
      .find((tool) => tool.name === name);
    expect(tool).toBeDefined();
    return tool;
  }

  test("grep renders collapsed by default and full when pi reports expanded", async () => {
    const setup = await start();
    const tool = toolByName(setup, "grep");
    const context = {
      state: {},
      invalidate: mock(() => undefined),
      isError: false,
    };

    const call = tool.renderCall(
      { pattern: "TODO", path: ".", limit: 3, context: 2 },
      theme,
      context,
    );
    expect(call.render(80)).toEqual(["grep /TODO/ in . (limit 3, context 2)"]);

    const defaultCall = tool.renderCall(
      { pattern: "TODO", path: "." },
      theme,
      context,
    );
    expect(defaultCall.render(80)).toEqual(["grep /TODO/ in ."]);

    const content = [{ type: "text", text: "first\nsecond\nthird" }];
    const collapsed = tool.renderResult(
      { content },
      { expanded: false },
      theme,
      context,
    );
    expect(collapsed.render(80)).toEqual(["first ... (2 more lines)"]);

    const expanded = tool.renderResult(
      { content },
      { expanded: true },
      theme,
      context,
    );
    expect(expanded.text).toBe("first\nsecond\nthird");
  });

  test("find result follows the expanded option", async () => {
    const setup = await start();
    const tool = toolByName(setup, "find");
    const context = {
      state: {},
      invalidate: mock(() => undefined),
      isError: false,
    };

    const call = tool.renderCall(
      { pattern: "index", path: "src" },
      theme,
      context,
    );
    expect(call.render(80)).toEqual(["find index in src"]);

    const content = [{ type: "text", text: "src/index.ts\nsrc/main.ts" }];
    const collapsed = tool.renderResult(
      { content },
      { expanded: false },
      theme,
      context,
    );
    expect(collapsed.render(80)).toEqual(["src/index.ts ... (1 more lines)"]);

    const expanded = tool.renderResult(
      { content },
      { expanded: true },
      theme,
      context,
    );
    expect(expanded.text).toBe("src/index.ts\nsrc/main.ts");
  });
});

describe("grep per-file cap (#825)", () => {
  function grepTool(setup: { pi: { registerTool: ReturnType<typeof mock> } }) {
    const tool = setup.pi.registerTool.mock.calls
      .map(([t]) => t)
      .find((t) => t.name === "grep");
    expect(tool).toBeDefined();
    return tool;
  }

  // Grep cursors advance by file offset, so maxMatchesPerFile must NOT be clamped
  // to pageSize — otherwise same-file overflow is unreachable on later pages.
  test("passes a per-file cap decoupled from pageSize", async () => {
    let captured: any;
    grepImpl = (_query, options) => {
      captured = options;
      return {
        ok: true,
        value: {
          items: [],
          totalMatched: 0,
          totalFiles: 0,
          totalFilesSearched: 0,
          filteredFileCount: 0,
          nextCursor: null,
        },
      };
    };

    const setup = await start();
    const tool = grepTool(setup);
    await tool.execute(
      "call-1",
      { pattern: "TODO", limit: 20 },
      abortOptions().signal,
    );

    expect(captured).toBeDefined();
    expect(captured.pageSize).toBe(20);
    expect(captured.maxMatchesPerFile).toBe(200);
    expect(captured.maxMatchesPerFile).toBeGreaterThan(captured.pageSize);
  });
});

function toolWithName(
  setup: { pi: { registerTool: ReturnType<typeof mock> } },
  name: string,
) {
  const tool = setup.pi.registerTool.mock.calls
    .map(([t]) => t)
    .find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool;
}

describe("grep/find edge branches", () => {
  // grep：regex 回退与 next-cursor 通知分支
  test("grep surfaces regex fallback and next-cursor notices", async () => {
    grepImpl = () => ({
      ok: true,
      value: {
        items: [
          {
            relativePath: "src/a.ts",
            lineNumber: 1,
            col: 1,
            lineContent: "hello",
            contextBefore: [],
            contextAfter: [],
          },
        ],
        totalMatched: 3,
        totalFiles: 1,
        totalFilesSearched: 1,
        filteredFileCount: 0,
        nextCursor: { fileOffset: 1 },
        regexFallbackError: "bad pattern",
      },
    });

    const setup = await start();
    const tool = toolWithName(setup, "grep");
    const result = await tool.execute(
      "call-1",
      { pattern: "TODO" },
      abortOptions().signal,
    );

    expect(result.content[0].text).toContain("Invalid regex: bad pattern");
    expect(result.content[0].text).toContain('Continue with cursor="fff_c');
    await shutdown(setup);
  });

  // grep：绝对路径约束路由到辅助索引
  test("grep routes absolute path constraints to an auxiliary finder", async () => {
    const setup = await start();
    const tool = toolWithName(setup, "grep");
    await tool.execute(
      "call-1",
      { pattern: "x", path: "/tmp/fff-aux-grep" },
      abortOptions().signal,
    );

    expect(createCalls).toHaveLength(2);
    await shutdown(setup);
  });

  // find：满页高分时给出剩余量与分页游标
  function fullPageFiles() {
    return Array.from({ length: 30 }, (_, i) => ({
      relativePath: `src/f${i}.ts`,
      size: 1,
      modified: 1,
      accessFrecencyScore: 0,
      modificationFrecencyScore: 0,
      totalFrecencyScore: 100,
      gitStatus: "clean",
    }));
  }

  test("find reports remaining matches and stores a cursor", async () => {
    fileSearchImpl = () => {
      const items = fullPageFiles();
      return {
        ok: true,
        value: {
          items,
          scores: items.map(() => ({ total: 100 })),
          totalMatched: 50,
          totalFiles: 1,
        },
      };
    };

    const setup = await start();
    const tool = toolWithName(setup, "find");
    const result = await tool.execute(
      "call-1",
      { pattern: "config", limit: 30 },
      abortOptions().signal,
    );

    expect(result.content[0].text).toContain("20 more matches available");
    expect(result.content[0].text).toContain('cursor="');
    await shutdown(setup);
  });

  // find：用游标续页走 resumed 路径
  test("find resumes pagination via a stored cursor", async () => {
    let captured: unknown;
    fileSearchImpl = (_query, options) => {
      captured = options;
      const items = fullPageFiles();
      return {
        ok: true,
        value: {
          items,
          scores: items.map(() => ({ total: 100 })),
          totalMatched: 50,
          totalFiles: 1,
        },
      };
    };

    const setup = await start();
    const tool = toolWithName(setup, "find");
    const first = await tool.execute(
      "call-1",
      { pattern: "config" },
      abortOptions().signal,
    );
    const cursorId = first.content[0].text.match(/cursor="(\d+)"/)?.[1];
    expect(cursorId).toBeDefined();
    await tool.execute(
      "call-2",
      { pattern: "config", cursor: cursorId! },
      abortOptions().signal,
    );

    expect(captured).toEqual({ pageIndex: 1, pageSize: 30 });
    await shutdown(setup);
  });

  // find：弱匹配结果被采样并给出 capped 通知
  test("find caps weak fuzzy noise with a notice", async () => {
    fileSearchImpl = () => {
      const items = Array.from({ length: 3 }, (_, i) => ({
        relativePath: `src/f${i}.ts`,
        size: 1,
        modified: 1,
        accessFrecencyScore: 0,
        modificationFrecencyScore: 0,
        totalFrecencyScore: 1,
        gitStatus: "clean",
      }));
      return {
        ok: true,
        value: {
          items,
          scores: items.map(() => ({ total: 1 })),
          totalMatched: 42,
          totalFiles: 1,
        },
      };
    };

    const setup = await start();
    const tool = toolWithName(setup, "find");
    const result = await tool.execute(
      "call-1",
      { pattern: "x" },
      abortOptions().signal,
    );

    expect(result.content[0].text).toContain("weak scattered fuzzy");
    expect(result.content[0].text).toContain("capped at 3/42");
    await shutdown(setup);
  });

  // find：绝对路径首查建 aux 索引，游标续页走 auxRoot 精确复用
  test("find resumes on the exact auxiliary root via cursor", async () => {
    fileSearchImpl = () => {
      const items = fullPageFiles();
      return {
        ok: true,
        value: {
          items,
          scores: items.map(() => ({ total: 100 })),
          totalMatched: 50,
          totalFiles: 1,
        },
      };
    };

    const setup = await start();
    const tool = toolWithName(setup, "find");
    const first = await tool.execute(
      "call-1",
      { pattern: "config", path: "/tmp/fff-aux-root" },
      abortOptions().signal,
    );
    expect(createCalls).toHaveLength(2);

    // 游标携带 auxRoot：续页精确复用已有 aux picker，不再新建。
    const cursorId = first.content[0].text.match(/cursor="(\d+)"/)?.[1];
    expect(cursorId).toBeDefined();
    await tool.execute(
      "call-2",
      { pattern: "config", cursor: cursorId! },
      abortOptions().signal,
    );
    expect(createCalls).toHaveLength(2);
    await shutdown(setup);
  });
});

describe("init failure and fuzzy fallback paths", () => {
  // 覆盖 reportInitFailure（session_start 的 catch 路径）
  test("session_start reports native init failures", async () => {
    finderModule.FileFinder.create.mockImplementation(() => ({
      ok: false,
      error: "boom",
    }));

    const setup = createPi();
    const ctx = createContext();
    fffExtension(setup.pi as any);

    await setup.events.get("session_start")?.({ reason: "startup" }, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = ctx.ui.notify.mock.calls[0];
    expect(message).toContain("FFF init failed");
    expect(message).toContain("boom");
    expect(level).toBe("error");
    await shutdown(setup);
  });

  // 覆盖 before_agent_start 的 catch 路径：prepareSession 内唯一可失败点是
  // resolveStartupConfig 读 flag，注入 getFlag 抛错以触达防御分支。
  test("before_agent_start reports config resolution failures", async () => {
    const setup = createPi();
    const ctx = createContext();
    setup.pi.getFlag.mockImplementation(() => {
      throw new Error("flag boom");
    });
    fffExtension(setup.pi as any);

    await setup.events.get("before_agent_start")?.({}, ctx);

    expect(ctx.ui.notify).toHaveBeenCalledTimes(1);
    const [message, level] = ctx.ui.notify.mock.calls[0];
    expect(message).toContain("FFF init failed");
    expect(message).toContain("flag boom");
    expect(level).toBe("error");
    await shutdown(setup);
  });

  // cover fuzzy fallback hit: zero plain hits retry as fuzzy
  test("grep falls back to fuzzy when a plain search misses", async () => {
    let calls = 0;
    grepImpl = (_query, options) => {
      calls++;
      if (calls === 1)
        return {
          ok: true,
          value: {
            items: [],
            totalMatched: 0,
            totalFiles: 0,
            totalFilesSearched: 0,
            filteredFileCount: 0,
            nextCursor: null,
          },
        };
      // fuzzy 二次调用命中
      return {
        ok: true,
        value: {
          items: [
            {
              relativePath: "src/b.ts",
              lineNumber: 2,
              col: 1,
              lineContent: "HelloConfig",
              contextBefore: [],
              contextAfter: [],
            },
          ],
          totalMatched: 1,
          totalFiles: 1,
          totalFilesSearched: 1,
          filteredFileCount: 0,
          nextCursor: null,
        },
      };
    };

    const setup = await start();
    const tool = toolWithName(setup, "grep");
    const result = await tool.execute(
      "call-1",
      { pattern: "TODO" },
      abortOptions().signal,
    );

    expect(result.content[0].text).toContain(
      "0 exact matches. Maybe you meant this?",
    );
    expect(calls).toBe(2);
    await shutdown(setup);
  });
});
