# 固定活动路径安全替换：第一阶段独立原型

基线：`feat/adaptive-sync-rebuild-20261028` / `22fcbf836e390fb9e565d8b6a33887a8c7276b86`。

**不是默认实现，不允许据此直接合并全面改造。** 本目录不被 `src`、CLI、MCP 或 SDK 的生产入口引用。Windows 必须另行实测。生产布局迁移、完整大仓性能、打包发布均未执行。

## 运行和交接

需要 Node 22.13+ 或当前项目支持的 Node 24（不使用 Node 25），具备 `node:sqlite`。在仓库根目录：

```sh
npm ci --ignore-scripts
npm run build
node scripts/prototypes/fixed-path/run.mjs
```

Windows PowerShell 使用相同三条命令。无需 Python、外部 SQLite CLI、管理员权限或运行真实用户数据库。所有数据库都是系统临时目录下新建测试夹具，代码库中的真实 `.codegraph-wx` 不会被触碰。`--ignore-scripts` 只省略与本原型无关的 native-helper 安装；仍由真实 CodeGraph Python 提取器索引测试源码。

默认输出 `artifacts/fixed-path-prototype/<platform>-final-<timestamp>/`：

- `run.log`：实际测试输出；`exit.json`：退出码。
- `environment.json`：Node、OS、CPU、内存。
- `acceptance.json`：跨进程/故障场景、阶段耗时、短查询分位数。
- `graph-integration-<platform>.json`：三轮真实 CodeGraph 全循环，每轮两次重建。
- `graph-performance-<platform>.json`：1001 文件、五个独立查询进程、真实查询/框架检测与重建耗时。

失败测试的证据不得替换为“预期失败”。`exit.code=0` 且全部测试成功才是该环境本轮测试通过。Windows 执行者应回传上述整个目录、Node/Windows 版本及是否运行在本地磁盘。不要只回传退出码。

可选：`FIXED_PATH_EVIDENCE_DIR` 指定证据目录；`FIXED_PATH_PERF_FILES` 修改性能夹具文件数。任何放宽预算或减小负载的运行必须单独标识，不能覆盖原门禁报告。

## 实际覆盖与边界

- `protocol.mjs`：真实文件/SQLite OS 锁/跨进程协议。
- `worker.mjs`、`acceptance.test.mjs`：SQLite 控制夹具，故障注入、多进程一致性、同步 SDK 自锁、日志配对、恢复和清理。
- `graph-adapter.mjs`：**测试专用内部适配器**，直接使用编译后的 CodeGraph 构造器、DatabaseConnection、QueryBuilder、提取器、resolver。设置 shadowCandidate 以绕开当前生产 CURRENT 解析。未伪造版本/ownership；库由实际 indexAll 创建。
- `graph-client.mjs`：五个独立进程分别标为 CLI/MCP/daemon/SDK/background-worker，使用上述适配器。标签不是生产入口覆盖证明。
- `graph-integration.test.mjs`：调用实际 `createAdaptivePlan/chooseAdaptiveStrategy`，用无历史下的 structural-large-change 路径选择重建，普通变更调用实际 `sync({adaptive:false})`。不是手动强行把每次 sync 变成 init。

第一阶段验证的是“所有使用者接入此协议以后”的可行性。尚未改动默认初始化、生产 SDK、真实 MCP transport、daemon、后台 watcher 等入口；这属于第二阶段，不能提前宣称已覆盖生产全链路。

参与者适配器不得让 native handle 逃逸到请求生命周期外；所有异步数据库使用必须在 action resolve 前完成，factory.close 必须关闭整组句柄。实际 SDK 的低层 getDb/自定义连接入口如何满足这一约束仍须在第二阶段接入审计，不能仅靠标签宣称覆盖。

仅限同一主机本地文件系统。**旧版程序、直接连接 SQLite 的外部工具、绕过 Participant 的 native handle 不在协议范围内。** SQLite 租约不能证明这些使用者退出，Linux 允许重命名打开文件更不能作为安全证明。Windows 文件共享错误必须按失败/恢复处理，不得禁用保护。网络文件系统、符号链接数据目录不在支持范围。

## 协议

活动文件始终是普通文件 `.codegraph-wx/codegraph.db`；原型不读取 CURRENT，也不将固定文件变成副本或链接。

内部文件位于 `.codegraph-wx/.runtime/fixed-path-prototype/`：

- `gate.sqlite`：短事务，持久化准入状态、写入 revision、操作记录和可失效成本样本。
- `publisher.sqlite`：发布者生命周期独占锁。进程死亡由 SQLite OS 锁释放证明，不能使用 PID/时间猜测。
- `connections.sqlite`：每个真实连接组持共享事务，只有所有 native handle（含缓存 reader）实际关闭后才释放。
- `writers.sqlite`：参与写操作持共享锁，发布预检和切换持独占锁。
- `<operation UUID>/`：拥有独立 owner marker 的候选和临时旧库。恢复记录包含完整路径、操作 ID、阶段及旧/新 SHA-256。

### 构建和切换

