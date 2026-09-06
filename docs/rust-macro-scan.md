# 全局宏上下文：细分计时与 Rust 原型

本轮针对 `macroScan`，不是 tree-sitter 解析器，也不替换已验收的 Rust 目录扫描器。

## 当前状态

- 2026-09-06，用户在 EulerOS 2.0 SP15 x64 / Node 22.21.1 上完成 HERT_BBU 真机验证：30743 个相关文件、530963452 字节，三轮宏上下文中位数 TS 7267.175ms → Rust 3210.591ms，减少 55.8%；逐文件 verify 通过，全部上下文哈希一致。807 个特殊文件走 TS 回退、读取错误为 0。这是该项目的宏上下文等价性和性能证据，不是所有 Linux 场景或完整数据库图的等价性证明。
- 同一新增两文件场景的用户日志显示完整命令由 13.176 秒降至 7.623 秒；该项是前后单次日志对比，不是三轮 A/B。新日志同时将收尾瓶颈定位到 `changedRefsMs=2010ms`，后续单独优化，不与宏扫描混为一项。
- 普通 `codegraph sync -v` 自动显示新的宏上下文细分计时；宏扫描仍默认使用 TS。
- 目录扫描器原来的自动启用规则保持不变，可以同时出现 `scan-detail mode=rust` 和 `macro-detail mode=ts`。
- 新 Rust 宏扫描器为独立的 `codegraph-macros` 程序，Windows / Linux x64 预编译候选产物与目录扫描器分开。新二进制不能沿用此前目录扫描器的验收结论。
- 没有持久化缓存、数据库结构变更、tree-sitter 语法更新或宏冲突规则修改；现有数据库可以继续使用，不需要重新 init。
- 原型保留 TS 宏收集的现有行为，包括三套扫描器并不完全一致的匹配细节，不在性能移植中夹带语义修复。

## 运行方式

```bash
# 默认 TS 宏扫描；Rust 目录扫描仍可自动启用
codegraph sync -v

# 显式启用新宏扫描原型
CODEGRAPH_RUST_MACROS=1 codegraph sync -v

# 逐文件双跑对比，使用 TS 结果；这是验证模式，不用于测速
CODEGRAPH_RUST_MACROS=verify codegraph sync -v
```

`CODEGRAPH_RUST_MACROS` 未设置、`0` 或 `auto` 都不会开启原型。只在需要构建 C/C++/ObjC 上下文时调用；空同步不启动宏扫描器。

`CODEGRAPH_RUST_MACROS_WORKERS=1..8` 可控制 I/O 工作线程，默认 4；非法值回到默认值。`CODEGRAPH_RUST_MACROS_TIMEOUT_MS=100..120000` 控制整次辅助进程的超时，默认 60000ms。可用 `CODEGRAPH_RUST_MACROS_PATH` 指定开发候选程序。验证模式的时限也包含等待 TS 对照的时间。

## 不改数据库的实际项目验收

在已安装的新候选包目录执行：

```bash
cd "$(npm root -g)/@sdd/codegraph-wx"
node scripts/benchmark-macro-context.mjs /usr1/518C10/HERT_BBU 3
```

脚本仅枚举并读取源码，不打开 CodeGraph 数据库，不运行 sync，不修改业务文件。三轮交替 TS/Rust 顺序，每个样本使用独立 Node 进程，避免同一进程的堆/GC/JIT 状态影响另一方案；计时不包含进程启动和目录枚举。要求最终宏集合、定义及顺序哈希相同；末尾再做逐文件对比。源码在测试期间应保持不变。脚本只输出数量、耗时和哈希，不输出源码或宏定义内容。缺少辅助程序、执行失败、结果不一致时以非零状态退出，不把 TS 回退当成 Rust 性能结果。

测速后，再用显式开启宏原型的 sync 验证真实新增文件场景。对图结果应比较符号名称、类型、位置、签名和边，不能只比较节点数量。上述 EulerOS 实测来自用户返回的真机输出；其他平台或重编译后的新程序仍需各自验收，交叉编译成功不等于运行通过。

## 计时口径

