# MCP ripgrep 兜底超时：0/N 计数及返回结果定位

2026-09-11，源码 `c06ed32`，Windows / Node v24.11.1，使用当前 `dist` 和 bundled ripgrep。

用户补充：现场不在本机，数据库查询约 40 秒无匹配，然后进入 ripgrep 兜底，两个查询均返回 `INCONCLUSIVE: time budget reached; 0/99785 files scanned`。

后续已在默认 8 秒预算下，通过真实 MCP 并发请求复现：rg 自己报告 0.745 秒正常完成，共享 daemon 却因另一请求阻塞事件循环而返回超时及零计数。见 [MCP 并发查询复现记录](mcp-concurrent-search-timeout-2026-09-11.md)。下面保留最初的单次调用和缩短预算实验，不能把这些早期隔离实验与后续并发实验混为一组。

## 与现场日志直接相关的结论

**复现了同类超时输出，并确认 `0/N files scanned` 存在计数失真。** 这段日志能够证明源码证据阶段报告超时，但不能证明 ripgrep 完全没有开始搜索，也不能证明这两个符号不存在。

`INCONCLUSIVE` 和 `Absence is not proven` 本身是正确的保守结论。有问题的是进度显示，以及缺少区分超时阶段的诊断。原日志没有返回错误的“确认不存在”，也不足以判断现场是否丢了实际命中。

前面的 40 秒数据库查询不会直接耗尽源码兜底的预算：

1. `src/mcp/tools.ts:1828` 逐项完成 batch 的图谱查询，收集需要原文兜底的标识符。
2. `tools.ts:1838` 在这些查询全部结束后才调用一次 `renderRawEvidence`。
3. `src/mcp/raw-source-evidence.ts:510` 进入源码扫描函数后才新建 deadline。默认 8,000 ms（15 行），可由 `CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS` 配置或函数选项覆盖。
4. 这一个预算涵盖读取索引文件清单、构造候选范围、`rg --files` 枚举、`rg --json` 内容搜索以及可能的 Node 补扫。两条标识符合并为同一条搜索命令的两个 `--regexp`，共享一次超时状态。

因此，两个查询同时显示同样的超时和分母，是共享扫描的正常表现，不是一定执行了两次失败的 rg。默认配置下更接近“数据库约 40 秒，随后源码兜底另有约 8 秒预算”，不是“rg 用了前 40 秒剩下的时间”。同步准备工作和事件循环调度意味着预算也不应被理解为严格的进程总耗时上限。

## 真正的计数错误

`raw-source-evidence.ts` 中有两个独立的提前返回分支：

| 阶段 | 代码位置 | 超时处理 |
| --- | --- | --- |
| 文件枚举 `rg --files` | 423–435 行 | 返回 `totalScannedFiles: 0`、`totalScannedBytes: 0` |
| 内容搜索 `rg --json` | 447–465 行 | 解析已收到的命中，但仍返回上述两个固定零值 |

各个查询的 `state.scannedFiles` 初始为零；**只有全部 rg 搜索命令正常结束，478 行才给文件进度累计计数**。格式化阶段将这个未累计的值当成实际扫描进度打印。

此外，`recordRipgrepOutput` 在 381 行只处理 `type: "match"`，忽略 JSON 中已经出现的文件完成 `end` 事件。于是会出现“已返回源码命中、已收到文件完成事件，但界面仍显示 0 个文件”的矛盾。

若没有命中，当前参数下的 rg JSON 输出也不能直接给出每个无命中文件的完成进度。因此修复时不能把 `match` 数量当作已扫描文件数，也不能把已枚举文件数冒充已搜索文件数；没有可靠计数时应明确显示进度未知。

## 实测一：MAME 真实 rg 已完成一个文件，MCP 仍报零

复用 `D:\c_proj\mame` 和此前的完整只读 MAME 索引，代码查询接口和 rg 调用均为真实实现。观察钩子只记录子进程参数、原始 stdout 和时间，不改变命令或输出。

为了在本机稳定进入超时分支，这个故障复现实验将**源码扫描预算缩短到 500 ms**；并非声称 MAME 在默认 8 秒预算下超时。

