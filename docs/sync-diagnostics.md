# sync 文件核对诊断

已有索引可以直接使用，无须重新 init 或重建。执行 `codegraph sync -v`，会在文件核对结束后立即输出四行诊断：

```text
[sync] scan-detail ...
[sync] reconcile-detail ...
[sync] reconcile-io ...
[sync] reconcile-counts ...
```

这些信息仅在 verbose 模式启用，每次调用单独统计。不开启 verbose 时，不创建诊断对象、不执行新增的细粒度计时。诊断不改变扫描范围、忽略规则、时间戳/哈希判断、重试或数据库格式，也不为统计额外扫描、读取文件或执行 Git 命令。

## 如何看耗时

`reconcile-detail` 的五个阶段互不重叠：

| 字段 | 含义 |
|---|---|
| `enumerateMs` | 获取当前文件候选列表；scoped 模式包含路径验证及存在性检查 |
| `loadTrackedMs` | 从数据库读取文件记录，包含记录转换 |
| `buildLookupMs` | 构建当前文件集合和已索引文件映射 |
| `removalMs` | 删除检查；确有删除时也包含恢复入站引用和删除索引的操作 |
| `changeCheckMs` | 新增/修改检查的整个循环 |
| `totalMs` | 原有 reconcile 总耗时，另有少量进度通知等控制开销 |

`reconcile-io` 是 `changeCheckMs` 的子项，不能再加到父阶段之上：

- `statMs`：文件状态检查，包含失败尝试。
- `readForHashMs`：为变更核对读取源码，包含失败尝试。
- `hashMs`：计算内容哈希。

扫描内部信息位于 `scan-detail`，属于 `enumerateMs`：

- `mode=git|hybrid|walk|scoped` 是实际执行的路径。
- `fallbackReason=codegraph-negation` 表示根 `.codegraphignore` 的否定规则触发遍历（混合模式未开启或规则不受支持）；`parent-gitignored` 表示项目被父 Git 仓库忽略；`git-path-error` 表示 Git 枚举路径失败，结合 `failureStage` 判断阶段；`hybrid-unsafe` 表示混合模式遇到符号链接、子模块、嵌套仓库、冲突索引或非仓库根目录，保守回退。不会把所有失败武断标为“非 Git 仓库”。
- `gitCommandMs` 和 `gitCommands` 统计实际 Git 命令，含嵌套仓库以及失败尝试，不含 stdout 后处理。
- `ignoreBuildMs` 统计根和嵌套忽略配置的检查、读取和构建。
- `filterCanonicalMs` 统计 **Git 路径**的忽略过滤、路径规范化与去重；混合模式还包含候选父目录读取、嵌套忽略规则构建及文件顺序恢复。
- `walkMs` 是整个目录遍历，**已经包含遍历内部的忽略配置构建和规范化**，不能与这些子项重复求和。
- `gitCandidates` 是 Git 收集去重后的候选数；`sourceFiles` 是扫描返回的源码候选数。Git 仍可能返回磁盘上已删除的 tracked 路径，后续核对会处理它。
- `scope=scoped` 表示只核对指定 watcher 路径，`scope=full-fallback` 表示指定路径不安全/无效而沿用原逻辑进行全量核对；普通 CLI 为 `scope=full`。
- `gitDirectories` 是混合模式加载的候选父目录数，不是 Git 进程内部遍历的目录数；`supplementRoots` 是合并重叠后需要补扫的目录前缀数。
- `canonicalFromParent` 是向路径规范化提供已知父目录真实路径的普通文件次数，不是新增 I/O 次数。符号链接不使用这条捷径；部分扫描与候选合并可重复提供同一文件的提示。

## 空同步扫描优化

### 普通 Git 路径后处理诊断与原生 realpath 实验

对于 `mode=git`，进一步输出以下字段；walk、hybrid、Rust 目录扫描不使用这些实验字段，`gitPathMode=unused`。

