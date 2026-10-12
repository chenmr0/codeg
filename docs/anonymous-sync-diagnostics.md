# 匿名 sync 累计诊断

运行 `codegraph sync --diagnostics-summary`，无需 `-v`。完成后只复制以 `[sync-summary]` 开头的 8 行。`--quiet` 可组合使用。默认不开启，不增加这些输出。SDK 可传 `sync({ diagnosticsSummary: lines => ... })`；回调异常不会改变 sync 结果。

摘要只含固定字段、数字和状态枚举，不含源码路径、符号、错误消息、环境变量或命令参数。原有终端进度、警告和错误仍可能包含路径，因此不要把整个终端日志当匿名材料。摘要不写文件、不读取额外源码、不运行额外 SQL。正常异常退出会尽力输出；SIGKILL、进程崩溃或断电无法保证。

## 单位与包含关系

所有 `Ms` 为单调时钟累计毫秒，`Count`、`Calls`、`Errors` 为次数。四舍五入后为 0 的字段省略；缺少字段表示未发生或累计不足 0.5 ms。记录的是 wall time，不是 CPU 时间。

- `wallMs`：本次 SDK sync 调用；`stages` 为互斥阶段，包含锁等待、清理与未细分工作。`synthesisMs` 是合成尾阶段整体，必要时也包含全量引用恢复，不能将它全算成关系合成本身。语言范围重建回退仍保留总时间，但没有普通增量路径的全部细项。
- `extraction`：抽取阶段互斥墙钟切片，包括 reconcile、读取、parseWall、storeWall、清理等。worker 解析可与别的阶段重叠，不能把它理解为逐 worker CPU 之和。
- `store`：主线程存储子阶段；`fallbackIndexFileMs` 为回退单文件索引的整体包含时间。不是所有包装开销都已细分。
- `worker`：`rpcWallMs` 包含首次懒创建和整次调用；`requestWallMs` 包含等待、传输及 worker 事务。`transactionWallMs` 包含 `bodyMs` 和 `boundaryMs`。后者是 BEGIN、COMMIT/ROLLBACK 及包装开销的残差，不能当纯 fsync 或纯 commit 时间。子阶段已在这些总时间内，不可再次相加。
- `wal`：`backpressureWaitMs` 是调用者实际等待；`foldMs` 含 drain 和 park；`parkMs` 含 PASSIVE/TRUNCATE、重试及在途检查等待。`advisoryPassiveMs` 是后台检查工作。等待与实际检查重叠，不能相加。阶段前缀按调用开始阶段归属，同一次共享检查可能有多个等待者。
- `refs`：各 scope 的 `WallMs` 包含互斥的 `PlanReadMs`、`ResolveMs`、`AfterWriteMs`、`YieldMs`（failedRetry 另有 FilterMs），`UnattributedMs` 为剩余包装工作。`Detail*` 是 Resolve 内嵌细项，包括 deferred journal；不能将 Detail 再加到 Resolve。WAL 等待也已包含在 AfterWrite 或上层阶段时间里。

每次 sync 都新建计量，不跨调用累计。失败时已完成的部分仍保留，但并非每种系统崩溃都能发出摘要。原有解析、事务、WAL 阈值和并发策略不改变。
