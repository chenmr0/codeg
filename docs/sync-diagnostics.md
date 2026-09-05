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

- `mode=git|walk|scoped` 是实际执行的路径。
- `fallbackReason=codegraph-negation` 表示根 `.codegraphignore` 的否定规则触发遍历；`parent-gitignored` 表示项目被父 Git 仓库忽略；`git-path-error` 表示 Git 枚举路径失败，结合 `failureStage` 判断发生在 rev-parse、文件收集、规则构建还是路径过滤阶段。不会把所有失败武断标为“非 Git 仓库”。
- `gitCommandMs` 和 `gitCommands` 统计实际 Git 命令，含嵌套仓库以及失败尝试，不含 stdout 后处理。
- `ignoreBuildMs` 统计根和嵌套忽略配置的检查、读取和构建。
- `filterCanonicalMs` 统计 **Git 路径**的忽略过滤、路径规范化与去重。
- `walkMs` 是整个目录遍历，**已经包含遍历内部的忽略配置构建和规范化**，不能与这些子项重复求和。
- `gitCandidates` 是 Git 收集去重后的候选数；`sourceFiles` 是扫描返回的源码候选数。Git 仍可能返回磁盘上已删除的 tracked 路径，后续核对会处理它。
- `scope=scoped` 表示只核对指定 watcher 路径，`scope=full-fallback` 表示指定路径不安全/无效而沿用原逻辑进行全量核对；普通 CLI 为 `scope=full`。

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

引用解析现在会缓存源码分行和名称分词结果，以降低大量失败引用重试时的重复计算。缓存按 resolver 隔离，分行结果对应实际源码内容，并随解析缓存清空；分别限制条目数和估算内存。它不会减少重试数量、改变候选评分或改变数据库格式，无须重建索引。

如需在同一部署上做对照，可用 `CODEGRAPH_NO_RESOLVE_TEXT_CACHE=1 codegraph sync -v` 禁用这两项缓存。开关在创建 resolver 时读取，常驻服务需重启生效。对照应使用相同变更和相同数据库起点；连续执行两次 sync 时，第二次通常已无变更，不能直接比较。空同步不执行这些计算，预期不会因此明显提速。

确认当前构建已部署，在已建立索引、没有内容变化的项目中连续执行三次 `time codegraph sync -v`。保存上述四行、原有 `phases` / `command phases`，以及 `codegraph status --json` 的文件数量和索引状态即可。有变更时一并保存 `context-files`，比较准备阶段耗时与总耗时。

日志以毫秒四舍五入输出，小于半毫秒的操作可能显示 0；判断是否执行过还应结合计数。新汇总行不包含源码或文件路径。
