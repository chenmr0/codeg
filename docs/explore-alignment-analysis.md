# Explore 社区对齐：能力差异、数据归因与验收边界

日期：2026-11-02。本报告描述本轮源码比较与本地验证，不把历史报告当作本轮实测，也不宣称所有语言、所有入口或大仓性能已经完全对齐。

## 1. 比较基线

| 角色 | 仓库、分支与精确提交 |
| --- | --- |
| 本轮宿主基线 | `chenmr0/codeg`，`fix/config-change-incremental`，`dbeb21cea9aecd20154cf7f9dc0199e5a7622f9b` |
| 此前 Explore 候选 | `chenmr0/codeg`，`codex/explore-dominant-nul-20261029`，`e7dc7af4f362dbd7f20349839bd3be112c064983` |
| 候选移植的社区代码 | `colbymchenry/codegraph@6560052a6f856855d3f71eee838fd66ccfa4285d` |
| 本轮社区比较点 | `colbymchenry/codegraph@f72c9d2efb14454ff4f9fd7b8460abd82f19a287` |
| 本轮新分支 | `feat/explore-community-alignment-20261102`，从上述宿主基线切出 |

两个社区提交的 `package.json` 都标为 **1.6.2**，仅比较版本号会漏掉其中的功能更新。移植来源和保留补丁见 [`src/upstream-explore/MIGRATION.md`](../src/upstream-explore/MIGRATION.md)。

此前候选并非当前宿主基线的后代。本轮迁入 Explore 相关改动，而不是用候选整棵目录覆盖当前产品；宿主 portable sync、查询代际租约、数据库发布与 MCP 生命周期必须保留。

## 2. 结论：不是“提取问题”与“工具没迁完”二选一

1. **工具消费层确实落后于当前社区。** 旧候选已移植它当时对应的完整 Explore 流水线，但没有包含此后社区的 CJK、Flow 路线、限定名、大函数窗口等更新。宿主基线比该候选还早，不能以旧候选的测试结果代替基线状态。
2. **图数据差异也确实会改变输出。** 原生 C/C++ 声明与定义、签名类型证据等增强会增加合法候选和边，影响种子、路径、排名和源码预算。数量多不等于错误绑定，更不能为接近社区输出而直接删除。
3. **性能另有适配层成本，尚未完成大仓归因。** 原生 schema、SQL 查询计划、缓存失效检查、源码校验与生成文件识别均不同；当前不能把历史约四倍差距归结为单一原因，也不能据此宣称本轮已消除差距。

## 3. 能力对照与本轮迁移

| 能力 | 主要差异与本轮处理 | 可核对源码/测试 |
| --- | --- | --- |
| 自然语言 Explore 与完整检索流水线 | 基线的旧入口限制不能代表社区能力；接入候选的完整 handler，并继续迁移当前社区更新 | `src/mcp/tools.ts`、`src/upstream-explore/mcp/tools.ts` |
| 中文等 CJK 查询、限定名与 Go 包名 | 更新分词、完整限定名查找及 Go 包名回退，而非仅扩充提示词 | `search/query-utils.ts`、`graph/symbol-lookup.ts`、`graph/go-package.ts`（均位于 `src/upstream-explore/`）；`__tests__/upstream-v162/cjk-query-tokens.test.ts` |
| Flow 与类型层次 | 纳入非支配路线、路径前驱和双向类型层次遍历 | `src/upstream-explore/graph/named-symbol-flow.ts`、`traversal.ts`、`type-hierarchy.ts` |
| 明确命名的大函数 | 更新源码窗口、预算竞争与缺口说明，避免只显示声明或遗漏查询点名主体 | `src/upstream-explore/mcp/tools.ts`；`__tests__/upstream-v162/explore-queried-oversize-symbol.test.ts` |
| 合成/动态边与低价值文件 | 更新合成边端点的逐条、公平展示和测试路径降权；配置按请求读取一次 | `src/upstream-explore/graph/synthesized-hop.ts`；`explore-synth-link-endpoints.test.ts`、`explore-low-value-tests.test.ts`（位于 `__tests__/upstream-v162/`） |
| 未索引名字提示 | 补齐查询接口及展示逻辑，不将“没有源码节点”伪装成完整结果 | `src/mcp/upstream-explore-graph.ts`；`__tests__/upstream-v162/explore-unindexed-names.test.ts` |
| 长查询与 SQL 消费方式 | 引入查询上限、内存子串索引、FTS rowid 连接和过滤前置，同时保留宿主 schema 兼容 | `src/upstream-explore/db/queries.ts`、`name-substring-index.ts`；`__tests__/explore-upstream-20261102-db.test.ts` |
| C/C++ 增强、NUL 与源码安全 | 保留候选的声明/定义身份处理、签名证据、无损 NUL 词表和源码快照校验，不用社区实现覆盖这些增强 | `src/upstream-explore/mcp/cpp-target-identity.ts`、`cpp-signature-evidence.ts`；`src/mcp/explore-source.ts` |
| COBOL copybook | 已迁入消费侧查询能力，但原生 extractor 没有 COBOL 支持，不能宣称端到端对齐 | `src/upstream-explore/graph/cobol-copybooks.ts`；`__tests__/upstream-v162/explore-cobol-copybook.test.ts` |

