# Explore 上游来源与移植边界

- 初始来源：`colbymchenry/codegraph@6560052a6f856855d3f71eee838fd66ccfa4285d`。
- 本轮比较来源：`colbymchenry/codegraph@f72c9d2efb14454ff4f9fd7b8460abd82f19a287`（2026-11-01）。两者 package.json 均显示 1.6.2，版本号不足以判断代码一致。
- 宿主原始候选：`chenmr0/codeg@e7dc7af4f362dbd7f20349839bd3be112c064983`。

本目录是 Explore 的只读查询子集，不是整个社区程序的镜像。保留原生图、C/C++ 声明/定义身份视图、签名类型证据、无损 NUL 词表及源码校验；不替换宿主 portable sync、数据库发布与 MCP 生命周期。

本轮迁移涵盖：CJK 查询词、完整限定名与 Go 包名、Flow 非支配路线、线性路径前驱、类型层次双向遍历、copybook 定位、命名大函数窗口与缺口说明、未索引名字提示、动态派发边的逐条与公平展示、测试路径过滤、长查询上限和查询缓存、FTS rowid 连接及 name/path 过滤。

性能适配必须尊重宿主 schema：原生 `idx_nodes_kind` 只有 `kind`，社区为复合索引。子串索引按 `index_xinfo` 验证实际扫描顺序；不支持的顺序或 NUL 名称回退 SQL。不可仅按索引名认定顺序，也不可为更快而删掉合法声明/定义节点。

本次没有引入与 Explore 无关的社区 dead-code、file cycles、CLI implementations 或全量 extraction/resolution 升级。因此“Explore 查询能力对齐”不表示索引生成的节点和边与社区逐字一致。

## 已知宿主边界

宿主当前未提供 COBOL extractor，因此 copybook 迁入的是查询消费能力，不代表原生 COBOL 端到端支持；缺少 nodes/files 时不会凭空生成结果。宿主公开 `buildContext` 和 `getTopRouteFile` 仍走原有实现，不在本轮 Explore 替换范围内，其社区对照失败必须单独报告。

社区 `a3e9e760` 同时更新了 exact-target 测试：Flow 应覆盖查询明确命名的 `pre_sql_setup`，而不是优先未命名的短路径；测试扩大 fixture 才继续触发 focused 渲染。回归基准随该功能使用当前上游断言，并非为通过而删断言。

Razor 还有一项独立数据层边界：宿主能生成 `.cshtml` component，但未迁入社区 `97492056` 的 inline JavaScript/TypeScript 脚本引用提取。当前 `Views/Edit.cshtml` / `Index.cshtml` 对 `fmt` 的调用没有生成边，因此真实索引的 view blast-radius 两条上游测试仍失败。对同一消费方法注入这些缺失调用后，独立 `explore-upstream-blast-views.test.ts` 两条通过，验证 view 独立展示项已经迁入；不会为通过测试在真实索引夹具中伪造边。

## 明确命名数据定义锚点（2026-11-02）

原生 C/C++ 已恢复的 enum_member / field 可以在初始 top-k 遗漏后补召：只接纳精确、identifier-shaped 或全大写、最多 3 个同名定义；作为独立 exact 定义证据越过弱种类 score floor，沿用原字符/文件预算。普通词与大同名族不获得该保护。该消费差异是为利用增强图，而非删减节点以模拟社区图。未命中提示亦不再将元数据缺失无条件归因为文件未索引。证据见 `artifacts/explore-named-anchors-20261102/VALIDATION.md`。