`macro-detail`：

- `files/readFiles/readErrors/bytes`：相关源文件数、成功/失败读取数、成功贡献的源文件字节数，不代表物理磁盘读流量。
- `readWallMs`：TS 批次读取的墙钟时间，包含路径检查和 UTF-8 解码；原生模式下只含回退文件的 TS 读取。
- `namesMs/bodylessMs/definitionsMs`：TS 三个扫描阶段；原生模式下只含回退文件，在 verify 模式下含全部 TS 对照。
- `mergeMs`：收集贡献及沿用原规则筛选无歧义宏定义。
- `nativeReadSumMs/nativeScanSumMs`：Rust 多个线程的文件读取、扫描时间之和，可能大于整体墙钟时间，不能相加推算总耗时。
- `nativeWallMs`：整个流式原生处理区间，包含 Node 解码、合并、TS 回退或验证，与其他字段可能重叠。
- `totalMs`：完整上下文构建墙钟时间，A/B 应比较这个值。
- `mode=rust/verify/fallback/ts`、`reason`、`fallbackFiles`：实际路径及回退情况。异常后丢弃整个未完成原生上下文，再从 TS 重建。

`tail-detail` 记录提取结束之后的连续墙钟区间：准备与 WAL、后处理、变更文件引用、恢复引用、失败引用重试、关联文件重索引、孤立引用与关系补全、链式调用、数据库维护、最终状态及清理。`failed-ref-retry planMs` 是查询规划耗时，原有 `durationMs` 仍表示执行循环时间。两者不再混淆。

### 变更文件引用处理的进一步诊断

后续版本增加 `[sync] refs-detail scope=changed`，进一步拆开 `changedRefsMs`。小批次名称查询优化只替换精确名称存在性的存储方式，不改变名称筛选和引用解析规则：

- `files/refs/resolved/unresolved/edges`：本次处理文件数（含恢复重试文件）、待解析引用数、解析成功/失败数、构造出的待写入边数；`edges` 不保证等于实际新增边数。
- `cache=cold|warm`、`knownFiles/knownNames`：是否准备缓存及集合大小。按需模式下 `knownNames=not-loaded` 表示没有枚举全局名称，不是数据库中没有符号。
- `nameLookup=full|indexed`：实际名称查询模式；`nameQueries/nameCacheHits/nameCacheEntries` 分别为本次实际索引查询数、正负缓存命中数、当前缓存条目数。`nameProbeMs` 是实际索引查询耗时，已经包含在 `matchMs` 内，不可重复相加。
- `loadRefsMs`：读取当前文件的 pending 引用，含查询与行对象转换。
- `fileNamesLoadMs/fileNamesSetMs`：加载全项目文件路径、构造 Set。
- `symbolNamesLoadMs/symbolNamesSetMs`：加载全项目不同符号名、构造 Set；Load 包含 SQL 和已有查询方法的数组映射，并非纯 SQLite 执行时间。
- `normalizeMs/matchMs`：引用字段归一化、逐条匹配。匹配阶段包含原有进度回调，不逐条打点。
- `edgeBuildMs/edgeInsertMs/resolvedCleanupMs/failedCleanupMs`：构造边、写边、清理已解析引用、将未解析引用标为失败。
- `complete/failedPhase/totalMs`：仅表示这个引用阶段是否完成、失败位置及总墙钟时间，不表示整个 sync 的最终状态。

诊断仅在 `sync -v` 的该引用阶段开启，诊断自身不额外查询数据库、不输出符号或源码；空同步没有这个阶段，不会输出 `refs-detail`。开启/关闭诊断不改变所选查询策略的查询序列、结果或进度。需要在真实新增/修改文件场景采样，单纯修改 mtime 而内容哈希不变可能不会触发解析。

### 小批次同步的精确名称索引查询

主变更文件引用阶段在引用数不超过 512 时默认采用按需查询，使用既有 `idx_nodes_name` 的 `WHERE name = ? COLLATE BINARY LIMIT 1` 判断存在性，不获取完整节点，也不构造全项目名称 Set。每个未查询名称都会执行真实查询，不能将一个“只加载部分名称的 Set”用于判不存在。