以上表格表示迁移范围，不是“每项已在所有语言、后端和入口验收”的承诺。Explore 的启用策略仍由宿主控制（`CODEGRAPH_ENABLE_EXPLORE`，默认关闭）；这属于产品入口差异，不应和算法缺失混为一谈。

## 4. 原生图差异：已经知道什么，尚不能知道什么

### 4.1 历史控制实验提供的证据

旧候选 `e7dc7af` 中的历史报告路径为：

`artifacts/codegraph-explore-upstream-parity-20261024/reports/REPORT.txt`

该文件保留在旧候选提交中，**不是本轮重新生成的实验结果**。其中报告：

- 固定官方图，只替换官方/移植消费流水线，12 条查询响应 SHA-256 一致。
- 固定原生图，通过相同兼容查询 API 使用官方/候选 handler，12 条查询响应 SHA-256 一致。
- 历史 OceanBase 原生图为 890,562 节点、5,676,237 边；社区图为 388,727 节点、2,510,241 边。两边源码清单一致，但使用的是冻结历史数据库，不代表本轮提取版本相同。
- `process_one` 同名候选由社区的 6 个定义变为原生的 13 个声明/定义；`execute_ttl_delete` 等在原生图中额外有头文件声明。相关定义主体行范围一致，但预算竞争不同。

这些证据支持“当时部分输出差距来自输入图及其消费方式”，不支持“所有额外节点都是噪声”，也不支持“当前社区所有能力都已迁完”。12 条查询的同图等价不能推广成全场景等价。

此前 Go 接收者、TS 成员/docstring、RTK 等提取问题已有候选修复，不能把历史报告中的失败机械列为当前仍存在的问题。本轮保留相应回归，另以真实原生提取结果验证。

### 4.2 本轮确认的 Razor 边缺失

当前社区的视图 blast-radius 两例未端到端通过。对原生测试图的检查显示，`Views/Edit.cshtml` 与 `Views/Index.cshtml` 仅产生 component 节点，关联边为空；不是因为展示层把存在的边隐藏了。社区 `97492056` 新增 Razor `<script>` 块提取，宿主尚未迁入。独立反事实测试只补入所缺 calls 边后，views 独立展示项两例通过；该测试证明消费逻辑可工作，不代表真实提取已经修复。对应 `__tests__/explore-upstream-blast-views.test.ts`，真实社区 fixture 的失败保留可见。

另有 C union 的表示差异：本轮小型真实索引探针中，`union CallbackOps { int (*run)(int); };` 被原生索引表示为 `kind=struct`，Explore 也检索到了该节点；社区断言要求 `kind=union`。这不等于符号丢失，但说明两种图不能直接按 kind 做逐行等价比较。证据见 `union-kind-evidence.json`。

### 4.3 性能相关的适配差异

`src/mcp/upstream-explore-adapter.ts` 可直接确认：

- 原生 `files` 缺少社区的 `generated` 字段，需要通过已校验源码重建该信息。
- 请求使用 `ExploreSourceSnapshots`，包含路径和内容有效性校验，不只是读取数据库行。
- 查询缓存检查 `total_changes`、`data_version`、schema version；事务或外部提交会使缓存失效。
- 名称词表采用连接级 TEMP 表，以免只读查询修改主数据库；首次请求可能承担构建成本。

高入度邻接读取仍是待测热点；社区用于 impact 的邻接 LIMIT 不在本轮 Explore 移植范围，不宣称已解决该成本。

此外，原生 `idx_nodes_kind` 与社区同名索引的列不同。仅凭索引名称选择快速路径，会改变等长名称的输出顺序。本轮根据实际索引布局校验顺序，并保留回退及差分测试。这说明“照搬社区 SQL 优化”也需要宿主适配。

源码安全检查、外部提交失效和代际切换不是可随意删除的性能负担。优化必须保留同大小/mtime 源码变化、符号链接逃逸、文件删除、rollback 与外部写入等正确性边界。

## 5. 性能结论的边界及后续实验