- `gitIgnoreMs`：逐候选应用既有根忽略 matcher。
- `gitCanonicalMs`：规范化、缓存查找、真实路径解析和项目根内判断；`gitRealpathMs` 是其中的真实路径解析子项，不能重复相加。
- `gitDedupMs`：将规范化路径加入 Set，保持候选首次出现顺序。
- `gitIgnored/gitCanonicalCalls/gitCanonicalDuplicates`：忽略的候选数、规范化调用数、合并的重复路径数。
- `gitRealpathCalls/gitRealpathErrors`：缓存未命中等情况下实际调用完整路径解析器的次数、最终失败次数。后者仍沿用逻辑路径回退，不表示丢掉文件。
- `gitNativeCalls/gitNativeFallbacks/gitPathMismatches`：尝试原生解析的次数、原生异常后回退次数、verify 的精确路径差异数。

计时是已有操作的计时，不另跑扫描或预筛；仅 verbose 时逐候选打点。`filterCanonicalMs` 已包含上述子项以及循环和计时本身的少量开销。`reconcile-counts.statChecks` 不包含这里的内部路径解析调用，不能因为其很小就排除扫描阶段的文件系统成本。

`CODEGRAPH_GIT_REALPATH` 的自动策略：

- 未设置、空或 `auto`：仅 Linux 普通 Git 且候选不少于 50000 时选择 native；其他情况保留 legacy。
- `0`、`legacy`、`off` 或未知值：强制原来的 `fs.realpathSync`。
- `native` 或 `1`：仅普通 Git 后处理尝试 Node 自带 `fs.realpathSync.native`，异常则回退旧接口。这不是 Rust 扫描，不需要新的二进制或运行环境。
- `verify`：旧接口是权威结果；同时调用原生接口逐路径严格比较（含大小写），任何差异计数但始终返回旧值。验证耗时包含两个接口，不是加速测速。

保持 Git 收集 tracked/untracked、子模块和嵌套仓库的原流程；逻辑路径先匹配忽略规则，再按真实路径去重，最后按规范化路径筛源码扩展名。没有更改忽略配置，没有为 Git 候选臆造普通文件的父目录路径提示。缓存仍随 index/sync 清理，不缓存到下一次同步；不改数据库，无须重新 init。

**原生接口不保证所有平台更快，因此只对已实测的大型 Linux 路径自动开启。** Windows open5gs 的三轮只读扫描（11044 个源码候选）中，legacy 中位数约 0.774 秒、native 约 1.382 秒，原生方案反而更慢；路径和顺序哈希一致。小仓和非 Linux 默认不变。

建议在安装目录运行只读基准（不打开数据库、不解析业务源码、不运行 sync）：

```bash
node scripts/benchmark-git-paths.mjs /5g_build/5g_Main/WN_5G_BTS_L2L3_27B 3
```

脚本先 verify，然后交错进行各 3 次独立进程扫描；比较返回文件及顺序哈希，输出分阶段中位数和汇总。扫描以稳定工作树为前提，期间不要并行修改/生成文件。若实际不是普通 Git 路径则拒绝测速，不会修改 `.codegraphignore` 强行切换路由。`totalMs` 只含目录枚举，不是完整 sync；子进程启动、模块加载、数据库打开、核对、宏上下文及解析均不计入。

基准确认无差异且 native 更快后，可在项目目录进行整条命令对比：

```bash
time env CODEGRAPH_RUST_MACROS=1 CODEGRAPH_GIT_REALPATH=legacy codegraph sync -v
time env CODEGRAPH_RUST_MACROS=1 CODEGRAPH_GIT_REALPATH=native codegraph sync -v
```

空同步可以直接交错重复；有变更场景需相同源文件和索引基线，不能将第一次有变更和第二次无变更当成 A/B。如 Linux 主要成本不在 `gitRealpathMs` 或原生方案没有收益，再根据 `gitIgnoreMs` 等指标考虑候选批处理，不据此扩大 Rust walker 的选文件范围。

### Git 候选的受控 Rust 忽略过滤

普通 `mode=git` 路径提供批量过滤：Linux 且候选不少于 50000 时自动尝试，其他平台和小仓默认保持 legacy。Git 仍按原逻辑生成 tracked/untracked、子模块和嵌套仓库候选；Rust 仅接收这份有序 logical path 列表和构造 TypeScript matcher 时使用的同一组根规则，返回应保留的候选序号。TypeScript 随后继续执行真实路径解析、软链接身份去重和源码类型筛选。

