# MAME 不存在符号搜索：MCP / CLI 耗时对照

2026-09-11，当前源码 `c06ed32`、包版本 `1.0.7`，Windows / Node v24.11.1 / node:sqlite。

**已复现 MCP 未命中查询显著慢于默认 CLI。** 三轮中，不存在的裸符号在 CLI 中约 0.38 秒返回；MCP 约 1.86–2.87 秒。已存在且不需要源码兜底的 `debugload`，MCP 仅约 1–2 毫秒。主要开销来自 MCP 未命中后的额外搜索，不能归因于 JSON-RPC 传输本身。

## 输入和测量边界

- 用户提供的 `D:\c\_proj\mame` 不存在；实际目录为 `D:\c_proj\mame`，与此前 MAME 基准记录一致。
- MAME 提交：`57cf29e2c75e24ac168d35a418cbd6d26113088e`。
- 真实源码根目录没有 `.codegraph`；复用本工作区的完整 MAME 索引 `bench-logs/mame-init-20260909/fork-macro-context/codegraph.db`，未重新索引。
- 数据库 5,246,017,536 字节，1,614,524 节点、23,380 文件、639,529 个不同符号名。
- 测试前重新执行 `npm run build`，CLI 和 MCP 使用同一份当前构建产物，未使用全局安装包。
- 运行实际 CLI `query` 命令和实际 MCP stdio `tools/call`。MCP 协议中的工具名是 `search`，客户端通常显示为带服务器前缀的 `codegraph_search`。
- 实验钩子重定向索引位置，并强制通过项目自带的 SQLite adapter 只读打开数据库。关闭 daemon、watcher、启动 catch-up；给搜索方法加耗时记录，不修改其参数、返回值和搜索算法。
- CLI 测量包含每次 Node 启动、模块加载、数据库打开、查询和退出；MCP 测量同一个预热进程的单次请求往返。内部阶段计时单独记录。CLI 的实验钩子加载也计入总时间，因此其总时间是本脚本条件下的值。
- 第一轮 CLI 在 MCP 之前查询，第二轮顺序反转，第三轮恢复。操作系统页缓存未清空，不声称测得受控冷缓存性能。
- 关闭 watcher 后源码证据缓存不启用；原逻辑要求 watcher 活跃且索引 epoch 未变化才可能复用完整扫描。这里每次符合条件的请求都实际扫描源码。

以上隔离了启动同步和后台索引的影响，证明单独的搜索路径即可复现差异；不代表用户客户端现场的完整启动时序。

## 三轮实测

单位为毫秒，表格取三轮中位数。

| 查询 | 默认 CLI | CLI `--fuzzy` | MCP `search` |
| --- | ---: | ---: | ---: |
| `cg_missing_symbol_20260911_7e91`，不存在 | 381 | 1,382 | 2,870 |
| `zzqvnotexist`，不存在、纯小写 | 378 | 1,307 | 1,859 |
| `cg_missing_owner::cg_missing_symbol_20260911_7e91`，不存在、限定名 | 369 | 1,324 | 1,943 |
| `osd_getpid`，已存在、仍触发声明源码兜底 | 370 | 460 | 925 |
| `debugload`，已存在、无需源码兜底 | 370 | 467 | 约 1 |

长裸符号三轮：默认 CLI 为 407 / 381 / 365 ms，MCP 为 2,975 / 2,777 / 2,870 ms。该场景中位数相差约 **7.5 倍**；纯小写不存在符号相差约 **4.9 倍**。

CLI 默认精确查询的内部 `searchNodes` 仅约 2 ms，时间主要在进程和初始化。CLI `--fuzzy` 首次长符号耗时 4,092 ms，其中 LIKE 3,023 ms；后两次总时间为 1,382 / 1,292 ms。首次 I/O 波动没有计作 MCP 的额外成本。

前三个查询的索引精确匹配数均为 0，CLI 模糊搜索也均为 0。长符号和限定名的 MCP 返回 `CONFIRMED_ABSENT`：完整检查 23,340 个符合源码证据范围的文件，0 个文本命中。`zzqvnotexist` 不符合“具有明显代码特征的标识符”规则，未触发源码扫描。

`osd_getpid` 有 4 个精确节点，但当前索引下 MCP 检测到需补充证据的声明，随后扫描源码，找到 8 处文本命中。它说明“存在符号”也不必然省去原文兜底；`debugload` 才是本次无兜底命中对照。

## 两端实际执行了不同的工作

### 默认 CLI

`src/bin/codegraph.ts:1043` 通过 `--fuzzy` 显式选择模糊搜索；默认传入 `exact: true`（1066 行）。`QueryBuilder.searchNodes` 的精确分支跳过 FTS、LIKE、编辑距离扫描。

```text
query <symbol>
  → 按符号名/限定名精确查索引
  → 没有结果，立即返回 []
```

它证明“索引中没有精确符号”，没有额外证明“当前磁盘源码中也没有该标识符”。CLI 加 `--fuzzy` 后才会执行一遍 FTS → LIKE → 编辑距离链，仍不自动执行 MCP 的源码证据扫描。

### MCP

