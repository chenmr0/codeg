# 三条 TIFM 符号查询：MAME 复现与耗时定位

2026-09-15，当前源码 `41550caeee3403f095b47865b02faf8abb7105ca`，本地 package 版本 `1.1.0`，Windows / Node v24.11.1 / node:sqlite。

本文保留修改前的复现和耗时记录。后续已将 MCP search 改为默认精确查询，仅通过 `CODEGRAPH_SEARCH_FUZZY=1` 启用模糊搜索；修改后的验收数据见 [精准查询与原文扫描诊断](../search-exact-and-ripgrep-benchmark.md)。

## 结论

**复现了精确未命中后的慢搜索路径，但没有复现用户现场的 362.315 秒或源码扫描超时。当前本机约 83%–84% 的请求时间消耗在同步数据库搜索，主要是重复的 LIKE 全表扫描和全量符号名读取。**

- 用户给出的 `D:\c\_proj\mame` 不存在；实际使用 `D:\c_proj\mame`。
- 原样三条查询、每条均为 `includeCode: "if_unique"`：初次测量为 **9.731 / 6.411 / 6.076 秒**；最终同进程对照为 **6.144 / 6.401 / 6.376 秒**。
- 这些 TIFM 名称在 MAME 中没有精确或模糊命中。因此补测了三个真实 MAME 符号各替换一个字符的场景，确认能返回相近函数、声明及 `exact identifier behind fuzzy results`，耗时 **6.483 / 6.183 / 6.454 秒**。
- 所有上述扫描均完整覆盖 **23,340 个文件、554,531,856 字节**，使用 ripgrep，未达到时间预算。
- 本次只新增诊断脚本和报告，没有修改产品搜索算法。

## 测量边界

- MAME 提交：`57cf29e2c75e24ac168d35a418cbd6d26113088e`。
- 复用完整索引 `bench-logs/mame-init-20260909/fork-macro-context/codegraph.db`：5,246,017,536 字节，1,614,524 节点，23,380 文件，639,529 个不同符号名。
- 实际运行当前构建的 `serve --mcp`，通过 stdio JSON-RPC 调用工具 `search`。数据库工厂被测试钩子强制设置为只读；保留真实源码目录供扫描。
- 禁用 daemon、watcher 和启动 catch-up，隔离查询成本。预热 `debugload` 后计时；最终进程握手约 719 ms，预热约 55 ms，单独记录，不计入后续查询时间。
- 源码扫描预算显式使用默认值 8,000 ms。关闭 watcher 后不会复用原文证据缓存，每个需要证据的请求都执行实际扫描。
- 未清空操作系统文件缓存；“初次测量”不代表受控冷缓存，最终对照发生在之前测量之后。
- 方法包装只记录计时、调用次数、SQL 和 worker 进度，不改变查询参数、结果或搜索分支。父阶段包含子阶段，不能重复相加。
- stdout 回复和 stderr 轨迹通过服务端请求 ID 对齐，并等到该请求的结束轨迹到达才聚合，避免不同管道到达顺序造成跨请求计时混入。

## 最终三轮对照

单位：毫秒。

| 场景 | 第一轮 | 第二轮 | 第三轮 |
| --- | ---: | ---: | ---: |
| 用户原样三条 TIFM 查询 | 6,144 | 6,401 | 6,376 |
| MAME 三条拼写错误、返回模糊命中 | 6,483 | 6,183 | 6,454 |
| 对应 MAME 三条正确名称 | 1,011 | 988 | 995 |
| `debugload` 精确命中，无原文兜底 | 1.74 | 1.46 | 1.29 |

模糊对照及正确名称：

| 查询 | 相近的真实符号 |
| --- | --- |
| `next_paren2_software` | `next_parent_software` |
| `make_softwar2_searchpath` | `make_software_searchpath` |
| `rom_firs2_parameter` | `rom_first_parameter` |

