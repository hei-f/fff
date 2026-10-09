/**
 * `bun build --compile` 打包静态可见 import；此处经 type:"file" import 包内 bin/<platform>/ 使原生库内嵌
 * （编译产物内 $bunfs、bun run 下真实磁盘路径；Linux libc 经 FFF_LIBC define 注入，默认 glibc）
 */
export declare const embeddedLibPath: string | null;
//# sourceMappingURL=embedded.d.ts.map