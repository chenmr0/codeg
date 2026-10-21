# Explore P0：精确检索、文本兜底与语义归并工具回归

本轮在新的独立候选副本完成 P0。没有修改主工作区或前一轮候选，没有运行模型实验。固定 8 条 query、maxFiles=12 和原数值输出预算后，TTL 宽泛查询完整核心主体覆盖由 0/8 提升到 5/8，限流类单符号查询由 0/8 提升到 7/8。DTL 精确查询最终保持 4/5。输出普遍增长，不能据此宣称节省模型 token 或轮次。

## 修改范围

- **关闭 explore 的弱匹配入口**：不再从 FTS、拆词、词干或子串搜索生成探索入口。完整符号、精确文件线索、唯一短函数名和实际图关系仍保留；常见同名成员优先由同次查询中的类型限定。其他工具及公共混合检索接口没有改动。
- **批量文本兜底**：未解析的完整标识符复用已有源文件扫描器。OceanBase 两条宽泛 query 实际使用 ripgrep，各查到 6 处原样文本命中；命中映射到最小的已索引函数主体，宏参数等无法映射的命中作为位置证据保留，不伪造函数。保留扫描时间、字节、命中样本和查询数上限；小项目仍可用原有 Node 扫描路径，部分扫描明确标为不完整。
- **查询时语义视图**：依据未变化的源码恢复 namespace、可见 using namespace 与成员所属类型，按参数和成员限定符区分重载。在遍历准入前把匹配声明映射到唯一定义，保留已归并声明端点上的关系，添加有源码依据的成员所属关系。索引中的原声明和 ID 不删除，不持久化重写数据库。
- **长签名恢复**：索引中的显示签名可能含省略号；不能拿不完整参数列表判重载。遇到不可解析的参数列表时，从当前、哈希匹配的源码中恢复平衡声明头再比较。歧义类型、多个定义或不匹配参数保持未归并。
- **证据排序和扩展范围**：多个独立完整标识符共同命中的文件优先于只命中一个的文件；同一标识符重复出现不重复加分。查询明确点名成员时，类型入口只补这些成员，保留真实调用关系补查；仅类型或文本恢复查询允许有界成员扩展。
- **Flow 提示**：删除“Full source for these symbols is below”，改成调用链只是关系证据，只有实际交付的源码范围算覆盖。
- 未移植社区的文件预算预分配、剩余额度回收和函数窗口算法；未提高字符预算、maxFiles 或总节点上限。证据排序属于检索调整，函数选区规则保持原实现。

实现位于 `candidate/src/mcp/explore-retrieval.ts`、`explore-semantic.ts` 和 `tools.ts`。新增实现没有 OceanBase、TTL、DTL 或本次具体符号的分支。补丁见 `candidate.patch`。

## 对照条件

- 我们的版本沿革：按用户提供的信息，explore 源自社区 0.9.9。本轮基于上次独立 contract-fix 候选，即已提交 P0 `87ae5a74c421ddb67bbf3b66ab6c4a8edcceb38a` 的衍生副本，不含主工作区 P1/P2。
- 社区版本：本地冻结 `1.6.2 / f6d8f19b29e5f571ffbc557e160aabc5d8d0373a`；不声称它是远端最新版本。
- 同一份独立 OceanBase 源码，16,317 文件逐一验证；复制原先两版对应索引，不重建。节点/边计数前后一致，我们版 890,562 / 5,676,237，社区 388,727 / 2,510,241。原索引器差异仍存在。
- query 与上一轮逐字节一致，maxFiles=12；maxOutputChars=24,000，maxCharsPerFile=7,000，最终硬上限25,000。统一 MCP 展示策略继续只开放 explore。
- 最终候选和社区各执行 8 次真实 ToolHandler.execute；每条无会话历史。前版控制直接引用上一轮的 8 份原始返回。社区本轮 8 份返回与上轮逐字节相同。
- 留存另外两轮候选诊断结果，每轮 8 次，分别在 iteration-1-results 和 iteration-2-results，并保留对应源码。候选按发现的问题进行了修正，不删除或挑掉失败记录。总计新增32次基准工具调用，无模型调用。
- 字符数按 JavaScript UTF-16 长度；另存 UTF-8 字节数。本轮不以诊断耗时比较性能，不统计或推断模型 token、轮次。

## 最终结果

完整主体沿用预先定义的核验集合：TTL 8 个函数、DTL 5 个函数。要求文件归属正确且每一行与源文件吻合，签名、关系引用或部分函数不计完整。覆盖数不是总体定位质量评分。

