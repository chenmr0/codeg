# 明确命名数据符号补召验收

基础：远端 `3d24e8beb47c280e3f34116cc647aacc6d18f720`。分支 `fix/explore-named-anchors-20261102`。仅修改 Explore 消费，不修改提取器、数据库结构、sync 或已有边。

## 根因与边界

OceanBase `5e8a63d29dae9fde5e962b8fcc7b167d438fc343` 原生完整图已正确拥有 `DTL_BLOCKING_TIME` enum_member，定义位于 `src/share/diagnosis/ob_sql_monitor_statname.h:175` 的 X-macro 调用。初始 top-k 未包含它；社区继承的 named seed 白名单也不接纳 enum_member / field。

真实全图进一步证实：只扩白名单仍不够，弱种类/孤立权重使该成员低于相对 score floor，在 named-first 排序之前消失。修复接纳明确 identifier-shaped 或全大写、精确匹配且不超过 3 个定义的数据名称，作为独立的 exact 定义证据，分数 50；不改普通候选权重。数据锚点不与 callable 的重载/入调用度竞争，也不扩展邻接遍历。普通小写词、首字母大写的普通词、模糊匹配、多于 3 个同名成员均不获得此补召；限定名可消歧。沿用最多 16 个 query token、原 maxFiles/字符预算/短范围 renderer，不扩大输出上限。

未命中诊断不再断言“定义文件未索引”，改为元数据未匹配，并说明可能是宏/语法未提取、文件未索引或索引陈旧/未完成；不在无证据时教用户修改 .gitignore。

两个 TTL 参数的跨 include 嵌套宏字段提取缺口、K 宏调用错误绑定不在本次修复范围。不减少 C/C++ 符号和边。

## 验证

- `npm run build` 通过；`git diff --check` 通过。
- 原生定向 5 个文件：41 项通过，包括新增 4 项消费测试、13 项 C++ identity、15 项 signature evidence、5 项生产 handler、4 项真实 CLI stdio MCP（包含 enum/field 实际查询）。不宣称全量回归或 Windows/daemon/WASM 验收。
- 社区迁移的 `explore-unindexed-names.test.ts`：8 项通过（调整无根据的旧文案断言）。
- 消费夹具使用真实原生 C++ 提取的 enum/field，但控制初始 gather 为 3 个高分文件的 90 个 callable + entry，以覆盖 top-k 漏召及 score-floor gate；断言原定义可见及字符预算。
- 真实 CLI → stdio MCP → tools/call 返回 enum/field 原定义，未泄露 `_cg*` 内部字段。

## OceanBase 只读生产核验

完整原生库：14,314 files / 853,588 nodes / 5,666,519 edges。`CG.openReadOnlySync` + 生产 `ToolHandler.execute('explore')`；主库写操作被 readonly 拒绝。未重建索引，未更改现有图。初次误用 raw reader 被生产 read-pin 检查拒绝，改用受支持的 read-only facade 后通过；拒绝结果不计入下表。

查询：`ObDtlBasicChannel ObDtlFlowControl ObPxTransmitOp DTL_BLOCKING_TIME`，`maxFiles:12`。旧冻结 runtime 的树等价于本基础提交。两版本独立进程顺序运行，各同一 handler 连续 3 次，不同时跑 init/sync/其他全图查询；表中正式测量期间无本任务夹具回归。

| 项目 | 基础版本 | 修复版本 |
|---|---:|---:|
| 首次调用 ms | 15911.208 | 15784.428 |
| 第二次 ms | 1648.805 | 1596.484 |
| 第三次 ms | 1651.331 | 1617.254 |
| 最终 response chars | 25334 | 25242 |
| DTL 定义行 175 | 缺失 | 原样返回 |
| 逐行对源检查 | 572 行，0 差异 | 587 行，0 差异 |

这是单查询成本观察，不足以声称性能加速；完整性能对照由另一个实验负责。先前有夹具并行的探索性 probe 不作为性能证据。最终代码整理后又独立核验一次，输出 SHA 与修复测量完全一致（16921.649 ms，只作语义确认）。

修复后的目标 header rank=4、score=50，短窗口 810 chars，不是整个 enum/header；vendor 内容 24896 chars，小于其 hardCeiling=25000。生产 wrapper 总计 25242 chars，包含既有附加说明（基础也超过 25000），不能把 vendor ceiling 冒称整个 wire response 的硬上限；本次未扩大预算，未修既有 wrapper 计费行为。

- 基础输出 SHA256：`5d32c7325b3835bc5947521a64491084cc42a5c7e1cde2c921688ac283545b97`
- 修复及最终输出 SHA256：`83a7bb24d7d2fe77df3d8670aef371c650a57d535efba591044c0e7ad8a64919`

复现脚本 `probe.cjs`，参数为已建库源码根目录；可用 `RUNTIME=/path/to/dist OUTPUT=baseline.json` 切换基础版本。完整结果 JSON 保留在 `../explore-bench-20261102/named-anchors-20261102/`，不把 OceanBase 整段源码副本提交到产品仓库。实际图仍可能有预算省略；已有 not-shown 路径指针继续生效，不把有索引匹配却未展示的名字列为 Not in the index。
