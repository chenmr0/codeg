# OceanBase explore P0 修复与工具级回归

P0 已落地：BFS 不再越过节点限额或丢失已接纳节点的关系，C/C++ 声明定义以规范化入口参与探索，前置声明不再抢占完整类型的成员归属。相同 query 和 `maxFiles=12` 下，原始查询恢复了 `need_block/can_unblock` 的完整正文；`wait_unblocking` 在精确查询中保持完整，在宽泛查询中仍未返回。

本次没有调用模型。结果是工具返回和三个关键函数的源码覆盖，不是需求级定位质量总分，也不是模型 token、轮次或全流程成本结论。

**实际修改**

- [BFS](D:/python_code/codegraph/src/graph/traversal.ts:104)：逐节点检查限额，入队去重；达到节点上限后继续检查已接纳节点之间的边，保留不同调用位置的平行边，不再依赖出队才记录关系。
- [探索入口归并](D:/python_code/codegraph/src/context/entry-points.ts:1)：优先选择唯一匹配的完整类型/函数定义；明确符号各有入口，声明和同名构造函数不再重复占位。仅在类型、owner、参数签名可消歧时归并；保留歧义，不跨命名空间或重载误合并。
- [上下文入口与配额](D:/python_code/codegraph/src/context/index.ts:899)：明确点名的指标枚举不受默认低价值类型过滤影响，但调用者显式设置的类型过滤仍生效；完整解析的符号组合不再用名称片段补足入口。归并后保持原每入口配额，避免剩余类型获得更大的无关扩展范围。
- [C++ 成员归属](D:/python_code/codegraph/src/extraction/tree-sitter.ts:3339)：用源代码中的 namespace 证据恢复 AST 丢失的命名空间后缀；类外成员按限定类型名归属到完整定义，避免挂到前置声明。[源码作用域扫描](D:/python_code/codegraph/src/extraction/c-cpp-source-scope.ts:1) 对条件分支仅保留共同的 namespace，不猜测歧义。
- [声明定义联系](D:/python_code/codegraph/src/resolution/callback-synthesizer.ts:604)：补齐同一头文件内的类外实现与类内声明联系；owner 比较遵守 C++ 大小写。提取版本升至 **37**，旧索引需完整重建后才能获得持久化关系修复。

没有修改本轮的 MCP 指令、选区排序、每文件字符预算、输出上限或实验需求文档。

**固定输入与重建条件**

```text
Q0  ObDtlBasicChannel ObDtlFlowControl DTL_BLOCKING_TIME ObPxTransmitOp
Q1  ObDtlBasicChannel ObDtlFlowControl wait blocking DTL_BLOCKING_TIME ObPxTransmitOp
Q2  ObDtlFlowControl::need_block ObDtlFlowControl::can_unblock ObDtlBasicChannel::wait_unblocking

maxFiles = 12
```

Q0/Q1/Q2 与上一轮逐字一致。源码仍为 OceanBase `fe6b80241aeb33761e760af76d16804ca070b974`，两版隔离副本各 16,317 个源码文件 SHA-256 核验一致。我们的索引完整重建成功：14,258 个文件、0 个索引错误，耗时约 455 秒；不是只重建已知目标文件。

| 索引统计 | 修复前 | 修复后 |
|---|---:|---:|
| 文件 | 14,258 | 14,258 |
| 节点 | 890,514 | 890,562 |
| 边 | 5,651,329 | 5,676,237 |

索引的源码路径及内容哈希记录一致。社区版保留原执行文件和索引，在新副本重放三条查询，三个输出均与上一轮逐字节一致。

**最终返回比较**

“完整”要求该函数主体范围内每一行都在带行号源码块中，并与冻结磁盘源码逐行相同；标题、关系图、声明和大纲不计入正文覆盖。字符数采用工具实际 JavaScript 字符串长度，不是 token。

| 查询 | 版本 | 返回字符数 | need_block | can_unblock | wait_unblocking |
|---|---|---:|---|---|---|
| Q0 | 社区 | 24,913 | 13/13 | 13/13 | 0/91 |
| Q0 | 我们修复前 | 22,305 | 0/13 | 0/13 | 0/91 |
| Q0 | 我们 P0 | **14,909** | **13/13** | **13/13** | 0/91 |
| Q1 | 社区 | 24,960 | 13/13 | 13/13 | 0/91 |
| Q1 | 我们修复前 | 22,754 | 0/13 | 0/13 | 0/91 |
| Q1 | 我们 P0 | **17,403** | **13/13** | **13/13** | 0/91 |
| Q2 | 社区 | 24,990 | 13/13 | 13/13 | 91/91 |
| Q2 | 我们修复前 | 22,756 | 13/13 | 13/13 | 91/91 |
| Q2 | 我们 P0 | **20,929** | **13/13** | **13/13** | **91/91** |