```bash
# 强制旧 matcher（独立回退开关）
CODEGRAPH_RUST_GIT_IGNORE=0

# 使用 Rust；任何失败完整回退旧 matcher
CODEGRAPH_RUST_GIT_IGNORE=1

# 同时计算两边的每个 keep/drop 决策，始终采用 TypeScript 结果
CODEGRAPH_RUST_GIT_IGNORE=verify
```

`scan-detail` 中：

- `gitIgnoreMode=legacy|rust|verify|fallback` 是实际路径；fallback 时看 `gitIgnoreReason`。
- `gitIgnoreNativeMs` 包含进程启动、请求/响应 JSON 和 Rust 内核；`gitIgnoreKernelMs` 仅为帮助程序内部时间，是前者的子项。
- `gitIgnoreMismatches` 是 verify 中 keep/drop 不同的候选数；必须为 0 才能考虑启用。
- `gitIgnoreNativeKept` 是 Rust 直接保留数；`gitIgnoreDeferred` 是交回 TypeScript 单独判断的候选数。最终 `gitCanonicalCalls` 还会包含 deferred 中由 TypeScript 保留的项。

帮助程序将非 ASCII 或不规范的个别候选列为 deferred，仅这些路径由 TypeScript 判断；暂未证明等价的复杂或 Unicode **规则**、超出 25 万候选或 32MiB 请求、非项目真实根目录仍整批回退。缺少、过期或未完成目标平台验收的程序，以及超时、崩溃、响应截断、乱序/重复/越界序号也完整回退；不使用部分结果。Linux/Windows 预编译验收套件同时覆盖目录扫描和此操作，旧验收戳不能启用新版本。

目标机器安装候选包后先在安装目录运行平台差分验收，然后在稳定工作树运行只读基准：

```bash
npm run validate:rust-scan
node scripts/benchmark-git-ignore.mjs /5g_build/5g_Main/WN_5G_BTS_L2L3_27B 3
```

基准固定 `CODEGRAPH_GIT_REALPATH=native`，先执行 `verify`，再交错比较 legacy/Rust 各三次独立进程。它不打开 CodeGraph 数据库、不解析或修改源码；文件及顺序哈希必须相同，Rust 发生回退就拒绝生成成功汇总。若验证一致但 `gitIgnoreMs` 没有明显降低，应保持关闭，避免用进程开销交换没有意义的微小收益。

EulerOS x64 的 122123 个 Git 候选实测中，884 个特殊候选逐项 deferred，路径/顺序哈希与 TypeScript 三轮一致且零决策差异。枚举中位数从 6519ms 降至 2774ms（-57.4%），其中 ignore 从 4250ms 降至 556ms（-86.9%）；这是目标仓只读结果，不外推到小仓或其他平台，也不等同完整 sync。

默认启用的是**普通文件复用父目录真实路径**：目录刚刚完成 `realpath`，`readdir` 又确认条目不是链接时，文件路径可由真实父目录与条目名得到。符号链接仍走原来的完整解析、循环检测与去重；索引前的路径安全校验不变。没有增加跨次文件系统缓存，既有每次 index/sync 的缓存清理仍保留。该优化作用于共用扫描器，不改宏预处理、解析器或数据库格式。

Linux 对照命令（均可用于无变更项目）：

```bash
# 默认：普通文件路径复用；否定规则仍走完整遍历
time codegraph sync -v

# 关闭本轮路径优化，复现旧扫描成本
time env CODEGRAPH_NO_SCAN_PATH_REUSE=1 CODEGRAPH_NO_HYBRID_SCAN=1 codegraph sync -v

# 可选实验：Git 候选 + 白名单目录补扫
time env CODEGRAPH_HYBRID_SCAN=1 codegraph sync -v
```

