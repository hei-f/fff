import path from "node:path";

// glob 通配符检测，与 parser has_wildcards 同字符集（glob_detect.rs:16-18）
export const GLOB_WILDCARDS_RE = /[*?[{]/;

export function normalizePathConstraint(
  pathConstraint: string,
  cwd = process.cwd(),
): string | null {
  let trimmed = pathConstraint.trim();
  if (!trimmed) return trimmed;

  if (path.isAbsolute(trimmed)) {
    const relative = path.relative(cwd, trimmed).replaceAll(path.sep, "/");
    if (relative === "") return null;
    if (
      relative.startsWith("../") ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `Path constraint must be relative to the workspace: ${pathConstraint}`,
      );
    }
    trimmed = relative;
  }

  if (trimmed === "." || trimmed === "./") return null;
  // Strip a leading `./` so `./**/*.rs` and `**/*.rs` behave identically.
  if (trimmed.startsWith("./")) trimmed = trimmed.slice(2);

  // wif we left with the ** it means anything so treat it as a cwd path
  if (trimmed === "**" || trimmed === "**/" || trimmed === "**/*") return null;

  // FFF's glob matcher can treat a hidden directory root glob such as
  // `.agents/**` as empty, while the tool contract says this means "inside
  // this directory". Collapse simple trailing recursive directory globs to the
  // directory-prefix constraint understood by the parser. Keep real file globs
  // such as `src/**/*.ts` unchanged.
  const recursiveDir = trimmed.match(/^(.*)\/\*\*(?:\/\*)?$/);
  if (recursiveDir) {
    const dir = recursiveDir[1];
    if (dir && !GLOB_WILDCARDS_RE.test(dir)) return `${dir}/`;
  }

  // Already signals path-constraint syntax to the parser.
  if (trimmed.startsWith("/") || trimmed.endsWith("/")) return trimmed;
  // Globs (`*.ts`, `src/**/*.cc`, `{src,lib}`) are handled by the parser.
  if (GLOB_WILDCARDS_RE.test(trimmed)) return trimmed;
  // Filename with extension (`main.rs`, `config.json`) → FilePath constraint.
  const lastSegment = trimmed.split("/").pop() ?? "";
  if (/\.[a-zA-Z][a-zA-Z0-9]{0,9}$/.test(lastSegment)) return trimmed;
  // Bare directory prefix → append `/` so the parser sees a PathSegment.
  return `${trimmed}/`;
}

// Exclusions are emitted as `!<constraint>` tokens, which the Rust parser
// understands (crates/fff-query-parser/src/parser.rs). We normalize each one
// the same way as the include path so bare dirs become PathSegment excludes.
// Tolerate callers passing already-negated forms like `!src/` by stripping
// the leading `!` before normalizing so we never double-negate (`!!src/`).
export function normalizeExcludes(
  exclude: string | string[] | undefined,
  cwd = process.cwd(),
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const out: string[] = [];
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (normalized) out.push(`!${normalized}`);
    }
  }
  return out;
}

// 段型排除列表：归一化为目录前缀（以 / 结尾）的项，保留尾部 /，仅用于排除项
// 存在性探测；过滤退化段（归一化为 / 或空的项，parser 对单独 / 不产生约束）。
export function normalizedExcludeSegments(
  exclude: string | string[] | undefined,
  cwd = process.cwd(),
): string[] {
  if (!exclude) return [];
  const list = Array.isArray(exclude) ? exclude : [exclude];
  const segments = new Set<string>();
  for (const raw of list) {
    const parts = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of parts) {
      const stripped = p.startsWith("!") ? p.slice(1) : p;
      const normalized = normalizePathConstraint(stripped, cwd);
      if (!normalized || normalized === "/") continue;
      if (normalized.endsWith("/")) segments.add(normalized);
    }
  }
  return [...segments];
}

// 把目录型 exclude 段转为精确目录探测 pattern；空段、绝对路径段（/ 开头）与家目录段
// （~ 开头）无法判定返回 null；必须保留 `**/.../**` 外壳，裸段会退化为模糊搜索。
export function excludeSegmentProbePattern(segment: string): string | null {
  const trimmed = segment.replace(/\/+$/, "");
  if (trimmed === "") return null;
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) return null;
  // glob 元字符转义表，字符集与 GLOB_WILDCARDS_RE（* ? [ {）保持一致。
  const globEscapes: Record<string, string> = {
    "*": "[*]",
    "?": "[?]",
    "[": "[[]",
    "{": "[{]",
  };
  let escaped = "";
  for (const char of trimmed) {
    escaped += globEscapes[char] ?? char;
  }
  return `**/${escaped}/**`;
}

export function buildQuery(
  path: string | undefined,
  pattern: string,
  exclude?: string | string[],
  cwd = process.cwd(),
): string {
  const parts: string[] = [];
  if (path) {
    const pathConstraint = normalizePathConstraint(path, cwd);
    if (pathConstraint) parts.push(pathConstraint);
  }
  parts.push(...normalizeExcludes(exclude, cwd));
  parts.push(pattern);
  return parts.join(" ");
}