第三项同时返回实现与“此重载没有已索引定义”的声明，覆盖用户输出中的相应格式化路径。模糊场景的格式化总耗时仅 0.37–0.89 ms。

正确名称对照仍约 1 秒，是因为 `rom_first_parameter` 的声明触发原文证据；并非精确索引查询自身要 1 秒。无兜底的 `debugload` 对照只需约 1–2 ms。

## 时间主要在哪里

以下取原样三条查询最终第三轮，总计 **6,375.63 ms**。表内各阶段不重复包含。

| 阶段 | 耗时 | 占总时间 |
| --- | ---: | ---: |
| LIKE 搜索，6 次 | 2,627.24 ms | 41.2% |
| 获取全部不同符号名，6 次 | 2,437.76 ms | 38.2% |
| 模糊阶段除取名之外的处理，主要为编辑距离 | 303.95 ms | 4.8% |
| FTS，6 次 | 3.68 ms | 0.06% |
| 共享原文证据扫描，1 次 | 1,000.03 ms | 15.7% |
| 精确查询、调用及其他开销 | 约 3 ms | <0.1% |

同步 `searchNodes` 合计 **5,373.12 ms，约 84.3%**。三轮原样查询都记录到约 5.1–5.4 秒的主线程事件循环延迟，与数据库阶段吻合。

原文阶段中的进一步分解（包含在上述 1,000.03 ms 内）：

- 主线程读取索引文件清单 `getFiles`：33.23 ms。
- worker 内 `rg --files` 枚举：161.65 ms。
- worker 内 `rg --json` 内容搜索：694.35 ms，正常无匹配退出。
- 剩余约 111 ms 包含 worker 启动、任务传递、清单处理、报告和线程退出。

## 代码上的原因

### 1. 三条查询实际执行六遍完整搜索链

`src/mcp/tools.ts:1828` 顺序处理 batch 中的各项。精确查询没有结果时：

1. `tools.ts:1944` 调用 `findCaseInsensitiveSymbolMatches`。
2. 该方法在 `tools.ts:5890` 调用 `cg.searchNodes(..., { limit: 100 })`，会走 FTS → LIKE → 编辑距离全链。
3. 没有大小写无关精确命中后，`tools.ts:2082` 再调用一次 `cg.searchNodes` 获取模糊建议。

因此每条两遍、三条共六遍。`await handleSearchSingle` 不会把内部同步 SQLite 和编辑距离计算移到其他线程；批次仍可连续占用主线程数秒。

最终每个 batch 的轨迹都确认：6 次 `searchNodes`、6 次 LIKE、6 次 `getAllNodeNames`，以及 1 次共享原文扫描。原文并没有为三个符号各扫一遍仓库。

### 2. LIKE 是全表扫描

`src/db/queries.ts:1651` 使用 `name LIKE '%query%' OR qualified_name LIKE '%query%' ...`。当前索引的 `EXPLAIN QUERY PLAN` 为 **`SCAN nodes`**，查不到也需要检查节点表。结果数 `limit` 很小，不能避免未命中时的全表扫描。

### 3. 名字集合没有结果缓存

`src/db/queries.ts:1508` 每遍 fuzzy 调用 `getAllNodeNames()`；`queries.ts:2426` 只缓存 prepared statement，每次仍执行 `SELECT DISTINCT name FROM nodes`，取出并转换全部 **639,529** 个名字。

一次三条 batch 共取出约 **384 万个名字**。当前“集合已缓存”的注释与实现不符。实测主要成本在取名与物化，编辑距离本身约 0.3 秒。

### 4. 返回模糊结果时还多一个全表扫描

`src/db/queries.ts:1242` 的补充查询为 `WHERE name = ? COLLATE NOCASE`，当前索引的计划也是 **`SCAN nodes`**。模糊命中对照里执行 6 次，合计约 **0.345–0.365 秒**。

已有的 `idx_nodes_lower_name` 能服务 `WHERE lower(name) = ?`，其计划为 **`SEARCH nodes USING INDEX idx_nodes_lower_name (<expr>=?)`**；现有表达式索引不会自动被上述 NOCASE 查询使用。