用户提供的旧实验为：首次 24.01s 对 6.35s，后两次约 9.9s 对 2.6s；详细第二次 SQL 7.37s 对 2.46s，文件系统 1.32s 对 0.08s。**这些是本轮输入的历史观测，不是本轮独立复现；也不包含完整 MCP 启动流程。**

本轮源码变化不能直接折算成耗时改善百分比。要确认剩余原因，必须串行进行：

1. **固定同一图，交换消费者**：相同 query、预算、会话状态、Node、SQLite 后端和 PRAGMA，分别记录冷启动/首次与预热调用。
2. **固定消费者，交换图**：固定源码提交、文件清单和索引配置，对比原生与社区图。
3. **拆分执行阶段**：SQL 执行与行映射、文件系统与校验、Flow/排名、渲染分别记录；采集慢 SQL 的 `EXPLAIN QUERY PLAN` 和实际返回行数。
4. **抽查高入度符号和预算挤占**：区分合法声明、定义、类型证据与错误绑定；每项判断回到源码和边来源，不按总节点数推断。

图差分应按文件、kind、限定名、位置、签名及声明身份匹配节点；按两端节点身份、边种类、调用位置及来源匹配边，并保留重数。不同数据库的自增 ID 不能直接比较。

本轮尚未获得可复用的历史大仓数据库与全部测量环境，未重新跑 OceanBase 大仓性能矩阵。不能据此宣布“已追平社区速度”。

## 6. 验证分层，避免把测试通过当作全产品等价

- **查询层 oracle**：`__tests__/upstream-v162/oracle-index.ts` 默认使用原生提取与兼容图 API，`tool-handler.ts` 直接调用 vendored handler。部分白盒 fixture 使用隔离、可写的 raw 图来插入节点/边。它们检验算法与图兼容，但不等于真实 portable 入口。
- **真实生产宿主**：`__tests__/explore-production-acceptance.test.ts` 覆盖实际 schema、中文 Flow、会话隔离、sync 后源码刷新、独立 writer 和候选库发布后的读连接更新、超大函数预算。
- **真实 MCP 协议**：`__tests__/explore-mcp-wire-acceptance.test.ts` 通过构建后的 CLI 启动 stdio MCP direct 模式，验证 tools/list、tools/call、输入校验和会话隔离。此项不等价于 Windows daemon 验收。
- **主库只读与 TEMP**：生产读连接继续以 `readOnly: true` 打开主库；移除同时禁止 TEMP 的 `query_only` 限制。主库写入拒绝与内容不变需单独回归，不能因白盒测试需要写入而放宽生产主库。
- **取消与交付边界**：`explore-cancellation-session.test.ts` 使用真实 graph、handler、MCPSession 与受控 transport，验证取消或发送失败不登记“已发送源码”；真正成功派发后再提交会话去重状态。
- **工具建议可调用性**：真实 stdio MCP 验证输出建议使用实际短名，并按 allowlist 实际调用；源码中的同名字符串不改写。`maxFiles` schema 不再声明误导性的固定默认 12。
- **提取与缓存边界**：保留 C/C++ 身份/签名、旧索引升级、缓存失效与 NUL/WASM 词表测试。

最终测试数量和退出状态以 `artifacts/explore-alignment-20261102/` 的最终日志及验收记录为准；初次集成的失败数不是最终验收数。已保留未改动 `e7dc7af` 的对照日志，以区分旧测试预期遗留与本轮新增回归，不以“旧版也失败”为理由隐去缺口。

特别注意：社区 `a3e9e760` 更新 Flow 时同步调整了 Python exact-target fixture/断言；使用旧 fixture 对新算法会出现不匹配。本轮应与当前社区测试一起更新，不将其误报成提取回归，也不能为了通过而删除断言。

## 7. 尚未覆盖/尚未解决的边界

- 原生 COBOL 提取缺失，copybook 的查询迁移不能替代语言支持；Razor script 块调用边也仍缺失，两例真实 views blast-radius 未端到端通过。
- 宿主公开 `buildContext`、`getTopRouteFile` 与 UI 相关测试不等于 Explore 入口；它们仍有独立实现/环境边界，不能用 Explore 成功宣称这些 API 已同步社区。
- 历史自研 Explore 管线的输出预期并非全部适用于当前完整社区 handler；保留对照证据，并区分旧预期冲突与真实功能缺失。
- 未完成 Windows daemon、全后端矩阵、断电恢复或 OceanBase 最终性能验收；本轮生产入口测试范围必须如实标注。

因此当前正确表述是：**在保留原生图与 portable 生命周期的前提下，迁移当前社区 Explore 消费能力，并补充真实入口验证；图等价、全语言覆盖和大仓性能追平仍是独立验收事项。**
