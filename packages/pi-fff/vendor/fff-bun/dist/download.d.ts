/**
 * 解析来源（按优先级）：1. 包内 bin/<platform>/（自包含）2. @ff-labs 平台包（回退）3. 本地产物（dev）
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
//# sourceMappingURL=download.d.ts.map