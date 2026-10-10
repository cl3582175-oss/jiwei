import { readdirSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * 每次运行前清理上一轮测试留下的临时知识库（`jiwei-*`，由各夹具 mkdtemp 创建）。
 * 真实验收会生成 GB 级的归档与快照，不清理会在几十轮后占满磁盘（v0.6.6 审查时实际占用约 130 GB）。
 * 只删除超过 10 分钟的目录，避免误删另一个同时进行的测试。
 */
export default function cleanTemp(): void {
  const root = tmpdir(), cutoff = Date.now() - 10 * 60_000
  for (const name of readdirSync(root)) {
    if (!name.startsWith('jiwei-')) continue
    const path = join(root, name)
    try {
      if (statSync(path).mtimeMs < cutoff) rmSync(path, { recursive: true, force: true })
    } catch {
      /* 正被占用或已删除 */
    }
  }
}
