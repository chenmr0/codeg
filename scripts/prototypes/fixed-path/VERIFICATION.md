# WAL 结构性实验验证入口

本分支为独立 WAL 协调原型；先读 `WAL-COORDINATION.md` 和 `WAL-TEST-MAPPING.md`。只有协调状态库使用 WAL，三个租约库仍为 DELETE。生产入口与迁移均未接入。

当前完整 runner 包含 162 项（保留旧 128 项目标并按新机制适配，新增确定性 fence、活动路径、WAL 恢复/维护及兼容拒绝验证）。运行：

```sh
npm ci
npm run build
STRICT_SYMLINK_TESTS=1 node scripts/prototypes/fixed-path/run-source.mjs
node scripts/prototypes/fixed-path/repeat-contention.mjs
```

Windows 使用 PowerShell 设置 `$env:STRICT_SYMLINK_TESTS='1'`，其余命令相同。必须实际创建文件与目录符号链接；不接受权限跳过替代通过。

`run-gates.mjs` 是前一版本的 DELETE 协调器 A/B 研究入口，不是本次 WAL 路线的性能对照。本次读请求统一走 lease-first + fresh WAL snapshot，默认调用 `run-source.mjs` 并保持相同五进程负载、固定三轮与 1 秒验收预算。

此前 Windows 失败与有界分析保留在 `WINDOWS-BLOCKER.md` / `CI-REPAIR.md`，不能用新的 Linux 结果改写历史。完整 Windows、真实大仓与生产入口验收前，不默认启用、不生成正式包。所有原型仍未被生产 `src` 引用。
