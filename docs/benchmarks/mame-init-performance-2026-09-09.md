# MAME init 性能对比与优化分析

实验日期：2026-09-09。输入项目实际路径为 `D:\c_proj\mame`。

## 完整对照结果

本机单次完整测量：社区 **353.557 秒（5 分 54 秒）**，fork **3236.243 秒（53 分 56 秒）**，约 **9.15 倍**。只在实验副本加入单文件节点去重后，fork 降至 **1850.009 秒（30 分 50 秒）**，省去 **1386.234 秒（23 分 6 秒），下降 42.8%**，四张业务表语义指纹全部一致。

社区与 fork 的产出不同，不能把原始 9.15 倍全部算作等量工作的回退；fork 去重前后的比较才是相同业务数据上的单变量验证。

| 指标 | 社区 1.6.0 | fork 原版 | fork 仅去重 |
|---|---:|---:|---:|
| 完整时间 | 353.557 s | 3236.243 s | 1850.009 s |
| 扫描文件 | 23,059 | 23,380 | 23,380 |
| files 表记录 | 23,059 | 23,378 | 23,378 |
| 节点 | 573,595 | 1,612,247 | 1,612,247 |
| 边 | 2,002,675 | 8,610,578 | 8,610,578 |
| 首轮待解析引用 | 2,663,786 | 7,851,253 | 7,851,253 |
| 最终失败引用记录（pending 均为 0） | 1,283,640 | 1,054,303 | 1,054,303 |
| 文件错误 | 0（另有 53 个超限跳过） | 2 | 2 |
| 扫描/宏上下文/解析/写库/重试整体 | 157.877 s | 2196.299 s | 816.438 s |
| parse 二级索引 + FTS 重建 | 15.310 s | 47.530 s | 47.337 s |
| 引用解析至补全开始，含索引切换 | 75.397 s | 615.285 s | 609.533 s |
| 关系补全 | 102.881 s | 373.030 s | 371.024 s |
| 5 秒采样 RSS 峰值 | 5.58 GiB | 11.58 GiB | 11.49 GiB |

fork 的两个缺失文件是 `src/mame/atari/nl_breakout.cpp` 和 `src/mame/atari/nl_tank.cpp`，均为 30 秒硬超时，重试未恢复，`complete=false`。节点与边更多不自动代表准确率更高；本报告验证的是性能机制及特定优化的等价性，不是全图准确率评测。

fork 的主写库 worker 累计 1515.519 秒，其中 `insertNodes` 1476.730 秒，`insertEdgesUnchecked` 6.694 秒、`insertUnresolvedRefsBatch` 10.049 秒。仅 **2,186 个同 bundle 重复节点 ID** 就使节点写入成为首要热点。worker 累计时间与解析阶段有重叠，不能直接和整阶段时间相加。

### 去重实验的因果证据与等价性

| 指标 | fork 原版 | fork 仅去重 |
|---|---:|---:|
| 写库 worker 总时间 | 1515.519 s | 52.273 s |
| insertNodes | 1476.730 s | 12.740 s |
| insertEdgesUnchecked | 6.694 s | 6.787 s |
| insertUnresolvedRefsBatch | 10.049 s | 10.084 s |
| 最慢单文件写库事务（各自最大值） | 368.312 s | 0.473 s |
| 主线程 storeAdmission（含反压等待） | 1383.050 s | 7.170 s |
| 主线程 parseWall | 676.210 s | 672.085 s |
| 同 bundle 重复 ID | 2,186 | 2,186（写入前消除） |

解析时间、边/引用插入时间基本不变；节点写入下降约 99.1%，写库整体下降约 96.6%。这是去重解除写库反压的证据，不是减少解析工作或关闭功能产生的加速。

验证对完整的 nodes、edges、unresolved_refs、files 表计算 SHA-256，排除 `updated_at`、`indexed_at` 及 edges/refs 的自增 ID，保留节点 ID、位置、签名、类型、边元数据、引用状态及文件内容哈希等业务字段。按内部 rowid 顺序流式遍历但不哈希 rowid；四表指纹均相同，因此语义行及其相对顺序均一致，无需再做无序集合比较。`PRAGMA foreign_key_check` 两边均为 0 条违规。