| query | 前版字符 | 本轮字符 | 社区字符 | 完整主体：前版 → 本轮 / 社区 |
|---|---:|---:|---:|---|
| TTL 三个原始线索 | 23,572 | 24,999 | 24,900 | 0/8 → 5/8 / 0/8 |
| TTL 原始混合 query | 20,798 | 24,867 | 24,979 | 0/8 → 5/8 / 0/8 |
| TTL 任务类单符号 | 15,523 | 12,219 | 24,958 | 0/8 → 0/8 / 0/8 |
| 限流类单符号 | 4,563 | 23,655 | 24,865 | 0/8 → 7/8 / 0/8 |
| 限流函数组 | 10,334 | 23,258 | 22,619 | 5/8 → 7/8 / 5/8 |
| 任务处理函数组 | 23,489 | 23,970 | 24,912 | 2/8 → 2/8 / 2/8 |
| DTL 宽泛符号组 | 14,786 | 15,260 | 24,913 | 2/5 → 2/5 / 2/5 |
| DTL 精确函数组 | 20,743 | 24,381 | 24,895 | 4/5 → 4/5 / 4/5 |

**宽泛入口的增益有真实主体支撑。** 两条 TTL 宽泛 query 均返回限流器 init、两个 check_and_try_throttle 重载、calculate_wait_time、need_commit_trans_early。ripgrep 识别了配置的原样引用，避免仅凭 thread/ops/task 等拆词作为入口。两条返回均没有再展示上一轮那些 Thread/线程包装/批缓冲文件；但这不等于所有图邻居或同名精确匹配都无噪声。

**限流类型查询能跨声明取得实现。** 单独查询限流类时，除5个限流函数外还覆盖 task process 和 process_one，共7/8；精确限流函数组也为7/8。输出增长明显，代表新增证据成本，不能称为省 token。

**精确 DTL 查询的中间退化已修正。** 第二版候选把类型成员展开过宽，导致原本4/5降到2/5；收紧明确成员查询的类型扩展后，最终重新覆盖 need_block、can_unblock、wait_unblocking、wait_unblocking_if_blocked，保持4/5。对应通用测试确保未点名且无真实调用关系的同类成员不会被展开。

## 仍未解决的选区问题

1. 任务类单符号仍为0/8。成员定义可被语义视图解析，但现有排序、聚类和总预算裁剪没有保证这些定义最终交付。
2. execute_ttl_delete 仍未完整交付。任务函数组虽然完整覆盖 process 与 process_one，但当前最终返回中该函数主体的核验行数为0/135；前版为1/135（定义起始行），社区为64/135。其定位仍可在 Flow/关系信息中出现。完整主体数量未下降，不代表所有局部片段覆盖都未下降。
3. TTL 三线索查询中的第二个大选区仍可能被调度器文件占据；宽泛 DTL 查询仍缺完整等待主体。更好的召回并没有自动修复“大选区挤掉后续函数”。
4. 查询时修复不等于全仓提取器已永久修复。未重建索引，也没有把模板、别名和所有 C++ 名称查找情形当作已解决；无法用源码和唯一匹配证明的归属继续保留歧义。

这些限制应在下一阶段的通用选区/预算工作中处理：按明确目标的完整函数分配预算、压缩不必要的类型声明、保护后排函数、用实际返回范围做交接核验。本轮没有为提升分数放宽输出预算或预置验收符号。

## 验证与交付

- TypeScript 编译通过；最终5个相关测试文件共68/68通过。覆盖 C++/TypeScript、真实 ripgrep、批量标识符、边界匹配、声明定义及长签名、命名空间导入歧义、const重载、过期源码、超时/不完整扫描提示，以及已有预算和多态选区行为。
- 前两轮通用测试失败和候选回归均留在 logs 与 iteration-* 中；最终测试为 logs/combined-third.json。
- 1,193个受保护的前版源码/运行时/结果及主工作区源码文件校验未变化；16,317个回归源码文件校验通过。候选源文件与运行时在最终重放前冻结，重放后逐文件校验一致。
- 所有最终候选返回均不误拒多符号，未出现调用配额或完整源码误导提示，未超过25,000字符。完整核心主体数量相对前版无退化；局部片段限制见上文。
- 只生成 candidate-explore-only.mcp.json，没有安装到用户项目，没有运行 Claude，也没有启动正式或预实验模型轮次。
- 机器可读证据：comparison.json、verification.json、conditions.json、queries.json、results/。具体候选文件与补丁：candidate/、candidate.patch。

## 精确 query

- `ttl-seed-bag`：`ObTableTTLDeleteTask kv_ttl_delete_max_ops ttl_thread_score`，maxFiles=12。
- `ttl-mixed-bag`：`kv_ttl_delete_max_ops ObTableTTLDeleteTask ttl_thread_score TTL delete task limit rate`，maxFiles=12。
- `ttl-task-single`：`ObTableTTLDeleteTask`，maxFiles=12。
- `ttl-throttler-single`：`ObTTLDeleteRateThrottler`，maxFiles=12。
- `ttl-throttler-methods`：`ObTTLDeleteRateThrottler init check_and_try_throttle calculate_wait_time need_commit_trans_early`，maxFiles=12。
- `ttl-task-methods`：`ObTableTTLDeleteTask process process_one execute_ttl_delete`，maxFiles=12。
- `dtl-seed-bag`：`ObDtlBasicChannel ObDtlFlowControl ObPxTransmitOp DTL_BLOCKING_TIME`，maxFiles=12。
- `dtl-methods`：`ObDtlBasicChannel wait_unblocking ObDtlFlowControl need_block can_unblock`，maxFiles=12。
