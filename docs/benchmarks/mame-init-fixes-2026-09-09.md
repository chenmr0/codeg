# MAME init 性能修复与验收

本次实施基于 `a1d3ade80f8b566bf260967e3f2ff65250740c0f`，对应先前的 `mame-init-performance-2026-09-09.md` 分析。实验输入仍为 `D:\c_proj\mame`，社区对照仍为 `D:\c_proj\codegraph-ori`。未修改 MAME 源码、其原有索引或社区项目。

## 已实施的修改

| 修改 | 实现与边界 |
| --- | --- |
| fresh-index 节点去重 | `src/extraction/store-writer.ts` 在发送单文件 bundle 前按 ID 去重，保留最后一个**有效**节点的字段以及最后出现顺序。避免 SQLite REPLACE 对重复 ID 触发删除和外键扫描；保留既有更新路径、边和引用数据。 |
| C/C++ 限定符缓存 | `src/extraction/languages/c-cpp.ts` 使用以 AST 对象为键的 WeakMap，借助 `namedChildren` 一次收集直接限定符。复用原有指针、数组、引用和 constexpr 判定；不以可能跨树复用的数字 ID 为键。 |
| 合成阶段语言过滤 | `src/resolution/callback-synthesizer.ts` 的闭包集合匹配只扫描 Swift/Kotlin 节点；JSX 匹配过滤父节点语言，并保留 Vue/Svelte 模板支持。Java/Litho 的 setState/render 路径仍然运行。 |
| 共享全局宏名查询 | `src/extraction/tree-sitter.ts` 使用只读成员查询，同时访问文件局部集合和项目共享集合。四处误解析判断调用点均已切换，不再逐文件复制约 8 万个宏名。 |
| 完整操作计时 | `src/index.ts` 返回的 `durationMs` 覆盖完整 `indexAll` 调用，包含引用解析、合成、维护、WAL 恢复和锁释放。原来返回的只是 extraction orchestrator 时间。 |

本次未改变解析文件大小上限、C++ 宏恢复策略或 worker 数量。未实施的后续项包括解析滑动窗口、引用解析/写库流水化、WAL 阶段迁移、按字节预算的 resolver 缓存，以及其他合成路径的行切片缓存。

## 自动化验证

- `npm run build` 和 `git diff --check` 通过。
- 新增 5 项回归：最后有效节点与顺序/外键数据保留；512 个 declarator 的一次扫描与跨树隔离；全局宏集合不遍历复制且不泄漏局部定义；混合语言闭包/JSX 正负例；计时覆盖维护与锁释放。
- 使用 Vitest 子进程显式 `execArgv: ['--liftoff-only']` 完成全量测试：145 个测试文件，136 通过、7 失败、2 跳过；2,386 项通过、53 项失败、13 项跳过。
- 从 `git archive HEAD` 创建隔离的修改前源码快照，复跑上述 7 个失败文件，复现相同的 52 项失败。它们属于已有安装器目标列表/查询输出约定、Windows 临时目录清理和 MCP 工具环境配置问题。
- 另 1 项安装器 sibling-config 测试只在并行复跑时失败；修复版单独运行安装器文件后恢复通过，剩余 32 项安装器失败与原版一致。
- 初次全量运行只给 Vitest 主进程设置了 `--liftoff-only`，有两个测试子进程报 `Fatal process out of memory: Zone`。将参数显式传入测试子进程后，两项进程异常消失。没有为绕开它而修改产品编译/运行选项。

新增回归文件及扩展测试：`__tests__/synthesis-language-gates.test.ts`、`c-cpp-declarator-const.test.ts`、`index-performance-primitives.test.ts`、`index-completeness-diagnostics.test.ts`、`extraction.test.ts`。完整 extraction 文件的 483 项测试通过；既有闭包、Fabric、C/C++ recovery、增量 sync 和数据库测试均已纳入全量验证。

## MAME 源码提取等价性

从旧基准中复用 96 个跨目录 C/C++ 样本，另加 `nl_rebound.cpp`、`discrete.h`、`g65816.h`，共 99 个文件。使用相同的真实 MAME 宏上下文，分别运行旧版构建与修复版构建，比较 nodes（仅排除 updatedAt）、edges、unresolvedReferences、errors 的 SHA-256，**99/99 一致**。

| 项目 | 修改前 | 修复版 |
| --- | ---: | ---: |
| 99 文件合计提取时间 | 22.833 秒 | 3.483 秒 |
| `nl_rebound.cpp` | 18.777 秒 | 0.355 秒 |
| `nl_breakout.cpp` | 旧全库基准连续超时 | 0.971 秒，1,026 节点 |
| `nl_tank.cpp` | 旧全库基准连续超时 | 1.305 秒，1,251 节点 |

