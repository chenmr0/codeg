# 失败引用重试计划的索引选择

在 MAME 的真实 1,000 文件 sync 中，收集 51,430 个变更符号名后，历史失败引用重试的准备阶段分别出现约 55 秒和 264 秒耗时，实际重试阶段约 17–23 秒。原查询每 500 个名字执行一次：

```sql
SELECT name_tail, COUNT(*) AS count, MAX(id) AS max_id
FROM unresolved_refs
WHERE status = 'failed' AND name_tail IN (...)
GROUP BY name_tail;
```

只读 `EXPLAIN QUERY PLAN` 发现 SQLite 选择了 `idx_unresolved_status`，再对名称过滤并临时分组。该库约有 111 万条失败记录，这会令每个名称批次重复访问大量无关行。现有部分索引 `idx_unresolved_failed_tail` 按失败引用的名称索引，能够覆盖此查询。

## 修改

`getFailedReferenceRetryPlan` 在该索引存在时通过 `INDEXED BY idx_unresolved_failed_tail` 固定名称查询路径。每次调用检查一次系统目录，不缓存索引是否存在；全量构建的批量窗口可能暂时移除此索引，缺失时继续原查询，恢复后重新使用。

没有增加索引、修改 schema、提升提取版本、修改重试条件或放宽数量上限。分组的数量和最大行 ID、每名称上限、后续批次的读取范围均保留。索引提示仅改变访问路径，不把失败记录直接判为“不需要重试”。MAME 的这次旧流程实际恢复了 15 条引用，必须保留这项恢复能力。

## 验证

新增 4 项原生 SQLite / WASM 测试，覆盖误导性的统计信息、跨 500 名称分组、重复及空名字、pending 排除、每名称上限、高水位、索引暂时缺失及恢复。两种后端均核对实际查询计划和结果，不依赖耗时阈值断言。

当前提交相关回归合计 942 项通过、1 项因缺少原生宏扫描组件而条件跳过。其中 37 个文件的 459 项测试通过；提取测试进程意外退出后，显式向测试子进程传入 WASM 参数单独重跑，483 项全部通过。OceanBase 与 MAME 均使用完整索引、固定 1,000 文件改动和每轮独立初始库进行端到端对照，核对所有节点、边、文件及未解析引用的规范化哈希；原始结果见测试工作区 `artifacts/extraction-sibling-reuse/REPORT.md`。

按失败原因和实际解析依赖变化决定是否重试，仍是另一个待研究方向；本修复没有实现通用失败缓存。
