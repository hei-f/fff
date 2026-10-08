/**
 * fff-node 原生库解析工具（vendor 副本）
 *
 * 解析来源（按优先级）：
 * 1. 包内 bin/<platform>/ 内嵌原生库（自包含产物，无 registry 依赖）
 * 2. 平台专用 npm 包（如 @ff-labs/fff-bin-darwin-arm64）——上游回退
 * 3. 本地开发产物（target/release 或 target/debug）——dev/standalone 回退
 */
/**
 * 检查本地任意已知位置是否存在原生库
 */
export declare function binaryExists(): boolean;
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
export declare function findBinary(): string | null;
//# sourceMappingURL=binary.d.ts.map