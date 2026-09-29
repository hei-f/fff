import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { loadFirst, sdkCandidates } from "../src/sdk";

describe("sdkCandidates", () => {
  test("defaults to bun candidates under a Bun runtime", () => {
    expect(sdkCandidates()).toEqual(["@ff-labs/fff-bun", "@ff-labs/fff-node"]);
  });
});

describe("literal SDK imports", () => {
  test("both SDK specifiers appear as literal dynamic imports for static graph scans", () => {
    const source = readFileSync(new URL("../src/sdk.ts", import.meta.url), "utf8");
    expect(source).toContain('import("@ff-labs/fff-bun")');
    expect(source).toContain('import("@ff-labs/fff-node")');
  });
});

describe("loadFirst", () => {
  test("prefers the first candidate when both load", async () => {
    const loaders = {
      a: () => Promise.resolve({ FileFinder: { create: () => "a" } }),
      b: () => Promise.resolve({ FileFinder: { create: () => "b" } }),
    };
    // loadFirst 的返回类型固定为 FileFinderStatic（create 需 InitOptions），
    // 此处的 mock 用无参 create 验证「返回第一个候选」行为，断言收窄类型。
    const mod = (await loadFirst(["a", "b"], loaders)) as unknown as {
      FileFinder: { create: () => string };
    };
    expect(mod.FileFinder.create()).toBe("a");
  });

  test("falls back to the second candidate when the first import fails", async () => {
    const loaders = {
      a: () => Promise.reject(new Error("cannot find a")),
      b: () => Promise.resolve({ FileFinder: { create: () => "b" } }),
    };
    const mod = (await loadFirst(["a", "b"], loaders)) as unknown as {
      FileFinder: { create: () => string };
    };
    expect(mod.FileFinder.create()).toBe("b");
  });

  test("throws the last error when every candidate fails", async () => {
    const loaders = {
      a: () => Promise.reject(new Error("first failure")),
      b: () => Promise.reject(new Error("second failure")),
    };
    await expect(loadFirst(["a", "b"], loaders)).rejects.toThrow("second failure");
  });
});
