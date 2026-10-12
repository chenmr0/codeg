# 匿名 sync 累计诊断

运行 `codegraph sync --diagnostics-summary`，无需 `-v`。完成后只复制以 `[sync-summary]` 开头的 8 行。`--quiet` 可组合使用。终端摘要默认不开启，不增加这些终端输出；默认本地日志见下节。SDK 可传 `sync({ diagnosticsSummary: lines => ... })`；回调异常不会改变 sync 结果。

摘要只含固定字段、数字和状态枚举，不含源码路径、符号、错误消息、环境变量或命令参数。原有终端进度、警告和错误仍可能包含路径，因此不要把整个终端日志当匿名材料。计量不读取额外源码、不运行额外 SQL；默认本地日志的写入范围见下节。正常异常退出会尽力输出；SIGKILL、进程崩溃或断电无法保证。

## 单位与包含关系

所有 `Ms` 为单调时钟累计毫秒，`Count`、`Calls`、`Errors` 为次数。四舍五入后为 0 的字段省略；缺少字段表示未发生或累计不足 0.5 ms。记录的是 wall time，不是 CPU 时间。

- `wallMs`：本次 SDK sync 调用；`stages` 为互斥阶段，包含锁等待、清理与未细分工作。`synthesisMs` 是合成尾阶段整体，必要时也包含全量引用恢复，不能将它全算成关系合成本身。语言范围重建回退仍保留总时间，但没有普通增量路径的全部细项。
- `extraction`：抽取阶段互斥墙钟切片，包括 reconcile、读取、parseWall、storeWall、清理等。worker 解析可与别的阶段重叠，不能把它理解为逐 worker CPU 之和。
- `store`：主线程存储子阶段；`fallbackIndexFileMs` 为回退单文件索引的整体包含时间。不是所有包装开销都已细分。
- `worker`：`rpcWallMs` 包含首次懒创建和整次调用；`requestWallMs` 包含等待、传输及 worker 事务。`transactionWallMs` 包含 `bodyMs` 和 `boundaryMs`。后者是 BEGIN、COMMIT/ROLLBACK 及包装开销的残差，不能当纯 fsync 或纯 commit 时间。子阶段已在这些总时间内，不可再次相加。
- `wal`：`backpressureWaitMs` 是调用者实际等待；`foldMs` 含 drain 和 park；`parkMs` 含 PASSIVE/TRUNCATE、重试及在途检查等待。`advisoryPassiveMs` 是后台检查工作。等待与实际检查重叠，不能相加。阶段前缀按调用开始阶段归属，同一次共享检查可能有多个等待者。
- `refs`：各 scope 的 `WallMs` 包含互斥的 `PlanReadMs`、`ResolveMs`、`AfterWriteMs`、`YieldMs`（failedRetry 另有 FilterMs），`UnattributedMs` 为剩余包装工作。`Detail*` 是 Resolve 内嵌细项，包括 deferred journal；不能将 Detail 再加到 Resolve。WAL 等待也已包含在 AfterWrite 或上层阶段时间里。

每次 sync 都新建计量，不跨调用累计。失败时已完成的部分仍保留，但并非每种系统崩溃都能发出摘要。原有解析、事务、WAL 阈值和并发策略不改变。

## 默认本地运行日志

普通 `sync` 现在默认保留匿名阶段快照，不必打开终端摘要。目录来自**实际数据库路径的父目录**，通常是 `.codegraph-wx/logs`；已有 `.codegraph` 或 `CODEGRAPH_DIR` 覆盖目录也在各自目录内保存。设置 `CODEGRAPH_SYNC_LOG=0` 或 `CODEGRAPH_SYNC_LOG=false` 可关闭（去空格、不区分大小写），不影响显式 `--diagnostics-summary`。

成功获得索引写锁后记录开始、阶段切换、每 60 秒累计快照和结束状态。正在进行的阶段通过 `phase`、`phaseElapsedMs` 表示；部分子计量直到该操作返回才可累计，因此中途快照不是已完成工作证明。同步 JavaScript/SQL 长时间阻塞会推迟定时快照和异步写入调度；已成功落盘的最后阶段入口可供定位，不能保证阻塞瞬间已有最新快照。无需上传完整终端，只检查并分享本功能日志中的数字。

每次运行独立文件，最多 1 MiB；有界队列合并/丢弃过量观测快照并记数量，为最终状态预留空间。批量异步写入，不逐行 fsync，不连接数据库。正常完成文件仅保留最近 10 份；活跃、异常退出遗留文件及用户其他文件不参与清理。异常退出遗留文件可由用户确认后手动清理。拒绝日志目录/文件符号链接；便携路径检查不能承诺抵御恶意并发替换目录。

日志写入失败时停止本次日志，最多提示一次固定警告，不包含错误原文或路径，不改变原 sync 成功/失败结果。最终刷新只尽力等待有限时间，未完成写入会继续安全清理；操作系统层面无法中断的磁盘 I/O 不具备绝对时间保证。定时器不会单独保持进程运行。进程被强杀、断电或磁盘故障时，文件可能只有最后一次完成的快照。

默认计量本身也有时钟与计数开销；小样本需要开/关对照，不能保证私有大库或慢盘上绝对零影响。`stages.logFlushMs` 仅终端最终摘要可观测到完整日志刷新等待，文件末尾快照生成于刷新完成之前。
