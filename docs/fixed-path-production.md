# 固定路径 v1：受控生产接入（不默认启用）

本次补查修复基于整理后的 `5c8b81d7`，不引入整理前的提交历史。这不是正式 npm 发布或所有平台已验收的声明。

## 使用边界

* 新项目显式设置 `CODEGRAPH_FIXED_PATH=1` 后，真实 `CodeGraph.init/initSync` / CLI `init` 创建并使用 `.codegraph-wx/codegraph.db`。
* 已有项目先正常停止所有 CLI/MCP/daemon/SDK 和外部 SQLite 工具，再运行 `codegraph migrate-storage <项目> --offline`，或 `CodeGraph.migrateStorage(root,{offline:true})`。
* 提交后的 `.runtime/layout.json` 是布局权威。随后不再要求设置环境变量，不能因为开关关闭、CURRENT 损坏/残留而回到旧代。
* 已有根库与 CURRENT 同时存在时报冲突，保留两者，不猜测新旧。完整迁移细节见 `fixed-path-layout-migration.md`。
* 协议只约束使用本版本生命周期入口的程序，不能保证旧版进程或外部直接 SQLite 工具存在时可安全在线替换。
* 低层 `DatabaseConnection` 不允许绕过已登记固定库的准入。固定模式 `uninitialize()` 暂时拒绝在线删除，需要停止进程后显式离线处理。

## 生产入口与生命周期

真实 SDK 的固定布局 facade 通过统一 controller 访问可退休的 db/query/resolver 组合。同步方法保持同步，异步方法保持租约至整个 Promise 完成。每次重开创建新的缓存对象与连接身份，不用固定路径字符串判断是否同一库。

MCP `ToolHandler.execute()` 为整个请求（包括后处理）保留同一读 handle；空闲 MCP/SDK 连接观察到 draining 后关闭，下一请求自行重开。后台 watcher 属于稳定 facade，不随读 handle 退休。CLI/daemon 通过相同 `CodeGraph.open` 路由；真实 stdio/daemon 验收必须另做，不能拿 ToolHandler 测试代替。

这里的读 pin 是文件代际租约，不等于跨多个独立 SDK API 的 SQLite 读事务。它保证换库不会在在途请求中途关闭/替换其 handle；普通同代增量提交仍可能在两次 API 调用之间可见。不能把同一文件代际内前后哈希变化直接判为换代混读，也不能声称该 pin 提供跨 API 的事务快照。

原生 checkpoint/maintenance、store writer 和 parallel resolver worker 有独立 OS 连接租约，必须保留到真实 worker exit；关闭父对象不是 worker 已退出的证明；writer 的 mutation 排他权也一直保留到最后一个原生后台线程退出。构造/close 失败的原生连接仍保留独立租约，不因 JS facade 错误而让发布者重命名活跃文件。

固定布局的普通写入用 `.runtime/fixed-path-v1/mutations.sqlite` OS 排他锁串行化，不用崩溃后永久遗留的 PID 文本锁。发布者仍用 writers/connection 租约协调排空；先记录写意图，再打开可能执行迁移/修复的 writer 连接。

新建固定布局同样先写持久初始化意图，再在私有候选中创建 schema；活动根文件可见前，当前版本的发现与底层打开入口均被意图阻挡。进程异常后的恢复先于正常准入；已提交布局不因清理失败退回旧库。详见 `fixed-path-initialization.md`。支持原生协调的运行时中，低层 legacy 根库首建也用相同创建锁；WASM 后端须先物化完整 schema，再释放创建准入。缺少 `node:sqlite` 的旧运行时仍只支持 legacy，不能与固定布局进程并发首建或离线迁移；这种跨运行时升级必须先关闭旧进程。

## 自动重建

`sync()` 在工作线程完成规划，达到策略条件时启动独立 publisher 进程。候选构建与 publisher ownership 属于同一进程；取消和退出后才释放所有权。完整验证、源码全量检查、checkpoint/hash 在排空之前。排空预算保持 1 秒，未替换时超时取消，旧库继续提供查询。同步 SDK 不阻塞等待本进程的异步请求释放，而请求取消尚未替换的 drain。

初版受控接入保守丢弃固定布局的旧成本历史（绝不套用被离线覆盖前数据库的样本）。缺少历史本身不触发全量；大变更、配置/提取规则和官方旧库升级仍由策略决定。暂未保留跨启动的成本校准，这不是“已证明最优”的耗时策略。

切换不等于源码瞬间严格一致。验证只覆盖观察到的源码；发布后在后台工作线程进行完整内容补查，发现后来的修改则自动再次同步/重建，源码稳定并且补查成功后返回；后续 watch 事件仍由稳定 facade 排队。不得将一次小夹具耗时当作收敛时限。生产接入的补查收敛及大仓性能仍需验收。连续修改可能延长同步，调用方可取消，不能承诺固定秒数完成。

