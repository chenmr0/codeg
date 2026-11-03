# 冻结 holdout 评估记录

## 版本与范围
- 首次冻结：2026-11-03 00:11:14 UTC；34查询，32计分、2人工控制，82条最小源码证据（54个唯一文件/行位置）。冻结SHA见FREEZE.json，入仓未修改gold。
- 首次三臂：codeg基线`39a13ebb7ce54bf93e9727b6d24c0245ed0e5ac9`；当时最终版`f9e893b4ddb26d1ecd469abd394856b0a39ea4f7`；社区`f72c9d2efb14454ff4f9fd7b8460abd82f19a287`。源码OceanBase`5e8a63d29dae9fde5e962b8fcc7b167d438fc343`。
- 首次102次调用完成，三臂均45/82证据命中、17/32完整清单。未显示holdout增益，亦不是“无退化”证明；独立审查发现gold外外围上下文损失。早期未跑完社区的低分汇总无效，不能引用。
- 六组三语变体相关，不是18个独立意图。只检查源码围栏中的真实编号行，不把回显、诊断、类名命中算答案正确。小清单没有穷尽条件/调用链，不能当完整答案评分。
- 负例三臂明确提示未索引，但仍返回约24.6–25k字符；init未显式澄清歧义。两项控制排除在召回率分母外，不得称控制通过即预算/消歧优秀。

## 新版本状态
首次结果对应f9e893b，而不是后续工作树。撤回co-named owner/member精确目标提升后的候选现已完成同图34项固定回归与1项transaction补充回放，具体见下节；不得把首次旧成绩直接贴到新版本。此套已经被查看并用于诊断，之后只能称固定回归集，不能再包装成未见holdout。运行前后必须记录runtime Git/patch/dist hash与DB hash。

当前主任务测试存在两个明确的`it.fails`预期失败：
1. `explore-cpp-generalization-matrix.test.ts`：`KNOWN BASELINE: three C++ Flow bodies should win three file slots over C-classified prototypes`。
2. `explore-cpp-owner-target.test.ts`：`UNRESOLVED: separately named owner/member should retain the complete weak-read-like method`。

Vitest将预期失败显示为passed，并不代表这两个产品目标已经实现。撤回版当前81 passed包含79项普通通过和2项上述预期失败契约，不得描述为81项功能目标全部满足。此数字是产品测试批次，另列8项harness守卫测试，不混算为89项产品能力。

## 撤回版同图回放（2026-11-03 00:29–00:32 UTC）

这是在已查看该套结果之后进行的固定回归，不是新的独立holdout。执行时身份为`f9e893b`之上的已构建撤回工作树；精确身份由外部证据目录`benchmark/holdout-20261103/next/`的`head.txt`、`working-tree.patch`及`runtime-before.sha256`固定，不虚称纯HEAD。原始响应/数据库仍在外部，不随本小包入仓。

- **新增执行34+1次，全部成功。**34个冻结查询保持45/82条、17/32完整清单，与首次三臂相同；额外transaction为旧案例，不加入34项或82条分母。基线和社区响应复用已固定历史记录，不声称本次四臂全重跑。
- 共用原完整原生图，未重建；数据库前后SHA256均`73e174daa2b53c802fd06a42da0fd7d176e7085bb20507ba4bc5ab442f36aaa2`，runtime前后哈希相同，source-errors为空。
- next与冻结基线29/34全文相同，与撤回前f9e版本26/34相同。这是字面差异统计，不是准确率。

### 恢复与未解决问题

- `backup-clean-cancel`恢复`ob_backup_clean_operator.cpp:111–126`（16/16）；原scheduler主体467–517仍51/51，恢复caller取jobs及callee FOR UPDATE/read/parse上下文。
- `ddl-merge-dispatch`恢复`ob_ddl_merge_task.cpp:2085–2121`（37/37）；`election-lease`恢复proposer:468–469（2/2）。
- `palf-append`的sliding_window:497–499恢复2/3；缺499是注释，不能据此声称实际`try_freeze_prev_log_`调用完整。
- **transaction仍未解决**：输出24,111字符，`acquire_weak_read_snapshot`780–835仅56/106行，836–885明确省略，仍缺880的`snapshot.init_weak_read`及后半隔离级别分支；社区原结果780–885完整。撤回是为避免已观察到的其他回退，不是全面修复。
- 与冻结基线仍不同的5项：`chunk-compress-en`、`palf-append`、`palf-change-leader`、`restore-postcheck`、`ddl-queue-rollback`。涉及chunk/data窗口、PALF header/注释、likely-leader相邻API、额外destroy声明及DDL/backup同名队列窗口；完整逐行差异在外部`four-arm-deltas.json`。不能称全部上下文无差异或只增不减。
- 撤回同时失去旧f9e版本增加的一些有效依赖上下文（如restore直接callee），是预算取舍。自然语言薄弱项没有改善。

外部详细记录为`benchmark/holdout-20261103/next/REPORT.md`、`targeted-coverage.json`、`transaction-check.json`和`results.json`。新版本**未经额外独立未见holdout验证**，也没有新的双人盲评、充分性/全输出precision、置信区间或非劣性检验；不据此宣称整体不差或泛化已证成。

## 入仓边界与复用审查
只纳入冻结输入、配置模板、runner、scorer、说明和许可证文本。没有OceanBase完整源码、原始响应、数据库、依赖或构建产物。gold含必要的短源码摘录，归属与Apache-2.0 LICENSE/NOTICE见README；不能称完全无第三方文本。

配置中的runtime/index/output路径相对配置文件解析。评分要求正确、无tracked改动的OceanBase Git checkout；缺臂、重复、进程失败、调用错误、输出hash不符、gold变化、source错误均拒绝有效评分。运行时Git/dist是否正确、DB是否complete和预算是否相同仍由操作者核实。建议独立新输出目录；勿在仓内提交生成数据。未修改产品代码。

## Harness复核修正（不改冻结gold）
评分器v2.2不再仅信输出目录自报FREEZE：可信validation.py固定原gold SHA，同时核验bundle和输出输入。响应源码header必须为Git跟踪的相对路径，resolve后仍在源码根内且目标受跟踪，拒绝绝对路径、`..`、未跟踪文件和逃逸symlink。重复(path,line)冲突与未闭合源码围栏均拒绝，避免last-write-wins隐藏错误。

8项自动守卫测试通过，涵盖gold/hash同时篡改、路径逃逸/绝对/未跟踪/symlink、冲突重复、相同重复、回显、未闭合及无源码行header。原102响应重新评分仍为三臂45/82、17/32，源码错误0。脚本变更属于验收可靠性修正，没有更改gold或产品。协议仅支持串行；目录检查不是并发锁。旧runtime的openSync回退不保证只读，仍须DB前后hash核验。
