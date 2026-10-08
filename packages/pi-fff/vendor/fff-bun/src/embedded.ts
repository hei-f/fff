/**
 * 独立可执行文件中内嵌原生库的工具（vendor 副本）
 *
 * `bun build --compile` 只会打包静态可分析 import 引用的文件；运行时解析
 * （./download.ts）对打包器不可见，因此这里再通过 `type: "file"` import
 * 引用包内 bin/<platform>/ 的原生库，让 Bun 将其内嵌进编译产物
 * （编译产物内返回 $bunfs 路径，`bun run` 下返回真实磁盘路径）。
 *
 * Linux 的 libc 无法在构建期检测，通过 FFF_LIBC 构建常量注入
 * （`bun build --define FFF_LIBC='"musl"'`），默认 glibc；macOS/Windows 无需 define。
 */

async function importFile(promise: Promise<{ default: string }>): Promise<string | null> {
  try {
    return (await promise).default;
  } catch {
    return null;
  }
}

async function resolveEmbeddedLibPath(): Promise<string | null> {
  if (process.platform === "darwin") {
    return importFile(
      import(`../bin/darwin-${process.arch}/libfff_c.dylib`, {
        with: { type: "file" },
      }),
    );
  }

  if (process.platform === "win32") {
    return importFile(
      import(`../bin/win32-${process.arch}/fff_c.dll`, {
        with: { type: "file" },
      }),
    );
  }

  if (process.platform === "linux") {
    return importFile(
      import(
        `../bin/linux-${process.arch}-${typeof FFF_LIBC === "string" ? FFF_LIBC : "gnu"}/libfff_c.so`,
        { with: { type: "file" } }
      ),
    );
  }

  return null;
}

// 模块初始化时解析一次，保证 loadLibrary() 保持同步
export const embeddedLibPath: string | null = await resolveEmbeddedLibPath();
