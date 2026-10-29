# 当前验证入口与范围（第一阶段）

本目录是独立可运行原型；生产 `src` 不引用。所有活动图数据库由原型实际存放在 `.codegraph-wx/codegraph.db`，不是 CURRENT 兼容副本。基础协议说明见 README.md；该说明中的51项数字为早期记录，最新累计测试数为89项。

## 当前验收与复跑

```sh
npm ci --ignore-scripts
npm run build
node scripts/prototypes/fixed-path/run-source.mjs
```

**当前shared-read实验未通过Windows完整负载门禁，保持关闭；主验收使用 `CODEGRAPH_PROTOTYPE_READ_GATES=0 node scripts/prototypes/fixed-path/run-source.mjs`（PowerShell用环境变量赋值）。**

`run-gates.mjs` 仅供明确需要的实验A/B，顺序运行 exclusive 和 opt-in shared-read 两种模式，每种89项；输出完整日志、阶段时间、查询分位数和细分gate指标。`run-source.mjs` 单独运行当前默认（exclusive）一次89项。

Windows严格验证必须设置 `STRICT_SYMLINK_TESTS=1`。它要求真实创建文件/目录符号链接并验证拒绝行为；EPERM不允许被skip视作验收通过。没有权限时应修复验收环境权限或换可用runner，而不是放松断言。不要在用户真实数据目录运行夹具。

专用CI仅测试与上传日志，不调用release、npm publish或合并流程。严格Windows真实通过、代表性真实大仓同仓sync/init比较等证据未齐前，不进入第二阶段。

## 安全与可见行为

- 旧库构建期间可查询；切换短暂暂停新准入，跨进程真实连接租约排空后替换。
- 发布确认后不能因清理失败回滚，持久化协议区分未提交恢复和已提交清理。
- 单文件公共库离线覆盖：正常关闭所有参与进程后覆盖固定文件，重开读取新库；不能在线直接覆盖。
- 无法原子冻结不合作编辑器的源码目录。当前契约是**条件最终收敛**：持久化补查、完整哈希兜底、最终静止后自动修复索引。允许观察与补偿期间短暂旧索引，不保证每次瞬时编辑都独立记录。
- sourceSnapshot优化只复用64KiB缓冲区及合并metadata调用，不删双快照或完整内容检查。
- gate优化仅opt-in：已有native handle及connection lease的warm只读准入持SHARED事务观察状态并计数；cold/write/cancel/发布仍写事务。warm admission默认仍exclusive；空闲退役观察在两模式中都为只读事务，已有参与者恢复重试不再重复初始化协调库。
- 旧版程序或直接连接SQLite且不遵守协议的外部使用者不受保护。断电、大仓、所有生产入口需要各自证据，不能用小夹具通过替代。

## 指标解释

query samples是闭环负载（完成后休息再发），不是固定到达率拥塞测试。源码观察的beforeSnapshot/adaptivePlan/afterSnapshot分段，及gate的open/begin/action/commit/close分段帮助定位热点，不保证其分位数可以相加。

编辑、检查、发布提供同机epoch时间线用于诊断；budget仍用单调时钟。检查可能与批量文件编辑重叠，不能简单把dirty+build+postcheck之和作为编辑结束后收敛时间占比。实际切换暂停与发现、构建、补偿全过程收敛时间是不同指标。

## 第二阶段边界

只有上述门禁通过后才允许受控接入生产初始化、读取、后台sync和迁移。生产入口与迁移冲突/异常恢复验收前，不默认开启，不发布正式包。当前本目录代码不能直接当作生产API使用。