该样本特意包含已知热点，合计收益不能外推为所有 MAME 文件的均匀提速。两个旧版超时文件没有完整旧结果，单文件测试只证明修复版能够完成；全库覆盖和图差异另外验收。

## 完整 MAME 基准

完整基准已结束。采用与旧版相同的输入、Node 24.11.1、`--liftoff-only`、8 个解析 worker、6 个引用 worker 和库调用入口；数据库与锁重定向到工作区下的新目录，不覆盖旧基准。新构建仅加入观测 hooks，未启用实验用 `BENCH_DEDUP` 或 `BENCH_MACRO_OVERLAY`。

**总耗时从 3,236.243 秒（53 分 56 秒）降到 1,362.136 秒（22 分 42 秒），减少 57.9%，约 2.38 倍加速。** 这是各版本的一次完整运行，不能将小幅差异当成统计显著的回归或收益。

| 指标 | 社区默认版 | 我们修改前 | 我们修复版 |
| --- | ---: | ---: | ---: |
| 完整墙钟 | 353.557 秒 | 3,236.243 秒 | 1,362.136 秒 |
| 扫描文件 | 23,059 | 23,380 | 23,380 |
| 成功提取文件 | 23,006 | 23,378 | 23,380 |
| 超大小限制跳过 / 处理失败 | 53 / 0 | 0 / 2 | 0 / 0 |
| 节点 | 573,595 | 1,612,247 | 1,614,524 |
| 边 | 2,002,675 | 8,610,578 | 8,613,227 |
| 最终未解析引用 | 1,283,640 | 1,054,303 | 1,054,431 |
| 采样 RSS 峰值 | 5.58 GiB | 11.58 GiB | 12.54 GiB |

修复版 `complete=true`，`filesErrored=0`。API 的 `durationMs=1362102.915`，与外部计时仅相差约 33 ms 的 grammar/数据库初始化成本，已不再将提取阶段误报为总耗时。

修复版默认总耗时仍约为社区的 3.85 倍，但两者并非相同覆盖/工作量：社区跳过 53 个大文件，我们还额外扫描 `.ipp`、`.inl` 等路径，并保留 C++ 宏恢复与更多引用。不能用节点/边的数量直接证明准确率，也不能将默认总时间比当成等量工作效率比。该次运行未体现内存改善，RSS 采样峰值更高；缓存与内存预算仍属待优化内容。

阶段拆分：

| 阶段 | 原版 | 修复版 |
| --- | ---: | ---: |
| 提取与写库 | 2,196.299 秒 | 594.177 秒 |
| 提取后二级索引与 FTS | 47.530 秒 | 47.087 秒 |
| 引用解析，含引用阶段索引切换 | 615.285 秒 | 614.717 秒 |
| 关系合成 | 373.030 秒 | 99.653 秒 |

剩余差额为初始化、维护及其他收尾成本。**引用解析基本没有提速，现在与提取阶段各占总耗时约 45%。** 后续优先处理有界解析调度、引用批次计算/持久化重叠和缓存预算，而不是继续增加 worker 数。

提取与写库内部指标：

| 指标 | 原版 | 修复版 |
| --- | ---: | ---: |
| 提取阶段墙钟（含写库排队、重试） | 2,196.299 秒 | 594.177 秒 |
| 主批次解析墙钟 | 676.210 秒 | 571.546 秒 |
| 写库提交/背压墙钟 | 1,383.050 秒 | 7.231 秒 |
| 写库线程累计事务耗时 | 1,515.519 秒 | 48.417 秒 |
| 节点插入累计耗时 | 1,476.730 秒 | 11.502 秒 |
| 最长单文件写事务 | 368.312 秒 | 0.476 秒 |
| 到达写库线程的重复 ID 数 | 2,186 | 0 |

这些计时相互重叠，不应横向相加。提取阶段共处理 23,380 文件；原版的两个超时文件均已完成，初始引用量从 7,851,253 增至 7,851,814，差值恰为两个恢复文件的 289 + 272 条引用。

两次完整基准中 native 宏扫描都因实验沙箱的子进程权限回退到 TypeScript 扫描，修复版宏扫描用时 6.24 秒，和原版约 6.2 秒一致。该回退不是产品修复内容，也没有被当作这轮收益来源。

合成内部的主要收益：闭包集合 pass 从 214.344 秒降至 3.720 秒，JSX pass 从 68.949 秒降至 2.019 秒；其余合成路径仍约 94 秒。

## 全库图数据验收

对两个完整数据库做只读对比，节点排除 `updated_at`、文件排除 `indexed_at`，其余业务字段逐行核对。边按 source/target/kind/line/column 匹配，额外比较 metadata/provenance；未解析引用排除自增 ID 后按所有业务列比较多重集，保留重复行数量语义。