相对我们修复前，Q0/Q1/Q2 输出字符分别减少 **33.16%、23.52%、8.03%**。最终三次工具调用记录中，所有设置了有限节点预算的 BFS 均为 **0 次越限**。

Q0 的主入口从前置声明、构造函数、泛用宏及命名空间混杂，变为四个明确符号：`ObDtlBasicChannel` 类型定义、`ObDtlFlowControl` 类型定义、`DTL_BLOCKING_TIME` 枚举项、`ObPxTransmitOp` 类型定义。每入口仍限 25 个节点；合并后的初始子图为 **83 节点、84 边**，两个判定方法都在其中，并最终返回 `ob_dtl_flow_control.h:82–157`。

完整重建也确认：

- `wait_unblocking` 的头文件声明与 `.cpp:801–891` 定义现在拥有一致限定名，并存在 `defines` 联系。
- `set_block/unblock/is_block` 的所属类型均为 `ob_dtl_flow_control.h:82` 的完整类定义，前置声明不再拥有这些实现成员。
- Q2 的 `.cpp:765–894` 覆盖 `wait_unblocking_if_blocked` 及完整 `wait_unblocking`，三个目标主体全部保留。

详见[节点和成员归属核验](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/identity-verification.json)、[逐查询覆盖及源码范围](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/comparison.json)。

**尚未解决的选区问题**

Q0/Q1 仍没有召回等待函数主体，且最终仍触发原有整文件边界裁切。Q0 最终只保留 basic_channel 头文件、flow_control 头文件和 basic_channel 源文件三个源码块；Transmit 和指标定义虽有入口，并未因此保证正文返回。Q0 的 14,909 字符也包含了裁掉后续文件的效果，不能把减少的字符全部称为“等质量压缩”。

Q2 不再触发最终裁切，但仍返回公共日志宏和错误码等旁支。下一步 P1 应解决：从类型/行为线索选成员实现、用完整函数而不是大容器作为打包单位、为不同明确符号保留正文配额，以及截断后的真实覆盖说明。本轮没有为改善数字而提前修改这些选区策略。

**测试与保留材料**

相关测试覆盖 290 项，289 项通过；剩余 1 项是既有 `cpp-literal-member-macro.test.ts` 原始字符串宏用例。旧版冻结程序与 P0 程序均产生同样的缺失类型结果，已保存对照，不计为新增回归。最后入口过滤和配额调整又通过了 45 项针对性测试。TypeScript 独立构建成功，补丁空白检查通过。

- [主测试结果](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/validation/tests.json)；[最终入口回归](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/validation/entry-final-tests.json)
- [既有失败的旧版证据](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/validation/raw-literal-old.json)；[P0 对照](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/validation/raw-literal-p0.json)
- [P0 专项测试](D:/python_code/codegraph/__tests__/explore-p0.test.ts)；[仅含本轮产品与测试修改的补丁](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/p0-verified.patch)
- [最终 Q0 原始输出](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/verified-results/ours-primary.txt)；[最终 Q1 原始输出](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/verified-results/ours-with-wait-blocking.txt)；[最终 Q2 原始输出](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/verified-results/ours-named-functions.txt)
- [输入协议及最终候选路径](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/protocol.json)；[完整性检查](D:/python_code/codegraph/artifacts/oceanbase-explore-p0-20261021/postflight.json)

127 份历史日志/诊断文件和根目录原 `dist` 均未覆盖。P0 源码已修改，最终验证构建保存在 `artifacts/oceanbase-explore-p0-20261021/candidate-verified`，与全量重建时的提取器、解析器和关系合成器一致；差异只在上下文入口模块。中间工具回归输出保留在 runtime-only、results、final-results，最终结论只取 verified-results。

包括中间诊断迭代，本轮共执行 15 次实验工具查询，模型调用为 0；没有启动新的模型预实验或正式实验。
