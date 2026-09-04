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

## Linux 采样

确认当前构建已部署，在已建立索引、没有内容变化的项目中连续执行三次 `time codegraph sync -v`。保存上述四行、原有 `phases` / `command phases`，以及 `codegraph status --json` 的文件数量和索引状态即可。

日志以毫秒四舍五入输出，小于半毫秒的操作可能显示 0；判断是否执行过还应结合计数。新汇总行不包含源码或文件路径。