## 为什么不能把现场六分钟直接归因于原文扫描

用户输出只提供整体耗时和最终状态，没有阶段耗时。

- **8 秒不是整个 search 的截止时间。** 当前扫描预算从 worker 的 `scanRawSourceSnapshot` 开始计算（`src/mcp/raw-source-evidence.ts:480`），不包含之前的数据库搜索、主线程取文件清单、worker 排队/启动或结果交付。
- **`0/N` 不能证明没有读过文件。** ripgrep 枚举或内容阶段中断时，`raw-source-evidence.ts:410` / `:440` 直接返回 `totalScannedFiles: 0`。内容搜索阶段超时也会出现这种计数；它不是实时文件进度。
- 当前代码含 `fd3adaf` 的原文 worker 修复。该修复隔离扫描计时和 I/O，但没有迁移同步数据库搜索，后者仍会阻塞 MCP 回复。修复前“其他查询阻塞主线程、已完成 rg 被误报超时”的真实复现见 `mcp-concurrent-search-timeout-2026-09-11.md`；不能假定用户现场已部署修复或发生了相同并发。
- 用户现场统计为 97,648 文件，本机证据范围为 23,340 文件；节点数、不同符号名数、软件版本、SQLite 后端、硬件及并发情况都未提供，不能按文件数直接换算六分钟。

**可以确认当前本地的首要瓶颈是数据库搜索；仅凭这段返回不能给远端 362 秒分账。** 现场应采集相同阶段轨迹，并记录版本、Node/SQLite 后端、索引节点与名字数量、同期请求/同步活动，再区分搜索本身、扫描超时和等待交付的耗时。

## 优先优化方向

1. 大小写纠正走专门的索引精确查询，保持限定名和唯一性语义；消除一整遍重复的模糊搜索。
2. 缓存不同符号名结果，按索引变更正确失效；必要时再缩小编辑距离候选范围。
3. 修正 NOCASE 补充查询的索引使用，并优化或约束未命中时的 LIKE 全表扫描。
4. 给整个工具请求设置可观察的预算，并隔离同步重查询，避免阻塞其他 MCP 请求。只增大原文 8 秒预算不会解决前面数秒乃至更长的数据库阶段。

这些是基于测量的修复建议，本次没有实施或声称取得其性能收益。

## 复现和产物

```powershell
npm run build
node scripts/repro-search-batch-profile.cjs --rounds 3

# 原样查询与三组对照在同一个 MCP 进程中交替执行
node scripts/repro-search-batch-profile.cjs --rounds 3 --calls-file bench-logs/search-batch-20260915/all-calls.json --out bench-logs/search-batch-20260915/final
```

脚本也支持 `--project <root>` 和 `--database <db>`。它要求支持 node:sqlite 的 Node 版本以保证索引只读。

- 脚本：`scripts/repro-search-batch-profile.cjs`。
- 初次原样三轮：`bench-logs/search-batch-20260915/results.json`。
- 最终四组各三轮：`bench-logs/search-batch-20260915/final/results.json`，包含参数、SQL 计划、完整 MCP 返回、每个请求的阶段轨迹。
- 最终进程原始轨迹：`bench-logs/search-batch-20260915/final/server.jsonl`。
- 全部对照输入：`bench-logs/search-batch-20260915/all-calls.json`。
- 早期 SQL 包装钩子试跑未进入查询；随后观察到 stdout/stderr 切片聚合可错位，已改为请求 ID 对齐并完成最终复测。中间试跑目录不作为本报告分项计时依据。

`npm run build`、脚本 `node --check` 和 `git diff --check` 通过。最终 12 次请求全部成功，轨迹确认每个未命中 batch 为六遍搜索、一次原文扫描。MAME 工作树无变更，原索引大小和修改时间保持不变（2026-09-10 01:17:11）；测试进程正常结束。