正、负结果共享最多 4096 条的 LRU，随解析器现有 `clearCaches()` 一起失效，不跨进程持久化。遇到查询异常仍抛出，不缓存为“不存在”。大小写、限定名拆分、Python 内置方法判断沿用原逻辑；无效 UTF-16 不得因 UTF-8 替代字符而误匹配另一个名称。

全量索引、普通解析 API、后续重试阶段、大于 512 条的批次仍默认完整预热。若同一缓存周期已有完整名称集合，直接复用；按需模式后进入全量调用会提升为完整集合。全局文件路径集合保持原实现，索引中存在但磁盘缺失的文件语义不变。

```bash
# 默认：小批次按需查询；Rust 宏开关保持独立
CODEGRAPH_RUST_MACROS=1 codegraph sync -v

# 对照/回退：恢复本次同步主引用阶段的完整名称预热
CODEGRAPH_RUST_MACROS=1 CODEGRAPH_SYNC_NAME_LOOKUP=0 codegraph sync -v
```

`CODEGRAPH_SYNC_NAME_LOOKUP` 未设置、空值、`auto`、`1` 或 `indexed` 都采用上述有界选择；`0`、`full` 或未知值保留完整预热。没有强制超大批次使用按需查询的开关。不新增数据库索引或迁移，不需要重新 init。

也可在 Node 22.5+ 上运行只读阶段基准（不运行 sync，不读业务源码、不改数据库）：

```bash
node scripts/benchmark-reference-name-lookup.mjs /usr1/518C10/HERT_BBU/.codegraph/codegraph.db 3
```

该脚本只对比“文件/名称缓存准备 + 3 次精确名称检查”，每轮独立进程，答案哈希必须一致；并非完整引用解析或完整 sync 的测速。请保持数据库不被其他索引进程修改。

## 正确性与资源边界

- 使用本轮相同的文件清单，保持文件和定义顺序；原来的 `selectUnambiguousCppMacroDefinitions` 在 TS 端执行。
- 无数据库写入、跨轮缓存或源码改写；每次重新读取全局上下文。删除文件、读取失败不会被记成永久的“空宏缓存”。
- 1 个进程、默认 4 个长期工作线程，有背压的有界通道；单文件 8 MiB、单文件宏记录数 100000、响应单行 32 MiB、请求 8 MiB / 250000 路径上限。超限文件走 TS，不截断后声称成功。
- 复杂跨行宏头、某些块注释尾部、特殊空白、无效 UTF-8 等走逐文件 TS 回退。普通中文注释、字符串及路径不因非 ASCII 内容一概退出。
- 缺失程序、超时、崩溃、输出截断、顺序错误、协议或记录错误，均丢弃未完成的原生上下文，完整回退 TS。
- 进程退出后的存活状态不作为缓存；verify 模式始终采用 TS 贡献，并要求逐文件记录一致。

## 开发者构建

```bash
npm run build
npm run build:rust-macros -- --target x86_64-pc-windows-msvc
npm run build:rust-macros -- --target x86_64-unknown-linux-musl
npm run test:rust-macros
```

构建者需要对应 Rust target；使用 musl 自包含链接、检查 Linux ELF 无动态解释器/共享库依赖，Windows 静态 CRT。业务机器使用随包程序，不需要 Rust/Cargo。安装脚本只校验产物并恢复 Linux 执行权限，不下载、编译或执行宏扫描器。

`CODEGRAPH_RUST_MACROS_EXPECT=1 npm run test:rust-macros` 要求实际二进制存在，不允许通过跳过原生测试宣称验收。测试同时覆盖相关 C 提取、sync 和旧 Rust 目录扫描回归。

社区参考：本地 `codegraph-ori` 的 `6a056ec`，特别是 `c-fnptr-synthesizer.ts` 的批量事实扫描与 `codegraph-kernel/src/cfnptr.rs` 的 JS/Rust 语义差分约束。本实现不复制整个原生解析内核；不能用社区的性能数字代替本项目实测。