混合模式目前只接受根锚定、无转义/通配符的 ASCII 目录否定规则，例如 `!/app/config/`。重叠前缀只补扫一次；规则大小写沿用原 matcher，补扫保留祖先/嵌套 `.gitignore` 的实际优先级。非锚定规则、裸文件规则、复杂模式或不确定仓库形态回退，`CODEGRAPH_NO_HYBRID_SCAN=1` 可强制关闭（优先于开启开关）。Git 仅提供候选，不以 `git status` 干净为依据：仍与数据库逐文件核对，能发现已经提交、pull/checkout 后的变化。

混合枚举不引入原完整遍历未使用的用户全局 Git excludes；源文件仍由原根 matcher、逐层 matcher 和实际目录条目确认，按 `readdir` 深度优先顺序返回。符号链接、嵌套仓库、子模块等回退到完整遍历，避免少枚举未跟踪内容或改变链接去重行为。混合模式尚不作为默认，建议先在目标 Linux 环境对照验证。

本机 OceanBase 三轮完整空同步中位数：旧扫描 **2.587 秒**，仅路径复用 **1.738 秒**，混合模式 **1.825 秒**。九次扫描的文件集合和顺序一致，隔离数据库中的文件记录/项目元数据及图数量不变。由于混合模式在 Windows 没有超过更简单的路径复用方案，默认选择后者。Linux 的收益需要实测，不按该比例外推。

## 关键计数

- `currentFiles` / `trackedFiles`：当前候选与本轮读取的数据库记录数。
- `existsChecks` / `statChecks`：核对代码直接执行的检查次数，不包含扫描器或路径辅助函数内部的系统调用。
- `statUnchanged`：大小和时间一致，直接跳过。
- `hashReadAttempts` / `hashReadFiles` / `hashReadErrors`：为哈希尝试读取、成功读取、读取失败的文件数。
- `statErrors`：状态检查失败数，仍沿用原来的异常处理。
- `sameHashSkipped`：已经读取和计算哈希，最终因内容相同而跳过重索引。
- `recoveryRetryFiles`：有声明宏恢复降级标记、即便内容没变也必须重试的文件；不计入 `sameHashSkipped`。
- `added` / `modified` / `removed`：核对阶段识别的变更数量，不代表后续一定成功入库。

空同步中 `hashReadFiles` 和 `sameHashSkipped` 很大，说明存在“文件状态变化，但内容相同”的重复核对成本。本次诊断补丁不会顺手更新这些时间戳或引入缓存。

原有 `[sync] phases read=...` 只统计待解析文件的读取，不包含这里的 `readForHashMs`，也不包含后续全项目宏扫描的文件读取。因此 `read=0` 不代表整个命令没有读取源码。

## 文件列表复用

有待重索引文件时，框架/宏准备结束后还会输出一行，例如：

```text
[sync] context-files source=reconcile files=31329 reuses=2 extraScans=0
```

- `source=reconcile`：使用本轮全量核对已获得的完整列表，包含无效 scoped 路径回退到全量核对的情况。
- `source=scoped-scan`：局部 watcher 核对没有完整列表，首次需要全局上下文时另扫一次，供框架检测与宏扫描共享。
- `source=unused`：局部同步的框架/宏上下文已有内存缓存，本轮不需要完整列表。
- `files`：完整列表的文件数，不是本次修改文件数；未获取列表时为 0。
- `reuses`：准备阶段直接复用已有完整列表的次数。冷启动 C/C++ 全量 sync 通常为 2；冷启动局部 sync 首次获取不算复用，第二个消费者复用时为 1。
- `extraScans`：准备阶段额外进行的完整枚举次数，不包含核对阶段的枚举。普通 CLI sync 应为 0；冷启动局部 sync 最多为 1。

这里只复用本次 sync 的文件列表，不缓存源码，也不新增跨次宏/框架缓存。宏收集仍覆盖全部可见 C/C++/ObjC 文件。局部核对不会因此扩大重索引范围。列表表示枚举时的快照，之后新增的文件留待下一次同步；同步原本也不是工作树的原子快照。

普通全量 sync 的 `framework` / `macroScan` 不再包含重复目录枚举；局部 sync 必要的一次补扫仍计入首次需要列表的阶段。空同步不会进入准备阶段，因此没有 `context-files` 行，也不会因这项优化明显提速。已有数据库无须重建。