- 原有 **1,612,247 个节点全部保留，业务字段零变化**。新增 2,277 个节点恰为 `nl_breakout.cpp` 的 1,026 个与 `nl_tank.cpp` 的 1,251 个。
- 原有 23,378 个文件记录全部保留，业务字段零变化；仅新增两个恢复文件。
- 新增 3,115 条边、移除 466 条，净增 2,649 条。新增中 2,707 条由两个恢复文件发出；既有文件中 402 条同名引用改指向恢复文件内的新符号，另有 1 条原先失败的引用成功解析。
- 59 条被移除的 `jsx-render` 边来自 C++/Lua 文本误识别（C++ 1 条、Lua 58 条）。例如 C++ 的 `std::forward<Filter>` 被误连到第三方 JavaScript 的 `Filter` 类，Lua 生成的 `<Platform>` XML 被误连到 C++ 测试类；这些不是有效的 JSX 调用。
- 1,351 条既有引用边仅 confidence 从 0.9 变为 0.7：恢复文件增加了同名候选，命中原目标但不再是唯一候选。对应 `src/resolution/name-matcher.ts` 的 exact-match 置信度规则。本轮未更改名称匹配算法，不能将这些启发式目标变化统称为准确率提升。
- 另外有 5 条头文件引用改指、1 条头文件引用置信度变化，属于下面复现的已有 Windows 大小写缓存问题。
- 未解析引用多重集仅增加两个恢复文件的 129 条记录，移除 `nl_280zzzap.cpp:997` 的 `BOOM` 引用（已有对应解析边）；其余所有业务字段及重复次数一致。
- `pending` 引用为 0；`PRAGMA foreign_key_check` 返回空集；`PRAGMA quick_check` 返回 `ok`。

因此本轮**不是完整图逐字节等价**：既有节点/文件等价，覆盖扩大带来引用变化，语言过滤删除误判关系，另有已存在的路径缓存顺序敏感性。

### 验收中识别出的已有路径缓存问题

`src/utils.ts:259` 的 `canonicalFilePath` 在 Windows 将缓存 key 转为小写；当 bare include 不在项目根下、realpath 失败时，缓存 value 却仍为第一次请求的逻辑拼写。随后 `Bitmap.h` 和 `bitmap.h` 共用 key，`matchByFilePath` 使用缓存中的拼写作大小写敏感的节点名/后缀查询。

对**同一份旧数据库**运行旧版与修复版代码，两个版本均可复现：

| 缓存首次查询 | 随后解析 `src/mame/shared/xbox_nv2a.cpp` 的 `bitmap.h` |
| --- | --- |
| `Bitmap.h` | `3rdparty/bimg/3rdparty/pvrtc/Bitmap.h` |
| `bitmap.h` | `src/lib/util/bitmap.h` |

这解释了完整基准中 4 条 bitmap 引用、1 条 options 引用，以及 GL/glext.h 置信度的顺序敏感变化。该模块本轮没有修改；批次/worker 分配变化会暴露已有问题。后续应让失败的 realpath 缓存保留“失败”状态，并使用本次请求的逻辑拼写，避免丢弃负缓存而增加大量 I/O。这项正确性修复与引用阶段优化应单独验收。

## 实验文件

本地实验目录：`D:\python_code\codegraph\bench-logs\mame-init-20260909`（git 忽略）。旧 `fork/dist`、`community/dist` 和旧数据库均保留。

- `fixed/dist`：修复版构建快照。
- `prepare-fixed.cjs`、`run-fixed.cjs`：准备与运行修复版全库基准；输出到 `fork-fixed/`。
- `validate-fixed-extraction.cjs` / `.json`：99 文件业务结果指纹及两个超时文件的提取结果。
- `validate-fixed-graph.cjs` / `.json`、`validate-fixed-refs.cjs` / `.json`：全库业务字段、边差异、引用多重集和 SQLite 完整性检查。
- `inspect-fixed-edge-delta.cjs`、`fixed-edge-delta.json`：关系改指、confidence 变化与 JSX 误判样本。
- `probe-header-case.cjs` / `.json`：在同一旧数据库、旧/新构建中复现 Windows 路径缓存的大小写顺序问题。
- `tests-fixed-liftoff.log`：完整测试结果；`vitest-fixed.config.mts` 为本地子进程编译选项配置。
- `tests-baseline-failures.log`、`tests-installer-isolated.log`：原版失败复现与并发失败复核。

可复现命令（新 label 必须没有数据库）：

```powershell
node --liftoff-only bench-logs/mame-init-20260909/run-fixed.cjs fork fork-fixed-next
node --liftoff-only bench-logs/mame-init-20260909/validate-fixed-extraction.cjs
node --liftoff-only node_modules/vitest/vitest.mjs run --config bench-logs/mame-init-20260909/vitest-fixed.config.mts --maxWorkers=4 --minWorkers=1
```
