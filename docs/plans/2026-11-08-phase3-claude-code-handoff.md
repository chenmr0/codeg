# OceanBase 第三阶段续测 · Claude Code 交接

**异机执行从[远端数据还原与启动说明](./2026-11-08-phase3-remote-start.md)开始。** 通过下载、分片、数据库和源码检查后，再按本文四步执行。

2026-11-08。请从产品提交 `7e37003d` 开始，先诊断剩余慢批次，根据结果决定是否修一处通用性能问题。通过下面的建库条件后，用新目录建立候选索引，最后回答两个问题：哪些历史错绑得到了纠正，这些关系变化是否改善了 Explore 返回的关键源码和查询耗时。

**原始第三阶段文档**在本仓库 `docs/plans/2026-11-04-explore-graph-quality-and-cost-audit.md` 第 289 行起，标题为「第三阶段：真实 OceanBase 双新库验证」。首次冻结提交为 `f2c69c56bdc141fe75a25a7a7b0f032762b002b2`。后续请把执行状态、所用提交、报告路径及停机原因追加到同一计划的新执行分支。 [原始计划永久链接](https://github.com/chenmr0/codeg/blob/f2c69c56bdc141fe75a25a7a7b0f032762b002b2/docs/plans/2026-11-04-explore-graph-quality-and-cost-audit.md#L289) · [含后续诊断和修复的计划](./2026-11-04-explore-graph-quality-and-cost-audit.md)

## 版本、工作目录和数据

| 用途 | 分支 / 提交 | 使用方法 |
| --- | --- | --- |
| 交接与数据清单 | `codex/phase3-claude-handoff-20261108` | 本分支提供交接文档、下载与校验工具。产品运行时按下两行的 SHA 取值 |
| 当前产品 | `codex/explore-include-directory-20261106` · `7e37003d5e1829d69251c706c4e23d85e6d62962` | 含目录优化 `ed190ed8` 和合法成员绑定修复，提取版本 42。若需修改产品，从此 SHA 新建独立工作树和分支，单独提交性能补丁 |
| 内部参照 | `codex/explore-bounded-prefetch-20261105` · `c6b509d3557b7485a9fee14dbfc5980258205beb` | 已完成全仓索引，提取版本 40。用于吞吐和完整图对照 |
| 旧停机候选 | `751e3293ef0a7aba90d2d5e10185ad4661982d4f` | 提取版本 41，引用解析上报到 35,000 条时中止。保留现场，以它的一致副本重放冻结输入 |

以下 PowerShell 路径描述原实验机，供核对历史回执。异机请按远端启动说明将 `$A`、`$S`、源码、实验图及两个运行时映射到实际还原目录，在新的实验目录写入本机的合同和回执。

```powershell
$Repo = 'D:\python_code\codegraph'
$A = Join-Path $Repo 'artifacts\explore-real-binding-20261106'
$S = Join-Path $Repo 'artifacts\explore-include-directory-20261106'
$BaseRuntime = Join-Path $Repo 'artifacts\explore-bounded-prefetch-20261105\candidate'
$RefRuntime = Join-Path $S 'candidate'
$OriginalPlan = Join-Path $RefRuntime 'docs\plans\2026-11-04-explore-graph-quality-and-cost-audit.md'
git -C $BaseRuntime rev-parse HEAD
git -C $RefRuntime rev-parse HEAD
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $S 'replay\input.json')
Get-Content -LiteralPath (Join-Path $A 'build\logs\baseline-ready.json')
```

| 输入或工具 | 本机位置 |
| --- | --- |
| 上次停机、修复、验收 | `$A/REPORT.md`、`$S/REPORT.md`、`$S/reports/acceptance-summary.json` |
| 真实源码和建库配置 | `$A/build/baseline/oceanbase/`、`$A/build/prepared.json`。逐文件清单在 `$Repo/artifacts/explore-graph-quality-audit-20261104/freeze/source-manifest-historical.json` |
| 完整基线、停机原件 | `$A/build/baseline/oceanbase/.codegraph-wx/codegraph.db`、`$A/build/candidate/oceanbase/.codegraph-wx/codegraph.db{,-wal,-shm}`。停机原件仅文件级校验，身份见 `$A/build/logs/candidate-stopped-snapshot.json` |
| 解析重放图、输入 | `$S/replay/evidence/complete/codegraph.db`、`$S/replay/evidence/frontier/codegraph.db` 及后者的 `-wal`，`$S/replay/input.json` 和 `input-freeze.json` |
| 解析重放模板 | `$S/replay/correctness-v1/{worker.cjs,launch.py,protocol.json,final_equivalence.py,final_summary.py}`。ABBA 是 A、B、B、A 四个独立进程 |
| 最终结果和测试命令 | `$S/replay/correctness-v1/final-equivalence-01/` 的三个候选进程目录各含 `*-result.json`、`*-record.json`。371 项回归的完整命令见 `$S/logs/relative-regression-final-02-process.json` 的 `command` |
| 建库、关系、Explore | `$A/build/scripts/{prepare.py,index.cjs,run.py,verify.py}`、`$A/edges/{sites-01.json,audit-edges.py}`、`$A/query/protocol.json`、`$A/query/v2/{README.md,freeze.py,launch.py,run-query.cjs,summarize.py}`、`$A/coord/{release.py,join.py}` |

新脚本、输入冻结清单和结果都写到一个**新**阶段目录，例如 `$Repo/artifacts/explore-phase3-resume-<日期>-<序号>/`，下文记作 `$Run`。每次尝试用新子目录。旧驱动把工作树位置、版本、预期结果及部分 SHA 写在配置或代码中，因此复制模板后先绑定本轮输入、运行时及输出位置，生成新的冻结清单，再运行。旧证据目录继续作为只读来源。

## 第一步：量出慢批次中重复计算的成本

**起点。** 最终提交的原始记录在 `$S/replay/correctness-v1/final-equivalence-01/03-batches-candidate/batch2-record.json`。该批 500 条用时 **10.888 秒**。rowId 35775、35781、35758 的三个 `blocks_.reset()` 各用 2.314、2.288、2.266 秒，合计 6.868 秒，占该批墙钟 63.1%。三处都已正确绑定。整批 `getNodesByName` 调用 160,312 次，返回数组长度累计 179,616,786 项，含多次缓存命中。观察到 732 次 SQL 共约 45 毫秒，19 次物理源码读取共约 3 毫秒，计时组内完整文件清单 SQL 为零。具体哪段 JS 消耗 CPU 仍须测量。

1. 从 `replay/evidence` 复制图到 `$Run`，比对 main 与有效 WAL 的 SHA。原 `input.json` 内嵌 `snapshots.*.copy`、`datasets.*.project` 绝对路径，旧 worker 会直接使用。保留原文件字节，在新运行合同中映射本轮副本及源树，记录实际打开的主库、WAL 和源码 realpath 并核对 SHA。frontier 在副本中按 WAL 状态只读打开，由 SQLite 管理该副本的 SHM。读取停机队列应得到首个 pending 行 35,001。仅用裸 main 的 immutable 读取会得到错误起点。
2. 冻结原 `input.json` 的 SHA256 `bcea45f874593b484e55e933d7ed772ed81d2f57e0dd512bc2591d652ff4ef32`。六组为完整图上的 raw 128 条、panel 10 点，frontier 图上的前缀 128 条和原序 3×500 条（35,001–36,500）。前缀与第一批有重叠。再从该队列的早、中、后不同区段各取连续 500 条，尽量覆盖不同模块。先写下按队列顺序和源码路径选取窗口的规则，保存原始行、顺序、文件分布和 SHA，再查看耗时或解析结果。
3. 将模板两臂显式绑定为 `c6b509d3` 和 `7e37003d`。旧 `correctness-v1/launch.py` 的 baseline 是 `ed190ed8`，还校验它的 runtime manifest。给本轮两臂生成真实的 commit、src/dist/package 清单和 SHA。沿用生产入口 `ReferenceResolver.resolveListForAdmission`、单 worker、各组原顺序和组间缓存。统一 Node 参数 `--liftoff-only --max-old-space-size=2048`，保留 native SQLite 只读连接。核对实际 `query_only=1`、`cache_size=-32000`、`busy_timeout=5000`，记录 temp_store/mmap。初始化、warmCaches、组执行分别计时。先在同一机器串行做 ABBA 墙钟比较，两臂使用相同计时钩子；另开进程做重插桩和 CPU profile。保留先前重放的 setup 60 秒、每组 120 秒、每进程 450 秒上限，扩展输入可分进程组，明确各组预热方式。
4. 对三处调用和新增模块的慢调用分别记录候选数、各过滤步骤前后数量、接收者类型推断次数、成员集合/基类遍历次数及 CPU 热栈。优先检查 `src/resolution/name-matcher.ts` 的 `applyCppMemberScopeGate → isCppCallTargetAllowed → inferCppReceiverType / cppMethodsOnType`，并检查 `src/resolution/index.ts` 最终准入是否重复同一计算。按**原始引用**汇总，每层区分函数自身采样和含子调用时间。SQL 行、缓存 API 返回项和独立节点各用各的计数。
5. 交付逐次耗时、refs/s、同臂波动、CPU/RSS、最慢引用和完整有序解析结果。新增区段避开 35,001–36,500，完整保存原引用字段。先确认同臂重复的结果稳定，且今天运行的 `7e37003d` 六组结果与 `final-equivalence-01` 对应结果逐字段全等，再作决策。该检查同样适用于直接放行建库。对照 `c6b509d3` 和 `7e37003d` 时单列真实语义差异。

## 第二步：根据真实成本决定修复或放行

| 实测情况 | Claude 应采取的动作 |
| --- | --- |
| 同一引用的接收者／可用方法集被反复计算，CPU 热栈和逐引用次数相符，且另一模块或独立构造的同名成员用例也能复现 | 实施一处通用修复。优先尝试在单个引用、同一解析上下文内懒算接收者与目标 ID 集合。每候选的 arity、重载、遮蔽、可见性、继承、最终准入和失败路径继续生效。给具体反例补测试 |
| 开销集中在原有少数位点，新增普通模块完成重放且没有同级别的普遍退化 | 记录慢点分布和机器预算，放行一次受监控的完整候选建库，采用 `7e37003d` |
| 普通模块也反复超时或明显变慢，但证据指向别的函数，或只看到大量缓存返回项 | 保留各组最后进度，只聚焦一处主导成本补采样。得到可复现原因后才写补丁。资源或数据不支持判定时，在计划中登记缺口并停在本步 |

**纯性能补丁的验收基准是 `7e37003d`。** 原六组与最终 `*-result.json` 比较，新增窗口与本轮预先保存的 `7e37003d` 结果比较。要求完整有序 admission 全等，含原引用、resolved/unresolved、目标、方法、置信度、方法统计和 deferredChain。核查原继承位点及额外 13 个有源码依据的位置，具体见 `$S/inheritance/EXTRA-BINDING-REVIEW.md`。用独立命名的成员重载或继承用例验证通用性。构建成功，原 17 文件 371 项及新增回归通过；复用旧测试命令时把输出和临时目录指向新阶段。建议以受影响批次两次配对均改善、改善幅度超过同臂重复的极差、其余普通组没有可重复的退化作为性能放行条件。计时波动难以判断时只复测相关组。任一有序输出改变，先保留差异并撤出该补丁的性能验收。原基线已复现的 9 项旧 namespace 测试兼容/清理故障单列。

## 第三步：复用完成的基线，建立完整候选库

**启动条件。** 两臂运行时和源码已冻结，重放与数据保全检查通过，第一、二步已明确选用 `7e37003d` 或已独立验收并提交的性能补丁。启动前记录选定 SHA、实际配置、可用磁盘及建库时限。下列时间阈值是本次交接建议的机器预算，可在首次运行前按可用时段另行记录。

- 以 `$A/build/logs/baseline-ready.json` 为基线来源。已关闭的 v40 主库 SHA256 是 `9ffd162817bb6d4f8615b79889b08381caea06a433dc578565d21bc7348fb5d0`，14,316 个已索引文件、890,557 个节点、5,677,724 条边，全库 indexAll 852.01 秒。在 `$Run/build/baseline/oceanbase` 准备完整基线项目副本，包含同清单源码、独立 Git 根、已关闭的主库和独立、空闲的 portable 协调目录。复用回执记明原回执、源/副本 SHA 和实际时间。v2 runner 在 open 前会解析 `.codegraph-wx/.runtime/portable/{gate,readers,writer}.sqlite`。先以受控方式核验 gate idle、reader pin 可释放。
- 按冻结清单复制 16,317 个源码文件、694,894,451 字节到新的 `$Run/build/candidate/oceanbase`，建立独立 Git 根。清单 SHA256 为 `aef26edd9382b48aa524e24d111752701baa400099eac1da24232364562c6ac9`。两臂均使用这份历史快照。候选从空索引运行 `CodeGraph.init(..., {index:false})` 和 `indexAll`。对齐 `build/prepared.json` 的完整环境，parse/resolve workers 为 2/2，Node 参数为 `--liftoff-only --max-old-space-size=8192`。记录实际后端与配置。
- 在新目录适配 `build/scripts/prepare.py` 的 HEADS/运行时清单、`verify.py` 的 v40/v42 断言，以及 `coord/release.py` 的回执来源。只调度新 candidate，旧 `run-pair.py` 会启动两次建库。把原 `index.cjs` 的 15 秒输出节流改为在实验驱动中记录进入各阶段、真实 completed、单调时钟和资源心跳。尽量每跨 5,000 条记录一次，若一次产品回调跨多个窗口，只记录实际区间与耗时。
- **建议停机条件。** 自 `indexAll` 起 45 分钟为本次尝试总预算。引用解析阶段若满 10 分钟仍只完成 35,000 条或更少，或连续三个实测 5,000 条窗口各耗至少 45 秒，停止该次候选并保留现场。旧候选曾花 549.06 秒才上报 35,000 条。若达到硬资源限制、产品报错或输入身份变更，也停止。按本次进程句柄核实退出，记录阶段、最后完成数、时钟、错误、main/WAL/SHM 的大小和哈希。短批次的 refs/s 只用于找热点，全库时间以实跑为准。
- **建库完成条件。** indexAll 成功、complete、零文件错误，SDK 完成关闭，主库无有效 WAL/journal。只读核对 `index_completeness=complete`、候选 extraction version 42、每个已索引文件的内容哈希及文件计数与 stats 一致，保存两臂关闭回执、源码/运行时/主库 SHA。缺任一回执就保留日志，在补齐前停在本步。

## 第四步：核验 34 个绑定位置，再跑五题 Explore

1. 复用 `$A/edges/sites-01.json` 的 34 处位置和目标判据（17 个历史错绑、15 个正例、2 个存疑）。适配 `edges/audit-edges.py` 的两臂目录和回执。跨库用源码哈希、路径、行列、引用拼写/种类及目标源码锚点对齐。逐位置写明正确目标、禁止目标、已排除旧错绑但仍未解析、证据不足或源实体缺失。对 10 个 `OB_SUCCESS` 分开判断旧目标是否被排除、公共头目标是否有足够证据。同步查看 `K`、原正确宏、函数指针与合法继承成员。
2. 冻结沿用 `$A/query/protocol.json` 中五题的 query 字节、源码范围、required 与评分器。题目为 `ttl-task-methods`、`dtl-methods`、`ttl-qualified-member`、`pl-trusted-cert-add`、`backup-dest-connectivity`。每题 `maxFiles=12`，正文目标 24,000、硬上限 25,000 个 UTF-16 单元。只更新新合同中的运行时、提交、路径和关联哈希。保留原合同及其 SHA。
3. 使用 `query/v2` portable 运行器，更新 `launch.py`、`run-query.cjs` 和 `freeze.py` 中绑定旧提交、旧 runtime 清单及阶段目录的依赖，再生成新冻结清单。两臂先核实 SDK 只读打开内容库、portable reader pin/release 配对及实际 PRAGMA。在新驱动工作目录执行 `python -B -X utf8 launch.py acceptance-01 <新双臂回执的绝对路径>`。每题 4 个独立进程按 ABBA，每进程同一 handler 连续查两次，共 20 个进程、40 次调用。分别记录实例首次及同实例第二次。输入核验已预读文件，首次数据按实例首次解释。
4. 按题并列**目标实体、实际读入或入选的关系/节点、最终展示的函数主体行**。记录逐目标行集合与覆盖、required 完整数、正文大小/SHA、实际入边和出边读取、节点物化量、首次/后续耗时。对关键主体退化和新增错绑逐项给出证据。若要归因于某类边挤占候选，用同图、同 query、只改变该类边是否参与的一次诊断核实。遇到图身份、读连接、预算或评分输入不符，停止矩阵并保留已完成记录。测量有效但出现新增禁止绑定或丢失必须保留的正例时，保留完整对照并把该项标为阻塞产品放行。

**交付。** 在新阶段目录留下运行清单、全部尝试和失败日志、源码/数据库/运行时哈希、吞吐决策、34 点逐项表、五题逐函数表和结论；将报告路径与结论追加到推进计划。机器停止条件触发时，交付截至该步的结果及下一次定位入口。C 链接正向漏绑、展示签名遗漏返回值 `const` 各有独立证据，可单独登记。本轮回答内部 `c6b509d3` 与候选产品的工具级差异；社区对照、五篇 AR 原始 50 次调用和模型 token/轮次另立实验。