## Linux 采样

### 中等批量同步：按需符号名查询与回退

新增文件的引用处理和历史失败引用重试现在共用同一轮 resolver 缓存，不再因为引用数超过 512 就强制读取全库符号名。查询仍是按名称索引执行的精确存在性判断，保留大小写、Unicode、限定名拆分和所有匹配规则；正/负缓存最多 4096 项。

保护预算按缓存生命周期累计，而不是每个 500 条重试批次重置：累计实际 SQL 探测达到 8192 次，或探测耗时达到 250ms 后，在下一条引用前改用完整符号名集合。缓存命中不计作新探测，引用匹配/进度回调耗时不占该预算；一个引用的处理不会被打断，因此预算不是进程硬超时。完整集合加载失败仍正常报错，不把错误当作“名称不存在”。缓存失效规则与此前一致。全量索引、公共解析 API、恢复的批量解析等其他调用仍默认完整预热。

日常直接 `codegraph sync -v`；`CODEGRAPH_SYNC_NAME_LOOKUP=0` 可恢复完整预热做对照，无需设置开启变量。不得将第一次有变更与随后无变更比较；应使用相同数据库起点和同一批代码变化。

日志新增/调整：

- `refs-detail scope=changed`：本次变更文件的引用处理。
- `refs-detail scope=failed-retry`：本轮实际执行的历史失败引用重试汇总，不逐批刷屏。`files` 是已知来源文件的去重计数，`refs` 是实际尝试行数；安全筛选跳过的行不在其中。
- `nameLookup=indexed knownNames=not-loaded`：没有加载完整符号名集合。
- `namePromotion=none|query-budget|time-budget`：本段是否达到保护预算而转向完整预热。若前段已预热，后段可直接复用 full 集合，不再重复加载。
- `symbolNamesLoadMs/symbolNamesSetMs`：包含本段发生的预算回退成本；该成本已从 `matchMs` 扣除，不能重复相加。`nameProbeMs` 仍是 `matchMs` 子项。
- 重试 `refs-detail.totalMs` 与 `failed-ref-retry.durationMs`、`tail-detail.failedRefRetryMs` 有包含关系，不应作为额外阶段累加。重试汇总的 `cache` 为首批状态，`nameLookup/knownNames/nameCacheEntries` 为末批状态；发生预算回退的单批 `nameCacheEntries` 可以保留回退前探测缓存的计数。

### 入库细分与完整同步时间

`store-detail` 仅在 verbose 且存在待索引文件时输出，不增加数据库查询、源码读取或事务，不修改入库/FTS 策略：

| 字段 | 所含现有工作 |
| --- | --- |
| `canonicalMs/hashMs/lookupMs` | 路径规范化、内容哈希、读取旧文件记录 |
| `retryStateMs` | 建立安全重试基线和写入恢复日志 |
| `snapshotMs/deleteMs` | 修改文件的旧入站边快照及旧图删除 |
| `nodesMs/edgesMs/refsMs` | 节点、文件内部边、待解析引用写入（含数据库内部索引/FTS/事务成本） |
| `rewireMs/fileMs` | 入站边重连、文件记录写入 |

`files` 为完成写入的文件数；`nodeRows/edgeRows/refRows` 为成功调用各写入方法时提交的有效行数，不是 SQLite 实际修改页数。全部细分均属于 `[sync] phases store=...`，后者还包括结果筛选、进度通知和循环等开销；收尾 WAL 折叠仍在 `tail-detail.prepareAndWalMs`，不应重复算进入库。

CLI 的 `nodes in ...` 现在使用整个 `cg.sync()` 调用耗时，包含引用处理和维护，对应 `command phases.syncPipeline`；不包含命令启动和数据库打开，完整进程仍以 shell 的 `real` 为准。本轮只修正 CLI 摘要口径，没有改动提取结果/API 的 `durationMs` 契约。

### 历史失败引用重试

有变更或中断遗留任务时，`sync -v` 还会输出：

