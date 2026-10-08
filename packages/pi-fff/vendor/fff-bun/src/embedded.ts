/**
 * `bun build --compile` 打包静态可见 import；此处经 type:"file" import 包内 bin/<platform>/ 使原生库内嵌
 * （编译产物内 $bunfs、bun run 下真实磁盘路径；Linux libc 经 FFF_LIBC define 注入，默认 glibc）
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
