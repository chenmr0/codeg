# Explore 子图补边：保序的查询计划优化

## 范围与原因

基于远端 `3d24e8beb47c280e3f34116cc647aacc6d18f720`。
仅修改迁入社区 Explore 的 `QueryBuilder.findEdgesBetweenNodes`，不修改符号/边提取、解析、排序权重、数据库 schema 或 C/C++ 增强数据。

OceanBase 全仓诊断发现：所选 145 个原生节点，source 候选只有 800 条，target 候选却有 568,419 条。SQLite 选择 target 索引，先读取大量宽边行再检查 source。直接强制 source 索引虽然快，但改变返回顺序；Explore 会保留每个 source/target/kind 的第一条边，因此仅比较边集合不足以证明兼容。

## 实现

- 检查原 `EXPLAIN QUERY PLAN`，仅处理确定的 target-kind 查询路径。
- 用 `index_list` / `index_xinfo` 检查两个既有索引：非 partial、升序 BINARY、恰好 `(source,kind,rowid)` / `(target,kind,rowid)`。
- 原计划、索引布局、方向、collation 不认识，或者打开 `reverse_unordered_selects`，直接执行旧 SQL。
- 两个只读 covering probes 避免反过来误选出度 hub：source 探针最多 4,097 条，仅 source≤4,096，且 target≥max(128,4×source) 时切换。target 探针最多 16,384 条；这不是全表 COUNT。
- 从 source 索引读出完整交集，再显式 `ORDER BY target COLLATE BINARY, kind COLLATE BINARY, rowid` 恢复旧 target-index 的完整顺序。
- 继续使用 JSON 数组传 node IDs，不按节点数增加绑定变量。不限制最终行数，不截断，不去重，不新增持久索引或缓存。
- 每次检查，不跨 schema/statistics/PRAGMA 变化缓存决策。支持项目原生/社区标准 edges 表；不承诺支持用户自定义、遮蔽隐式 rowid 的边表。

## 验证

构建 `npm run build` 通过。最终串行相关回归 5 文件 54/54 通过，其中新增 native/WASM 子图差分 26/26（520 组输入组合）。

```sh
node --liftoff-only node_modules/vitest/vitest.mjs run __tests__/explore-subgraph-edge-plan.test.ts __tests__/explore-upstream-20261102-db.test.ts __tests__/explore-upstream-20261102-graph.test.ts __tests__/upstream-native-integration.test.ts __tests__/explore-query-cache.test.ts --maxWorkers=1 --minWorkers=1
```
新回归覆盖 native SQLite 与真实 sql.js WASM：完整行数组、QueryBuilder 返回数组均与原 SQL **逐项同序**比较；包含重复 ID/kinds、同一符号关系不同调用点、metadata、NUL、Unicode、4 万 IDs（正常索引布局）、无索引、DESC、NOCASE、额外索引列、partial、WITHOUT ROWID、ANALYZE、source hub、反向扫描、探测失败和运行期间索引移除。

不对所有任意自定义布局跑 4 万 IDs 的旧 SQL：例如 `(target,kind,source)` 会令 SQLite 产生巨量 IN 组合探测；该不支持布局验证安全回退，不属于本次优化范围。

## OceanBase 串行对照

完整源码仍是 `5e8a63d29dae9fde5e962b8fcc7b167d438fc343`，沿用已冻结数据库，没有重建/同步。冻结原生 runtime，不混入另一项 named-anchor 改进；after 仅替换这一个方法。真实生产 `ToolHandler.execute('explore', ...)`，默认连接参数，14 查询 × 3 passes，先 before 再 after，无并发性能任务。首轮不是 OS cache 冷启动；只有两轮 warm 样本，不构成统计置信区间。

| 总耗时 | before | after |
| --- | ---: | ---: |
| 14 条，进程首轮 | 51.549 s | 48.217 s |
| 14 条，warm 1 | 35.901 s | 31.643 s |
| 14 条，warm 2 | 35.341 s | 33.818 s |
| 历史 12 条，warm 1 | 30.301 s | 26.948 s |
| 历史 12 条，warm 2 | 29.805 s | 27.801 s |

**42/42 对应输出 SHA256 完全一致，零错误。** 单条耗时有波动，也有变慢的查询，不能宣称所有查询都更快。

### 同一 SQL 的完整保序差分

计时包含每次元数据/EQP/probe/排序开销；交替串行执行原查询和新查询，未隐藏检查开销。

| 图 | 返回行数 | 旧查询 warm | 新查询 warm | 完整行序 SHA |
| --- | ---: | ---: | ---: | --- |
| 我方原生图 | 191 | 465.7 / 466.4 ms | 4.53 / 3.78 ms | 全同 |
| 社区图 | 531 | 155.2 / 152.7 ms | 5.65 / 4.20 ms | 全同 |

这证明修复的是查询计划问题，不需要删掉增强数据。底层错误绑定（例如测试局部变量 K 聚集宏调用）仍须单独解决；本次不掩盖或改写边。

### 不触发切换时的开销

小内存图串行 200 次均值：普通微小查询 0.017→0.107 ms；source hub 场景 0.019→0.325 ms；均未切换，结果同序。新增检查并非免费，但开销有界，避免把 target hub 的错误计划机械替换为 source hub 的错误计划。阈值只用于可选加速，任何未满足条件均保持原 SQL。

## 证据与复现

- `before.json` / `after.json`：每次查询时间、错误状态、长度和 SHA。
- `sql-results.json`：原生/社区完整有序行 SHA、原/新 EQP、微查询开销。
- `benchmark.cjs`：传入已有实验根目录、before/after、输出路径；使用冻结 runtime，不改真实库。
- `sql-benchmark.cjs`：传入已有实验根目录、输出路径；使用 `full/query-plans.json` 的固定输入。

```sh
node --liftoff-only --max-old-space-size=6144 artifacts/explore-edge-plan-20261102/benchmark.cjs EXPERIMENT_ROOT before before.json
node --liftoff-only --max-old-space-size=6144 artifacts/explore-edge-plan-20261102/benchmark.cjs EXPERIMENT_ROOT after after.json
node --liftoff-only artifacts/explore-edge-plan-20261102/sql-benchmark.cjs EXPERIMENT_ROOT sql-results.json
```
