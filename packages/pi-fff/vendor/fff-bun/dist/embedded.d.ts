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
export declare const embeddedLibPath: string | null;
//# sourceMappingURL=embedded.d.ts.map