1. 独立发布进程持 publisher 锁，短暂取得 writers 排他锁，确认没有既存写操作并记录构建开始时的 revision；随后释放写锁、后台构建候选，读者继续工作。
2. 候选执行完整 integrity_check、真实 ownership/索引完整性校验、checkpoint、刷盘；转换成不依赖 WAL 的 DELETE 日志模式，验证后再次校验 SHA-256。
3. 独占 writers 锁，比较构建开始时 revision。任何参与写在执行 action 之前先持久化 revision 写意图；构建期间出现写意图就取消，即使 writer 在数据库 COMMIT 后、finally 前崩溃，也不能漏检并覆盖已确认写入。
4. 比较真实源码快照。耗时哈希、候选验证、旧库 checkpoint 和旧库 SHA-256 都在暂停准入之前。
5. 持久化 DRAINING；阻挡新请求。常驻空闲连接通过短周期观察状态关闭所有句柄；活动请求完成后关闭。绝对排空截止时间为 1000ms，不因重试重置。
6. 取得 connections 独占锁才允许替换。最终由 SQLite 执行轻量 checkpoint/关闭，清掉只读末连接可能遗留的空 WAL/SHM，单独计时。任何仍存在的活动日志都导致失败；不直接 unlink 活动日志。
7. 持久化 REPLACING 意图；旧库改名到本次 old.db，候选就位 codegraph.db。两次 rename **不是整体原子操作**，每步有恢复阶段。
8. 只做廉价可打开检查；完整扫描已经完成。持久化 COMMITTED 后才恢复准入，新请求重建对象与缓存。
9. 清理失败不回滚。仅清理本操作已验证身份的 old/candidate；未封口失败构建只允许清理其独占拥有目录中的保留文件名及配对日志。遇到未知文件、路径、身份保留证据并报错/保留清理待办。成功清理保留轻量审计记录，不保留数据库目录。

### 同步 SDK

发布者必须在独立进程，不能与参与者共用同一个事件循环。同步请求碰到 DRAINING 且本进程还有 async 请求时，持久化取消请求；发布者可无需等待该 async 回调完成就恢复旧库准入。然后同步请求使用旧库，避免自锁。已进入替换窗口意味着本进程所有连接及活动操作已排空，此时有界等待独立发布进程不会依赖本进程 async 回调。

这不是通过暴露 SQLITE_BUSY 实现“透明切换”。锁竞争只在短协调事务的获取/提交处有界重试，不重复执行可能产生 native handle 或写入副作用的 action。真实 I/O、损坏状态、超长发布失联会明确报错，不能无限等候。

## 恢复规则

启动必须先尝试取得 publisher 锁并恢复，再允许打开活动库：

- BUILDING / PREPARED / DRAINING：未授权 rename，可取消并继续旧库；无需等待尚在运行的旧请求退出才恢复准入。
- REPLACING / OLD-MOVED / NEW-MOVED：取得连接排他锁，按旧/候选 SHA-256 与路径组合识别“未搬”“只搬旧”“新已就位但未提交”。只有明确可识别组合才恢复旧库。
- COMMITTED：单向边界，不再允许恢复旧备份；即便已经接受写入后崩溃，也只重试清理。
- 完成发布后保留的记录是 cleanup-only。用户随后正常离线覆盖公共文件时，不能要求当前库仍匹配历史候选 SHA，也不能据旧记录恢复历史库。
- 未知阶段、无恢复记录、路径越界、候选/旧身份不匹配：拒绝打开，保留所有证据。

进程 SIGKILL/Windows 强制终止是本测试的故障模型。SQLite FULL、文件 fsync、Linux 目录 fsync 是实现措施，**没有执行断电、磁盘缓存丢失或损坏扇区测试，不能声称已证明断电持久性**。Windows 未实现/验证目录 fsync 等价保证，报告明确标注 false。

## 公共库

公共库从完整索引后 checkpoint/关闭的单文件生成，不拷贝发布机器辅助文件。正常关闭所有参与者，最后一个连接关闭后由 SQLite 自身完成日志收尾，然后可直接覆盖固定路径。重启不读取 CURRENT，也不复用旧对象缓存。

原型在新建连接对象时保守清空内部成本样本，不因没有历史而强制 init。真实无变更公共库测试继续走 ordinary incremental/no-content-changes。示例仅验证相同版本/提取规则/源码/配置的兼容库；配置/版本升级、历史 legacy 来源准入、迁移冲突将在第二阶段按现有生产兼容机制完整接入，不能据此承诺任意公共库免重建。

测试包括 producer 与不同 consumer 项目绝对路径，实际符号 filePath 为相对路径，查询和 sync 正常。损坏公共文件报错，不静默回退 generations 中另一份库。

## 尚未关闭的门禁

1. Windows 真实执行结果由用户侧 Claude Code 补验；Linux 不能代替。
2. 1001 个合成 Python 文件和小 SQLite 控制夹具不是 OceanBase/超大 C++ 仓性能证据，也没有验证所有真实生产入口。
3. 源码完整快照 + 发布前 stat fence 可以拒绝测试中的变更，但外部编辑器并不服从数据库锁。最终检查之后的新文件/保留时间戳编辑仍存在文件系统 TOCTOU，不能声称源码目录被原子冻结。全面接入前需要明确源 epoch/变化后自动补同步契约及新增并发编辑回归；本原型不会把这一点标成已完成。
4. 原型为便于审计采用脚本和内部构造器，不是发布 API；Node 18 等无 node:sqlite 的运行时没有实现替换协议。
5. 不具备上述证据前，不迁移 CURRENT/generations，不处理冲突覆盖，不生成测试 npm 包，不宣称可合并。
