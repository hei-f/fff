import { describe, expect, test } from "bun:test";
import {
  buildQuery,
  excludeSegmentProbePattern,
  normalizePathConstraint,
} from "../src/query";

const cwd = "/tmp/workspace";

describe("path constraint normalization", () => {
  test("converts absolute in-workspace paths to repo-relative constraints", () => {
    expect(normalizePathConstraint("/tmp/workspace/.agents/**", cwd)).toBe(".agents/");
    expect(normalizePathConstraint("/tmp/workspace/.agents/plans/**", cwd)).toBe(
      ".agents/plans/",
    );
  });

  test("rejects absolute paths outside the workspace", () => {
    expect(() => normalizePathConstraint("/tmp/other/.agents/**", cwd)).toThrow(
      "Path constraint must be relative to the workspace",
    );
  });

  test("collapses only simple trailing recursive directory globs", () => {
    expect(normalizePathConstraint(".agents/**", cwd)).toBe(".agents/");
    expect(normalizePathConstraint("src/**/*", cwd)).toBe("src/");
    expect(normalizePathConstraint("src/**/*.ts", cwd)).toBe("src/**/*.ts");
    expect(normalizePathConstraint("{src,lib}/**", cwd)).toBe("{src,lib}/**");
  });

  test("builds find queries with normalized include and exclude constraints", () => {
    expect(
      buildQuery("/tmp/workspace/.agents/**", "*", "/tmp/workspace/test/**", cwd),
    ).toBe(".agents/ !test/ *");
  });

  test("treats path='.' as workspace root (no constraint)", () => {
    expect(normalizePathConstraint(".", cwd)).toBeNull();
    expect(normalizePathConstraint("./", cwd)).toBeNull();
    expect(buildQuery(".", "needle", undefined, cwd)).toBe("needle");
  });

  test("treats absolute workspace root as no constraint", () => {
    expect(normalizePathConstraint(cwd, cwd)).toBeNull();
    expect(buildQuery(cwd, "needle", undefined, cwd)).toBe("needle");
  });

  test("bare directory path without trailing slash becomes PathSegment", () => {
    expect(normalizePathConstraint("app", cwd)).toBe("app/");
    expect(normalizePathConstraint("src/nested", cwd)).toBe("src/nested/");
    expect(buildQuery("app", "needle", undefined, cwd)).toBe("app/ needle");
  });

  test("converts absolute in-workspace file path to repo-relative", () => {
    expect(normalizePathConstraint("/tmp/workspace/src/main.rs", cwd)).toBe(
      "src/main.rs",
    );
    expect(buildQuery("/tmp/workspace/src/main.rs", "needle", undefined, cwd)).toBe(
      "src/main.rs needle",
    );
  });

  test("converts absolute in-workspace directory (without trailing slash) to repo-relative", () => {
    expect(normalizePathConstraint("/tmp/workspace/src", cwd)).toBe("src/");
    expect(buildQuery("/tmp/workspace/src", "needle", undefined, cwd)).toBe(
      "src/ needle",
    );
  });

  test("converts absolute in-workspace glob path to repo-relative glob", () => {
    expect(normalizePathConstraint("/tmp/workspace/src/**/*.ts", cwd)).toBe(
      "src/**/*.ts",
    );
  });

  test("bare recursive globs constrain nothing", () => {
    expect(normalizePathConstraint("**", cwd)).toBeNull();
    expect(normalizePathConstraint("**/", cwd)).toBeNull();
    expect(normalizePathConstraint("**/*", cwd)).toBeNull();
    expect(normalizePathConstraint("./**", cwd)).toBeNull();
    expect(buildQuery("**", "needle", undefined, cwd)).toBe("needle");
  });
});

// 精确目录探测 pattern 构造：必须保留 **/.../** 外壳，否则裸段会退化为模糊搜索；
// 空段、绝对路径段与家目录段无法判定，返回 null 由调用方跳过探测。
describe("exclude segment probe pattern", () => {
  test("frames a plain directory segment with recursive globs", () => {
    expect(excludeSegmentProbePattern("tests/")).toBe("**/tests/**");
  });

  test("keeps multi-level directory segments intact", () => {
    expect(excludeSegmentProbePattern("crates/fff-core/srcs/")).toBe(
      "**/crates/fff-core/srcs/**",
    );
  });

  test("strips every trailing slash before framing", () => {
    expect(excludeSegmentProbePattern("test////")).toBe("**/test/**");
  });

  test("returns null for empty segments", () => {
    expect(excludeSegmentProbePattern("")).toBeNull();
    expect(excludeSegmentProbePattern("/")).toBeNull();
  });

  test("returns null for absolute path segments", () => {
    expect(excludeSegmentProbePattern("/abs/x/")).toBeNull();
  });

  test("returns null for home-directory segments", () => {
    expect(excludeSegmentProbePattern("~/foo/")).toBeNull();
  });

  test("escapes glob metacharacters inside the segment", () => {
    expect(excludeSegmentProbePattern("a[?*{b/")).toBe("**/a[[][?][*][{]b/**");
  });
});
