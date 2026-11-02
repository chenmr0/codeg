# Explore 两项改进整合验收

## 血缘与范围

独立分支 `feat/explore-evidence-improvements-20261102` 直接基于已推远端 `3d24e8beb47c280e3f34116cc647aacc6d18f720`，未覆盖其他工作树，未推送。

- `1361887`：cherry-pick `f6fb191`，明确命名 enum_member/field 的有界精确补召与中性缺失提示。
- `1047c9f`：cherry-pick `ebd24016`，子图补边的有界探针、索引布局校验及严格保序查询计划优化。
- 两项无冲突。产品修改仅 `src/upstream-explore/mcp/tools.ts`、`src/upstream-explore/db/queries.ts` 和新增 `src/upstream-explore/db/subgraph-edge-plan.ts`；不改提取器、图数据、schema、sync 或 CLI。

## 本轮串行验证

独立离线依赖安装、`npm run build`、`git diff --check` 通过。测试逐批串行、每批 `--maxWorkers=1 --minWorkers=1`；全图 smoke 未与测试并发。

- 原生重点 12 文件：140 项，137 通过、3 失败。涵盖真实 stdio MCP、生产 handler、取消/session、外部 sync/候选发布热缓存失效、TEMP 词表及真实 WASM、子图完整有序差分、named anchors、输入契约、输出预算。
- 原生补充 4 文件：48/48，C++ identity/signature、预算选择及原生适配。
- 社区迁移 unindexed-names：8/8。
- 合计 17 文件 196 项：193 通过、3 已存在失败。不是全量绿灯，不宣称 Windows/daemon 完整验收。

直接在 `3d24e8be` 独立 detached worktree 复跑有失败的两个文件：36 项，33 通过、相同 3 失败。分别是空白输入返回形状、`Only shown source ranges` 旧文案、`### Relationships`/`### Source Code` 旧标题预期；与先前已提交 native-final.log 一致。本轮不删除或改写这些断言。

## 完整 OceanBase 只读组合 smoke

复用 `5e8a63d29dae9fde5e962b8fcc7b167d438fc343` 源码及已有原生数据库；生产 readonly facade 验证主库 UPDATE 被拒绝。合并后的真实生产 handler 查询 `ObDtlBasicChannel ObDtlFlowControl ObPxTransmitOp DTL_BLOCKING_TIME`，返回成功且保留 DTL 指标定义。单次 16.613 秒仅为 smoke，不能当性能比较。

与 named 单独改进最终证据相比，唯一差异是首行跨工作树提示中的运行目录（`explore-named-anchors`→`explore-improvements`）。全部后续内容逐字一致；仅统一该路径后的 SHA256 是 `83a7bb24d7d2fe77df3d8670aef371c650a57d535efba591044c0e7ad8a64919`。原始 SHA 不相同，不能冒称原始 wire 完全一致。详细摘要在 `oceanbase-smoke.json`，完整响应保留外部 `/tmp/explore-integrated-dtl.json`，不提交第三方源码输出。

## 已知边界

- 单项 edge 的 42/42 SHA 对照与速度数据仍属于该项独立试验，不混称整合后全 14 查询试验。
- 任意自定义/遮蔽 rowid 的 edges schema 不在 edge 优化支持范围；标准布局、未知索引回退均有差分覆盖。
- raw QueryBuilder 若遭外部并发 DDL，在探测通过到执行 INDEXED BY 之间仍存在索引撤除的理论窗口；本次生产只读 read-pin 验收不等同任意裸连接并发 DDL 验收。
- 提取层 K 宏误绑定、嵌套宏字段缺失、完整冷启动成本及其余社区能力差距未在本次解决；保留增强 C/C++ 数据，不通过删图追平。