以源码中实际存在的 `ROM_START` 直接测试原文证据扫描：

- 文件枚举约 162 ms，内容搜索约 252 ms，整个证据调用约 516 ms。
- 超时前实际收到 `begin`、`match`、`end` 各一个。
- 完成的索引文件为 `src/zexall/zexall.cpp`，第 157 行 `ROM_START(zexall)`。
- `end` 记录包含 `searches: 1`、`bytes_searched: 5049`，证明这个文件已经搜索完成。
- CodeGraph 返回 `matchingLines: 1`，但 `scannedFiles: 0`、`scannedBytes: 0`。

原始 MCP 格式化输出：

```text
Found 1 raw-source match for `ROM_START` (RAW_MATCHES; possible index/parser gap):
src/zexall/zexall.cpp:
  Line 157: ROM_START(zexall)
Scan incomplete: time budget reached; more matches may exist (0/23340 files scanned).
```

300 ms 的独立运行也出现同样的命中和零计数。在这些运行中，**已收到的 UTF-8 命中被保留了**；不能根据计数错误进一步宣称所有超时命中都被丢弃。

## 实测二：使用用户给出的两个标识符

查询：

```text
LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ
LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ
```

| 实验 | 结果 |
| --- | --- |
| MAME，默认 8 秒预算 | 约 1,009 ms 完整扫描 23,340 个源码文件，0 命中，返回 `CONFIRMED_ABSENT`，没有超时 |
| MAME，100 ms 预算 | 在枚举阶段超时，返回两个 `0/23340` |
| MAME，300 ms / 500 ms 预算 | 已进入内容搜索后超时，仍返回完全相同的两个 `0/23340` |
| 单文件 UTF-8 样例，实际 batch `search` | 两个标识符都只出现在注释中、图谱精确查询无结果；源码兜底分别返回一条正确命中 |
| 同一样例，0 ms 预算 | 在 rg 启动前耗尽预算，完整复现用户的 batch 输出结构，只是分母为 `1` |

由此确认：**枚举之前、枚举期间、搜索期间超时，当前输出都可能长得一样。** 本机没有现场的 99,785 文件项目，未复现其默认预算下的耗时，也没有把人为缩短预算的运行冒充同规模现场复现。

本机 MAME 没有用户的这两个标识符；其无命中不能用于推断现场源码是否存在它们。

## 实测三：按用户要求，以真实 MCP stdio 批量重复三轮

在用户再次要求测试 MAME 后，额外通过实际 `serve --mcp` 进程的 JSON-RPC `tools/call`，一次传入上述两个标识符，重复三轮。沿用 1,614,524 节点的完整 MAME 索引，未设置 `CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS`，即采用默认 8 秒；没有缩短超时，也没有替换搜索算法。只读重定向索引路径，并隔离启动同步和 watcher，以测量查询本身。

| 轮次 | MCP 请求总耗时 | 源码兜底耗时 | 兜底结果 |
| --- | ---: | ---: | --- |
| 1 | 4,535 ms | 991 ms | 23,340 文件完整扫描，两个标识符均 0 命中 |
| 2 | 4,341 ms | 978 ms | 同上 |
| 3 | 4,458 ms | 1,010 ms | 同上 |

每轮只执行一次批量源码兜底，`backend=ripgrep`、`cacheHit=false`、`timeBudgetReached=false`，每次涉及 554,531,856 字节。MCP 的原始返回均为两个 `CONFIRMED_ABSENT`，**没有在本机 MAME 默认配置下复现远端的 40 秒数据库查询加兜底超时**。

这轮真实 MCP 结果与上面的缩短预算故障复现是两组不同实验：正常默认预算成功，并不推翻已经通过真实 rg 完成事件证实的超时计数错误。

```powershell
node scripts/repro-search-miss.cjs --project 'D:\c_proj\mame' --database 'D:\python_code\codegraph\bench-logs\mame-init-20260909\fork-macro-context\codegraph.db' --batch --queries-file 'bench-logs/mame-license-batch-20260911/queries.json' --rounds 3 --out 'bench-logs/mame-license-batch-20260911'
```