`src/mcp/tools.ts:1944` 在精确未命中时调用 `findCaseInsensitiveSymbolMatches`。该函数在 5890 行使用 `cg.searchNodes(leaf, { limit: 100 })`，所以所谓大小写纠正并不是一次专门的大小写无关索引查找：它会走完整模糊搜索链。

裸名纠正失败后，2082 行再次调用 `cg.searchNodes(query, { limit: 10 })`。长裸符号第三轮的实际计时如下，父子阶段不能重复相加：

| 顺序 | 阶段 | 耗时 |
| --- | --- | ---: |
| 1 | 索引精确查找 | < 1 ms |
| 2 | 大小写纠正，总计 | 992 ms |
| 2a | 其中：FTS | 1 ms |
| 2b | 其中：LIKE | 468 ms |
| 2c | 其中：编辑距离候选扫描 | 522 ms，包含读取全部名字 469 ms |
| 3 | 再次模糊搜索，总计 | 945 ms |
| 3a | 其中：FTS | 1 ms |
| 3b | 其中：LIKE | 469 ms |
| 3c | 其中：编辑距离候选扫描 | 475 ms，包含读取全部名字 418 ms |
| 4 | 当前磁盘源码证据扫描 | 932 ms |
| | MCP 请求总计 | 2,870 ms |

这里 `limit=10` 或 `limit=100` 限制的是结果数量，没有限制未命中时检查的节点/名字数量。

限定名不会进入第二次裸名模糊兜底，但它仍先对叶子名执行上述大小写纠正链，再尝试限定名恢复和源码证据。因此该场景约 1.94 秒。

## 具体开销来源

1. **LIKE 全表扫描。** `src/db/queries.ts:1633` 的 `searchNodesLike` 包含 `name LIKE '%...%' OR qualified_name LIKE '%...%'`。在这份真实数据库运行 `EXPLAIN QUERY PLAN`，结果为 `SCAN nodes`。不存在的符号无法提前找到命中，必须检查整个候选范围。
2. **两次读取全部不同符号名。** `searchNodesFuzzy`（1476 行）遍历 `getAllNodeNames()` 的返回值，做有界编辑距离比较。`getAllNodeNames`（2408 行）每次执行 `SELECT DISTINCT name FROM nodes` 并物化 639,529 个字符串。实际只缓存了 prepared statement，没有缓存名字数组；上游注释称名字集合已缓存，与实现不符。
3. **额外全范围源码证据。** `src/mcp/tools.ts:6929` 及 `src/mcp/raw-source-evidence.ts` 在标识符具有下划线、数字、内部大写等特征时尝试当前源码搜索。本次正常使用 bundled ripgrep，每次完整检查 23,340 个源码文件，共 554,531,856 字节（约 529 MiB），约 0.9–1.0 秒。

原始证据扫描有默认 8 秒预算（`raw-source-evidence.ts:15`），该预算只覆盖源码证据阶段，没有覆盖前面的两轮同步数据库搜索。MCP 启动还有默认 5 秒的 catch-up 等待预算（`tools.ts:79`）；本实验已隔离该因素，不能用它解释本次 2.87 秒，但客户端刚启动时可能有另外的等待。

## 建议修复顺序

1. 大小写纠正改走专门的大小写无关精确查询，同时保持限定名语义。在当前索引上 `WHERE lower(name) = ?` 的查询计划为 `SEARCH nodes USING INDEX idx_nodes_lower_name (<expr>=?)`，无需为了纠正大小写扫描整个模糊链。
2. 消除重复模糊搜索，并明确 MCP 的“严格精确”与“模糊/源码兜底”模式。现有 MCP `search` schema 没有与 CLI 默认行为对应的显式 `exact` 开关。
3. 如果仍保留编辑距离候选扫描，应考虑按索引变更正确失效的名字缓存、候选长度过滤和整体查询预算。当前实现缓存 statement 不会避免每次传出 64 万个名字。
4. 单独决定源码证据的自动执行策略或显式开关，保留扫描未完成时的 `INCONCLUSIVE` 语义，避免把减少扫描时间变成错误的“不存在”断言。

本次仅做复现与定位，没有修改产品搜索行为。

## 复现和产物

```powershell
npm run build
node scripts/repro-search-miss.cjs --project 'D:\c_proj\mame' --database 'D:\python_code\codegraph\bench-logs\mame-init-20260909\fork-macro-context\codegraph.db' --rounds 3
node scripts/repro-search-miss.cjs --project 'D:\c_proj\mame' --database 'D:\python_code\codegraph\bench-logs\mame-init-20260909\fork-macro-context\codegraph.db' --query debugload --rounds 3 --out 'bench-logs/search-miss-20260911/control'
```

- 脚本：`scripts/repro-search-miss.cjs`。Node 原生 SQLite 的只读模式防止实验改写原索引；没有启动索引或同步。
- 完整参数、SQL 查询计划、每轮耗时、MCP 原始返回和阶段轨迹：`bench-logs/search-miss-20260911/results.json`。
- 无兜底命中对照：`bench-logs/search-miss-20260911/control/results.json`。
- `npm run build`、`node --check scripts/repro-search-miss.cjs` 通过；完成 36 次主对照和 9 次补充对照，全部成功。
- MAME 工作树无已跟踪文件变更，原实验数据库大小及修改时间保持不变（2026-09-10 01:17:11）。原有 sync 复现脚本与文档没有改动。