| 表 | 行数 | 两边相同的 SHA-256 前 16 位 |
|---|---:|---|
| nodes | 1,612,247 | `d45f7d0b1a7a1fa0` |
| edges | 8,610,578 | `f16191ee30657aee` |
| unresolved_refs | 1,054,303 | `8143a194e04115a4` |
| files | 23,378 | `c483deb37d6731c5` |

完整哈希、阶段事件和统计见 [comparison.json](D:/python_code/codegraph/bench-logs/mame-init-20260909/comparison.json)。这种一致性是相对当前已产出图的等价，不代表两个超时文件已恢复；恢复它们的限定符缓存实验在下文单独说明。

## 实验范围与方法

- fork：`D:\python_code\codegraph`，`@sdd/codegraph-wx@1.0.7`，提交 `a1d3ade80f8b566bf260967e3f2ff65250740c0f`。
- 社区：`D:\c_proj\codegraph-ori`，`@colbymchenry/codegraph@1.6.0`，提交 `6a056ec5db35172f9dc348f87b54ea415aa5169e`。
- MAME：提交 `57cf29e2c75e24ac168d35a418cbd6d26113088e`。
- 两份 TypeScript 源码重新编译；实验运行编译副本，产品源码未修改。社区工作区原有 package-lock 和测试目录变动未修改。
- 同一 Node v24.11.1、`--liftoff-only`、原生 `node:sqlite`；Ryzen 9 7945HX，32 逻辑 CPU，31.69 GiB 内存；解析池均为 8 worker。
- 读取同一份 MAME 工作树，数据库与锁重定向到当前工作区 `bench-logs/mame-init-20260909`。没有修改 MAME 源文件、Git 配置或原索引。
- 使用与 CLI init 相同的数据库初始化、CodeGraph 构造及 `indexAll` 路径，直接调用库以分阶段计时。总时间包含初始化和完整索引；关闭连接另记录。省略 CLI 提示与目录初始化的微小开销。
- 全库运行串行；数据库都是全新创建，不删除复用。缓存未清空，单次测量不等于统计意义上的稳态基准。
- 若干小规模 SQL/单文件 CPU/宏查询诊断与主运行局部重叠，机器也未做核心独占或固定频率。结果适合定位量级差异，不能解读为亚秒精度的独立重复实验。完整 init 的三种主配置依次运行。
- 在编译副本的 store worker 增加按方法、按文件的计时；fork 另记录慢解析文件。计时包含少量记录开销。`parseWall`、各 worker 累计耗时、写库累计耗时不能相加当作总墙钟时间。
- 两份依赖实际版本相同：web-tree-sitter 0.25.10、tree-sitter-wasms 0.1.13、ignore 7.0.5。社区源码虽有 native kernel 路径，但本地没有对应二进制，本实验没有使用 native kernel。
- 两边 C++ grammar SHA-256 相同：`70f5e2b9976dad56bdcd1fafcb3af8c839c7a92e7beaa437162bcf45f390e83d`，不能将本次差异归因于 grammar 二进制版本。
- 沙箱阻止 Rust 宏扫描器子进程（`spawn EPERM`），fork 完整测量均回退 TypeScript 宏扫描；在沙箱外单文件复核扫描器成功。这是实验环境限制，不能当作产品功能故障，也不能把这约 6 秒的开销解释成整体慢的主因。

## 首要问题：重复节点与外键扫描相互放大

写入路径为 `src/extraction/store-writer.ts:finalizeStoreBundle` → `src/db/queries.ts:storeFileBundle` → `insertNodes`。

