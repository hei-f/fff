/**
 * 解析来源（按优先级）：1. 包内 bin/<platform>/（自包含）2. @ff-labs 平台包（回退）3. 本地产物（dev）
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getLibFilename, getNpmPackageName } from "./platform.js";

/**
 * vendor 内平台子目录名复用 @ff-labs/fff-bin-* 命名中的平台段（如 darwin-arm64）
 */
const NPM_PACKAGE_PREFIX = "@ff-labs/fff-bin-";

/**
 * 获取当前文件所在目录
 */
function getCurrentDir(): string {
  // CJS 构建中 import.meta.url 在打包时被内联，__dirname 才是真实目录
  if (typeof __dirname !== "undefined") return __dirname;

  const url = import.meta.url;

  if (url.startsWith("file://")) {
    return dirname(fileURLToPath(url));
  }
  return dirname(url);
}

/**
 * 获取包根目录
 */
function getPackageDir(): string {
  const currentDir = getCurrentDir();
  // dev 时在 src/，dist 时在 dist/，向上查找 package.json 确定真实根目录
  let dir = currentDir;
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "package.json"))) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
        if (pkg.name === "@ff-labs/fff-node") {
          return dir;
        }
      } catch {
        // 非本包 package.json，继续向上
      }
    }
    dir = dirname(dir);
  }
  // 兜底：假设在 src/ 下一层
  return dirname(currentDir);
}

/**
 * 检查本地任意已知位置是否存在原生库
 */
export function binaryExists(): boolean {
  return findBinary() !== null;
}

/**
 * 从包内 bin/<platform>/ 解析 vendor 内嵌的原生库。
 *
 * 无 @ff-labs/fff-bin-* registry 包即可加载；解析失败时由上游 npm 包
 * 与本地产物回退
 */
function resolveFromVendorDir(): string | null {
  try {
    // 平台子目录名取 npm 包名中的平台段（如 fff-bin-darwin-arm64 → darwin-arm64）
    const platformDir = getNpmPackageName().replace(NPM_PACKAGE_PREFIX, "");
    const binPath = join(getPackageDir(), "bin", platformDir, getLibFilename());
    return existsSync(binPath) ? binPath : null;
  } catch {
    // 平台不受支持时跳过 vendor 解析，交由上游回退处理
    return null;
  }
}

/**
 * 从平台专用 npm 包解析原生库（上游回退路径）。
 *
 * 安装 @ff-labs/fff-node 时 npm 会自动安装匹配的 optionalDependency
 * （如 @ff-labs/fff-bin-darwin-arm64），通过解析该包 package.json 定位原生库
 */
function resolveFromNpmPackage(): string | null {
  const packageName = getNpmPackageName();

  try {
    // 用 createRequire 解析平台包的根目录
    const require = createRequire(join(getPackageDir(), "package.json"));
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageDir = dirname(packageJsonPath);
    const binaryPath = join(packageDir, getLibFilename());

    if (existsSync(binaryPath)) {
      return binaryPath;
    }
  } catch {
    // 包未安装属预期情形（不支持平台或未装 optional 依赖）
  }

  return null;
}

/**
 * 获取本地开发产物路径（本地开发用）
 */
function getDevBinaryPath(): string | null {
  const packageDir = getPackageDir();
  const workspaceRoot = join(packageDir, "..", "..");

  const possiblePaths = [
    join(workspaceRoot, "target", "release", getLibFilename()),
    join(workspaceRoot, "target", "debug", getLibFilename()),
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function isDevWorkspace(): boolean {
  const packageDir = getPackageDir();
  const workspaceRoot = join(packageDir, "..", "..");
  return existsSync(join(workspaceRoot, "Cargo.toml"));
}

/**
 * 查找原生库。
 *
 * 解析顺序：
 * - 开发工作区：本地 bin/ 优先，再本地产物，最后 npm 包
 * - 生产环境（vendor dist 随包分发）：包内 bin/<platform>/ 优先，
 *   再 npm 包，最后本地产物
 *
 * @returns 库的绝对路径，未找到返回 null
 */
export function findBinary(): string | null {
  if (isDevWorkspace()) {
    // 1. 本地 bin/ 目录（由 `make prepare-node` 填充）
    const binPath = join(getPackageDir(), "bin", getLibFilename());
    if (existsSync(binPath)) return binPath;

    // 2. 本地开发产物（target/release 或 target/debug）
    const devPath = getDevBinaryPath();
    if (devPath) return devPath;

    // 3. 回退到 npm 包
    const npmPath = resolveFromNpmPackage();
    if (npmPath) return npmPath;

    return null;
  }

  // 生产环境：vendor 内嵌库优先，其次 npm 包
  const vendorPath = resolveFromVendorDir();
  if (vendorPath) return vendorPath;

  const npmPath = resolveFromNpmPackage();
  if (npmPath) return npmPath;

  // 回退：本地开发产物（如用户自行源码构建）
  return getDevBinaryPath();
}