输入和完整每轮原始返回、分段耗时保存在 `bench-logs/mame-license-batch-20260911/`。

## 同时发现的独立问题：非 UTF-8 命中被丢弃

这个问题与用户提供的超时日志**没有建立因果关系**，但同一结果解析器存在更严重的错误，已经通过真实 rg 和真实 batch handler 复现。

在已索引的 `markers.cpp` 注释中放入上述两个 ASCII 标识符。UTF-8 中文注释时，两条命中正常返回；仅将注释内容写成包含 GBK 中文字节的行，仍使用相同的 ASCII 标识符：

```text
// LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ <GBK 中文字节>
// LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ <GBK 中文字节>
```

文件很小，因此此实验显式设置 `CODEGRAPH_RAW_EVIDENCE_BACKEND=ripgrep`，确保测试的就是与大项目一致的 rg 路径。索引内容不影响原文读取：观察到的 rg 原始输出确实包含两个真实命中。

| 层次 | 实际结果 |
| --- | --- |
| rg 原始 stdout | 2 条 `match`，退出码 0，完整结束 |
| JSON 内容字段 | `data.lines.bytes`，Base64 编码；没有 `data.lines.text` |
| CodeGraph report | 两个 `matchingLines` 都变成 0 |
| 实际 batch `search` 返回 | 两个错误的 `CONFIRMED_ABSENT; do not rerun Grep` |
| 同一文件切换 Node 扫描后端 | 正确找到两个 ASCII 标识符，中文显示为替换字符 |

根因是 `raw-source-evidence.ts:383` 只读取 `message.data.lines.text`，385 行把没有字符串 `text` 的记录直接跳过，未处理合法的 `bytes` 分支。路径字段也只读取 `path.text`。随后代码仍将整次成功搜索计为完整，形成错误的不存在断言。

这个问题需要单独修复和回归验证；延长超时无法修复它。对已获得但不能解码或不能映射路径的真实 match，也不能直接丢弃后宣称完整无命中。

## 建议的修复与现场诊断

优先修复进度和诊断：

- 报告 `prepare` / `inventory` / `search` / `node-fallback` 超时阶段，记录配置预算及各阶段耗时。
- 将“已枚举文件数”“已完成内容搜索文件数”“进度未知”区分开。保留已完成批次/可靠完成事件的计数，没有精确数据就不显示假的 `0/N`。
- 保留已经收到的完整命中记录；评估流式 JSON 解析和输出刷新策略。当前子进程 stdout 接管道，超时会 kill 子进程，进程内部未刷出的内容不属于已确认收到的证据。
- 两个标识符共享的 `INCONCLUSIVE` 应继续保留，不能为改善体验而把超时当成不存在。

若继续定位远端为何超过预算，需要采集实际 `CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS`、两个 rg 子进程是否启动及各自耗时、完整命令和搜索范围、退出原因；现有这段文本没有足够信息区分这些阶段。数据库查询约 40 秒的问题仍是此前定位的图谱查询性能路径，应该和原文超时分开计时。

另需修复 `lines.bytes` / `path.bytes` 处理，并增加非 UTF-8 行命中和解码失败时禁止断言不存在的回归测试。

## 复现产物和验证

```powershell
npm run build
node --liftoff-only scripts/repro-raw-source-results.cjs
```

- 脚本：`scripts/repro-raw-source-results.cjs`。
- 本次完整结果：`bench-logs/raw-source-results-1789123577471/results.json`。
- MAME 命中后超时的真实 stdout：同目录 `rg-17.stdout`。
- GBK 命中的真实 stdout：同目录 `rg-4.stdout`，实际 batch 对照为 `rg-6.stdout`。
- 每次重跑创建新的时间戳目录；固定的小样例只写在本工作区，MAME 索引只读打开，未修改 MAME 源码。
- 完成 11 个实验；`node --check scripts/repro-raw-source-results.cjs` 通过。
- 本次仅新增复现脚本和定位记录，没有修改产品代码。