1. `finalizeStoreBundle` 校验节点字段，构造 ID Set 过滤边和引用，但没有对实际写入的 `nodes` 数组去重。
2. `insertNodes` 使用 `INSERT OR REPLACE`。相同 ID 第二次出现时，需要删除旧节点再写入。
3. schema 给 `edges.source`、`edges.target`、`unresolved_refs.from_node_id` 都配置了 `ON DELETE CASCADE`。
4. `beginBulkParseLoad` 为减少索引维护删除了 `idx_edges_target_kind` 和所有以 `from_node_id` 开头的 unresolved 索引。唯一边索引只能利用 source 前缀，不能替代 target 索引。
5. 此时替换同文件的重复节点，即使该节点尚未插入任何边/引用，SQLite 仍需确认并处理其子记录；没有子键索引就扫描此前已经写入的大量边和引用。

因此慢事务的关键变量是“重复 ID 次数 × 已入库图规模”，不是当前文件的节点数或字节数。后半程少量重复节点的头文件也会出现数十秒停顿。store 队列达到 64 后反压解析投喂，增加解析线程不能消除该瓶颈。

SQLite 官方说明：[REPLACE 会删除冲突的原行](https://www.sqlite.org/lang_conflict.html)；[缺少子键索引的外键检查会线性扫描子表](https://www.sqlite.org/foreignkeys.html#required_and_suggested_database_indexes)。

建议首先在 **fresh-index 的单文件 bundle 内** 按 ID 去重，保留最后一个有效节点的全部字段；按最后出现的位置排序，以保持最终节点的相对插入次序。不能简单保留第一个，也不能只按名字去重。此优化不依赖增大缓存、减少文件覆盖或关闭宏恢复。

独立机制复现取社区 `discrete.h` 的真实 399 个提取节点，其中只有 129 个唯一 ID、270 个重复。使用简化但相同外键拓扑的内存库，在节点、边、引用表各预填 100,000 条记录后：原 REPLACE 约 3016.620 ms，写前去重 0.415 ms，保留外键子键索引 1.726 ms，改用不删除旧行的 UPSERT 0.656 ms，最终节点均为 100,129。缺索引时，对应子记录查询的计划显示 `SCAN edges` / `SCAN unresolved_refs`，补索引后为 `SEARCH ... USING COVERING INDEX`。这验证扫描机制，不用于预测全库绝对时间。

更广泛的 `ON CONFLICT DO UPDATE` 改造需单独审计：它与 REPLACE 的级联删除语义不同，不能不区分 fresh init、sync、重建就全局替换。外键子键索引的保留策略也应与是否可能替换/删除节点一起设计。

## 其他源码差异与优化方向

### 第二个已复现热点：const/constexpr 检查重复扫描同一声明

单文件 CPU profile：`src/mame/atari/nl_rebound.cpp` 只有约 28 KB，却提取约 21.90 秒。主提取耗时约 21.65 秒；采样调用链集中于 `extractVariable → isCppDeclaratorConst → hasDirectTypeQualifier → namedChild → ts_node__child`，`isCppDeclaratorConst` 的 inclusive 样本约 21.33 秒。

`src/extraction/tree-sitter.ts:4660` 在每个 declarator 上调用 `isDeclaratorConst(node, child)`；`src/extraction/languages/c-cpp.ts:1605` 的 helper 每次又遍历声明的所有 named child，而且使用逐个 `namedChild(index)` 跨 WASM 读取。大量 declarator 共用同一声明/ERROR 容器时，形成重复扫描。外层其实已经读取过 `node.namedChildren`，web-tree-sitter 的这个 getter 有缓存，但当前 helper 没有利用它。

实验副本仅修改 helper：用 `WeakMap<SyntaxNode, Set<string>>` 缓存同一节点的直接 type qualifier，通过 `namedChildren` 一次取齐；指针、引用、数组的 const 判定算法保持原样。

| 文件/用例 | 原 helper | 缓存 helper | 结果 |
|---|---:|---:|---|
| `nl_rebound.cpp` | 19.550 s | 0.352 s | 636 nodes、211 refs，原始提取语义指纹相同 |
| const/pointer/array/reference/constexpr 混合用例 | 30.2 ms | 6.5 ms | 10 nodes，指纹相同；此小用例有预热影响，主要用于语义检查 |
| `nl_breakout.cpp` | 全库三次尝试均超时 | 0.905 s | 成功提取 1,026 nodes、289 refs、无错误 |
| `nl_tank.cpp` | 全库三次尝试均超时 | 1.254 s | 成功提取 1,251 nodes、272 refs、无错误 |
| `sqlite3.c` | 全库单次约 30.03 s | 31.47 s | 该文件仍慢，说明这项修复不覆盖所有解析长尾 |

前两个用例比较 nodes/edges/refs/errors 的 SHA-256，排除运行时间和节点更新时间。后两个原本失败的 netlist 只验证了修复后的成功提取，不能声称已与完整旧结果对等。缓存须以不可变 AST 节点/单次树生命周期为边界，避免按裸 node ID 跨树复用。

这比笼统增大 parse timeout 更值得优先处理：它既降低重复工作，也能消除已经观测到的缺失文件。当前全库 `fork-dedup` 控制实验没有启用该 helper 改动。

### 解析投喂：批次屏障与滑动窗口

fork 的 `src/extraction/index.ts` 每次读取 10 个文件，对整批调用 `Promise.all`，随后按序提交，再进入下一批。一个大文件会让本批其他已完成的 worker 空闲，也阻止后续小文件开始。

社区的对应模块使用 `feed`、`inFlight`、`completed`、`nextToStore` 和 `flushOrdered` 组成有界滑动窗口：worker 空闲即可获得下一文件，结果仍按发现顺序写库。

建议移植这一调度方式，同时保留本 fork 的宏上下文、重试、完整性诊断；窗口同时限制未提交文件数和字节数。单纯把批大小从 10 改成更大不能完全消除屏障，且会增加内存峰值。

### 文件覆盖差异：不能把跳过文件视为等价加速

社区全量索引有 `MAX_FILE_SIZE = 1 MiB` 并跳过超限文件。fork 全量路径只警告大文件，继续解析；还支持部分额外的 C++ 文件扩展名。

这对 MAME 影响实际存在：社区跳过 SQLite amalgamation、部分生成的 CPU 实现以及大型驱动文件。fork 对 `3rdparty/sqlite3/sqlite3.c` 一次解析约 30 秒，其中 primary extraction 约 23.5 秒，宏声明辅助解析约 0.13 秒。

逐文件核对：fork 多处理 321 个社区未收录的路径，其中 `.ipp` 125 个、`.inl` 188 个，以及 4 个 Android `res` XML 和 4 个 `scripts/target` Lua 脚本；反向差异仅是 fork 超时的两个 netlist 文件。共同文件中恰有 53 个超过 1 MiB，合计 180,872,458 字节，社区均记录 `size_exceeded` 且 node_count 为 0；fork 对这些文件记录的原始 node_count 合计 64,413。文件数量差异不能解释全部节点/引用差异，宏恢复和提取策略也改变了产出。

建议将纯数据生成文件的快速识别与真正的大型代码区分。可配置的体积限制可以作为显式速度/覆盖选项，但不能把默认跳过真实代码计入“相同结果”的性能收益。

### 宏集合：避免每文件复制全项目 Set

本次全库宏上下文包含约 82,485 个名字、76,605 个无歧义宏定义。`TreeSitterExtractor.collectMacroNames` 每解析一个文件，都把全项目名字逐个加入本文件 Set。此成本随“文件数 × 全项目宏数量”增长，且 worker 每 250 次解析会回收重建上下文。

这里的消费者仅需要 `has(name)`。可让查询同时检查小的本文件 Set 与 worker 级只读全局 Set，避免合并复制；保留本地宏和全局宏的并集语义。不要为提速直接关闭声明宏恢复或原始 AST 的恢复检查。

96 个真实文件的 ABBA 对照已完成：copy 两次为 4.222/3.591 秒，overlay 两次为 2.967/2.726 秒，均值约下降 27.1%；宏集合收集本身从 1003/825 毫秒降至 5.65/4.79 毫秒。四次 nodes/edges/refs/errors 指纹全部相同（6,098 nodes、6,252 edges、16,143 refs）。这是样本提取收益，尚不能等比例外推整个 init。

### 引用解析与写入仍有批次串行

fork 的 `ReferenceResolver.resolveAndPersistBatched` 等待本批 worker 解析完成，然后插边、清理引用，再发下一批。

社区已将下一批的 worker 解析与上一批的引用清理/持久化部分重叠。移植时要保留其边写入后的启动时点，核查 C++ 继承、接收者推断、deferred chain 等对前批已提交边的依赖，不能任意提前到旧快照。

还有一个必须一起迁移的条件：社区在 fresh init 进入大规模并行 resolution 前，把 `journal_mode=MEMORY` 恢复为 WAL，并启用受控 checkpoint；fork 目前直到整个 `indexAll` 的 finally 才恢复 WAL。直接添加读写流水线、却沿用 MEMORY journal，会引入读写锁竞争，不能只移植 `beginBatch` 几行代码。

### 关系补全与索引生命周期

fork 在普通引用解析后销毁 resolver pool，再顺序运行关系补全 pass。社区复用只读 worker 执行独立 pass，按注册次序合并。

建议先划分 pass 之间的数据依赖，再对独立 pass 并行。保留 fork 当前的 staging、内存预算和 incomplete 诊断；避免为了并行把所有 pass 的数百万条边同时放进主线程内存。

本次有更具体的优先点：fork 的 `closureCollEdges` 耗时 214.344 秒，`jsxEdges` 耗时 68.949 秒。项目只要含少量 Swift/Kotlin 文件，前者就遍历所有语言的 method/function；后者也会把 C/C++ 字符串里的 JSX 样式文本当作候选。社区已分别添加 `CC_LANGUAGES.has(m.language)` 和 `JS_FAMILY.includes(n.language)` 的节点级过滤。应移植这些精确条件及对应混合语言测试，不能只做“项目里存在某语言”的粗过滤。语言过滤可能去掉现有误连边，应作为兼顾精度的变化单独验证，不混进严格等价的去重实验。

另一个独立问题是本地 `sliceLines` 每次都 `content.split('\n').slice(...).join('\n')`。每个函数都切同一个大文件会重复切分整份源码；建议按文件/内容版本缓存行起始偏移，再用 substring，或至少共享有界行缓存。不要直接使用会拒绝超大条目的小缓存后，就假设大文件热点已经覆盖。

parse 后重建、resolution 前又删除的索引还有重复建设成本，但要先列出 resolver initialize/post-extract/各查询的索引需求。该项应在消除异常写库后再按实际阶段占比排期。

### 引用解析缓存按条目计数，仍可能占用大量内存

`src/resolution/index.ts` 默认给多个 LRU 各 5,000 个 key，其中 per-file node cache 的一个 value 是整文件的 `Node[]`，name/method owner cache 的 value 也可能很大；每个 resolver worker 都独立持有这些缓存。条目数量有界并不等于字节占用较小。

本次基线 resolution 的进程 RSS 采样超过 10 GiB。该观察与上述缓存结构提示：需要按节点数/估算字节加权的 LRU、限制巨大单项、避免相同节点对象在多种索引中反复物化，并用实测 worker 内存修正 pool 预算。这里尚未用 heap profile 量化各缓存的分摊，不应把全部 RSS 直接归因于某一个缓存。

## 旧 OceanBase 缓存报告应如何解释

`bench-logs/fork-1.0.7-init-writer-bottleneck-instrumentation-and-cache-experiment-2026-09-01.md` 的缓存增大收益是历史测量，不能直接迁移成 MAME 根因。

其 `writer-tx-repro-exp.mjs` 从最终数据库复制已落库节点，使用 `INSERT INTO ... SELECT` 生成新的 ID，并在索引齐全的成品库上重放。这已经失去了原始 bundle 的重复节点，也没有重现 bulk parse 窗口的索引状态。因此“成品库重放很快”不能排除本报告指出的确定性外键扫描成本。

缓存可缓解重复扫描的 I/O，但优先级应低于消除不必要的替换与扫描。

## 计时口径本身需要修复

两边 `CodeGraph.indexAll` 都沿用了 extraction orchestrator 的 `result.durationMs`；外层完成引用解析、关系补全、维护后没有把它更新为全程时间。CLI 又用这个字段输出总耗时。社区本次 `durationMs=157875`，完整外部计时却是 `353557 ms`。

建议 API 增加明确的阶段计时，并把 `durationMs` 定义为完整调用墙钟时间。阶段统计要区分串行墙钟、worker 累计执行时间、队列等待，避免把互相重叠的指标相加。性能回归基准同时保存覆盖完整性、节点/边数量与语义图指纹。

## 复现文件

实验文件均在 `D:\python_code\codegraph\bench-logs\mame-init-20260909`：

- `prepare.cjs`：准备两份编译副本与实验打点；社区先用 tsc 编译到 `community/dist`。
- `run.cjs`：完整索引阶段计时、内存采样、结果统计。
- `store-hook.cjs`：写库计时与仅实验用的 `BENCH_DEDUP=1`。
- `parse-hook.cjs`：慢文件解析计时。
- `probe-replace.cjs`：真实 MAME 头文件节点集合的小规模 SQLite 外键扫描复现。
- `probe-macro-lookup.cjs`：真实 MAME 文件样本上的宏集合查询方式对比。
- `profile-one.cjs`、`nl_rebound.cpp.cpuprofile`：单文件 CPU 采样与调用链。
- `probe-qualifiers.cjs`、`probe-qualifiers.json`：限定符缓存的单文件/语义对照。
- `compare.cjs`：覆盖范围、节点/边分类、语义数据 SHA-256 与外键检查。

例：`node --liftoff-only bench-logs/mame-init-20260909/run.cjs fork fork-default`。
每次使用新的 label；runner 拒绝覆盖已存在的数据库。

## 建议实施顺序与验收

1. **P0：fresh bundle 按 ID 最后一次有效定义去重。** 已有完整 MAME 等价性验证，单独减少 42.8% 全程时间。生产实现应覆盖不同字段的重复 ID、最后出现顺序、已有前序文件数据、边和引用保留；不扩大成全局替换所有 REPLACE。
2. **P0：缓存声明的直接限定符，复用 namedChildren。** 单文件已有约 55.6 倍加速和等价性证据，并让原先失败的两个文件完成提取。补充多 declarator、const 指针/数组/引用、ERROR 容器及跨树生命周期测试；再做完整索引验证。
3. **P1：迁移社区精确的闭包/JSX 节点语言过滤，避免重复切分整文件。** 当前两项 pass 合计约 283 秒；应同时测试混合语言场景，确认去掉的是误识别或无效扫描。通用跨语言桥接 pass 不宜统一按扩展名禁用。
4. **P1：全局宏集合只读复用，解析改为有界滑动窗口。** 宏成员查询已做 96 文件等价性试验；滑动窗口有社区源码参考，但尚未在本 fork 全库实现验证。保持文件提交顺序，按文件数和字节数共同控制积压。
5. **P2：引用解析与持久化重叠、WAL 阶段切换、按字节预算缓存。** 当前约 610 秒的引用阶段还要处理社区约 2.95 倍的原始引用，以及不同的成功解析分布。分别测量 SQL、匹配、清理和等待，不能把全部差异归因于未流水化。
6. **配套：修正全程 durationMs 和持久化阶段指标。** 持续保存输入规模、超时/缺失文件、节点/边/引用数量与图指纹。解析 worker 数、缓存容量和 native 移植均应在上述问题消除后再调参。

本分析阶段未修改生产源码。随后已实施核心修复，实施与验收结果见同目录 `mame-init-fixes-2026-09-09.md`。本报告保留当时的分析与实验状态：两份构建均通过 TypeScript 编译，主基准及机制/CPU/语义探针均完成；单变量全库去重已验证，其他优化在本分析阶段的验证范围按各小节列明。