发布候选在封存前已将补查义务与操作 UUID 写入自身元数据；因此发布 COMMIT 后、父进程收到结果前退出也不会漏记。标记随数据库一起恢复或离线复制，不从已退休的发布记录推断新库的状态。取消、读取失败、提取失败和引用解析中断均保留补查义务；重新打开后，普通同步、指定 paths、`adaptive:false` 或 `CODEGRAPH_ADAPTIVE_SYNC=0` 都先恢复补查。

补查在同一受控 mutation/writer 租约下完成全内容核验、修复和条件确认，排除已准入但仍在写入的并发操作；内容不符的文件强制绕过 size/mtime 与同 hash 的存储快捷路径。配置变化即使源码 hash 相同也执行完整重提取。只有新的全内容核验、配置指纹、完整性及持久引用/重试尾部均完成，且操作 UUID 和修订仍匹配时才移除标记，之后恢复普通 stat 快路径。失败丢失的 source ownership 不会被补查伪造恢复。

补查所需的后台线程使用限定于该异步操作的干净启动参数，兼容 `--input-type=module` 等父进程专用参数；不会修改进程全局 argv 或环境。取消解析等待真实 worker 退出后再释放写入准入。

## 单文件公共库离线覆盖

1. 正常关闭全部相关程序，等待后台写入/worker 退出。
2. 发行端提供完整一致、已 checkpoint 的自包含 `codegraph.db`（无发行端 WAL 依赖）。
3. 覆盖本地根目录的 `codegraph.db`；不用删除 `.runtime` 或旧 CURRENT。
4. 重新启动。新建缓存读取新库；损坏或缺失文件明确报错，绝不静默读取另一份旧库。

同版本、规则/配置/源码匹配的公共库可直接查询、增量同步；确实不匹配时仍可能需要兼容处理、升级或重建。

## 验证命令

```
npm run build
node --liftoff-only scripts/tests/fixed-path-production.test.cjs
node --liftoff-only scripts/tests/fixed-path-catchup.test.cjs
node --liftoff-only --test scripts/tests/fixed-path-layout.test.cjs scripts/tests/fixed-path-initialization.test.cjs
node --liftoff-only scripts/tests/fixed-path-writer-open-admission.test.cjs
node --liftoff-only scripts/tests/fixed-path-failed-native.test.cjs
node --liftoff-only scripts/tests/fixed-path-legacy-creation.test.cjs
node --liftoff-only scripts/tests/watcher-ambiguous-event.test.cjs
node --liftoff-only scripts/tests/fixed-path-real-mcp.test.cjs
node scripts/tests/run-fixed-path-protocol-parity.mjs
```

生产 SDK 测试直接执行 `node:test` 文件，避免 Node 的 `--test` 子执行器注入数十个默认 runtime flags 改变自适应 fingerprint；不是修改提取代码/伪造 provenance。协议对照测试使用原型矩阵，但将协议实现替换为 emitted 生产模块；这些对照不等于 CLI/MCP/daemon 端到端通过。

进程强退恢复不等于断电持久性。Windows 目录刷盘没有未经验证的保证。仍需在同一代码提交上独立完成 Windows/Linux、真实生产入口、大仓性能及迁移验收后，才能考虑默认启用或发布正式包。

## Concurrent sync callers

Fixed-path CLI/MCP/daemon/SDK sync calls acquire a distinct OS-backed
`sync-admission.sqlite` lease **before** planning. A cold MCP catch-up and an
explicit SDK sync therefore queue, rather than launch competing publishers. A
waiter holds no active graph, mutation or publisher lease and plans again from
current source/storage after admission; it does not claim that another caller's
result completed its own requested sync.

`syncCoordinationTimeoutMs` bounds initial operation admission (default 30
minutes). Retrying a pre-construction publisher/recovery collision uses the
remaining wall-clock budget measured from this sync invocation, including time
already spent planning/building; an already running build is not killed solely
because that retry budget expires. `AbortSignal` cancels the waiting caller. Neither changes the
one-second publication drain budget or cancels the existing publisher. An
expired waiter fails explicitly, even if the lock becomes free before its next
poll. A killed parent's still-live publisher child remains protected by its
separate OS owner lease. Abandoned-state recovery/hash/cleanup runs off-thread,
and admission remains held until the recovery thread actually exits. This is
cooperative sync coordination, not support for arbitrary external SQLite tools.

Only the typed `FIXED_PUBLISHER_BUSY` result, emitted before publisher ownership
or candidate creation, permits automatic wait/replan. Validation, I/O, damaged
state and post-construction failures are not blindly replayed.