```text
[sync] failed-ref-retry mode=safe-comments proofFiles=20 safeFiles=20 names=1068 scanned=8000 attempted=200 skipped=7800 durationMs=120ms
```

以上数字仅为字段示例，不是性能承诺。`scanned` 是实际遍历的失败引用行数，`attempted` 是提交给解析器的行数，`skipped` 是本次安全跳过的行数；三者满足 `scanned = attempted + skipped`。跳过的行仍保留为 failed，未来相关代码变化时可再次重试。`durationMs` 包含分批读取、解析和写回，不含名称查询与重试计划生成。热门名称仍遍历全部行，不设置 500 条总量上限；500 只是单批大小。

`proofFiles` 是本轮待处理记录覆盖的文件数，`safeFiles` 是其中满足安全基线的数量。后者小于前者时整组回退；即使相等，删除/异常/恢复或禁用开关也可能要求 `mode=full`。

第二阶段目前只优化保守的注释变化，不是通用的函数体/接口增量分析：

- `mode=safe-comments` 要求本次所有入库文件都有此前完整 sync 的匹配基线，均为 C/C++，且移除可证明安全的独占一行、单行块注释后源码和提取事实完全一致。仅接受简单英文/数字说明文字；行内、多行、声明形状、指令/注解形状的注释不会被忽略。普通空白分隔的宏续行只用于保持词法状态，原始宏文本仍参与比较；拆词续行、原始字符串或不确定输入回退。
- 只减少未变更 C/C++ 文件的历史 failed 重试。变更文件自己的引用、非 C/C++ 或缺少上下文的引用仍处理。文件解析、写入、入站边重连和增量关系合成照常运行。
- 新增、删除、函数体/签名/导入/宏改动、混合改动、解析异常，以及中断恢复均为 `mode=full`。其中任一主流程入库文件不满足安全条件，本轮整组名称都保留完整重试。需要重连回退的引用来源文件不被过滤；后续强制重索引仍只解析该文件自己的引用，不额外重复一轮历史重试。
- 原数据库直接可用，无需 init 或 `index -f`。没有基线的文件，第一次发生变更仍完整处理，成功后才建立基线；无变更时不会为了补基线遍历/读取所有源码。
- 替换图之前写入待重试记录，整个同步成功后才提交基线并清除记录。进程中断后，即使文件内容已经入库、下次没有文件变化，也会保守重试遗留名称。故障恢复可能让一次“无文件变更”的 sync 仍有解析尾部耗时。

Linux 可用 `CODEGRAPH_NO_SYNC_RETRY_FILTER=1 codegraph sync -v` 关闭筛选做对照；开关每次 sync 创建状态时读取，关闭后仍保留中断恢复。请使用相同数据库起点及相同变更比较，不能把修改后的第一次 sync 与随后无变更的第二次直接对比。新增文件、真实代码改动与空同步不预期获得此项筛选带来的明显加速。

### 分行/分词缓存与采样方式

引用解析现在会缓存源码分行和名称分词结果，以降低大量失败引用重试时的重复计算。缓存按 resolver 隔离，分行结果对应实际源码内容，并随解析缓存清空；分别限制条目数和估算内存。它不会减少重试数量、改变候选评分或改变数据库格式，无须重建索引。

如需在同一部署上做对照，可用 `CODEGRAPH_NO_RESOLVE_TEXT_CACHE=1 codegraph sync -v` 禁用这两项缓存。开关在创建 resolver 时读取，常驻服务需重启生效。对照应使用相同变更和相同数据库起点；连续执行两次 sync 时，第二次通常已无变更，不能直接比较。空同步不执行这些计算，预期不会因此明显提速。

确认当前构建已部署，在已建立索引、没有内容变化的项目中连续执行三次 `time codegraph sync -v`。保存上述四行、原有 `phases` / `command phases`，以及 `codegraph status --json` 的文件数量和索引状态即可。有变更时一并保存 `context-files`，比较准备阶段耗时与总耗时。

日志以毫秒四舍五入输出，小于半毫秒的操作可能显示 0；判断是否执行过还应结合计数。新汇总行不包含源码或文件路径。
