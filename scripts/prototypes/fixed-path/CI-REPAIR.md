# Windows CI 首轮失败后的修复候选

首轮验证分支 commit `2ac98dc982270e40f434173d09745921dd85b31d`，run `40883018990`：

- Windows 文件/目录 symlink 真实创建及拒绝测试通过，专项5/5、0skip。
- Windows完整exclusive为67/73，尚未通过；shared-read未运行。
- Linux两模式73/73。

Windows六失败不能当作门禁通过，也不能仅用重跑隐藏：三例子进程exit0但无终态结果；一例补查等待超时；两例SQLite锁竞争。

本候选做了两组独立修改：

1. IPC统一显式发送完成：非阻塞phase hook仍不改变协议时序，终态await发送callback，退出前排空全部pending消息。父侧消费stdout的用close等待流结束。发送错误明确失败。source-performance提前识别worker错误/退出并保存messages/stdout/stderr/exit/signal，保留原30秒事件等待预算，避免只看到模糊超时。
2. 已初始化Participant内部恢复重试先取publisher owner，不再为了发现活publisher而每次调用initialize取得协调写锁。外部recover依旧完整initialize，缺失租约或损坏state仍fail closed，不能重建活跃锁。空闲退役观察只需要SHARED且仅在active=0并持有handle/lease时执行；不授权准入，不关闭在途请求。warm admission仍保留exclusive/shared-read两模式。

没有放宽500ms协调锁预算或1秒排空预算，没有吞掉backgroundError，也没有修改源码全内容检查。两模式现在共同使用只读退役观察，比较对象不再是“所有观察都exclusive”的历史基线，报告必须标明这一点。

新增7项：IPC延迟callback/真实4MiB背压/发送失败三项；恢复重试不初始化、未提交draining下只读观察、缺租约拒绝、损坏state拒绝四项。最新runner为每模式80项。Linux通过仍不能代替Windows复测；需同专用分支CI继续执行并保留原失败证据。

真实大仓基线仍在独立旧worktree运行，未修改其protocol/adapter/source实现。比较报告必须记录代码hash，不将新CI候选结果冒充旧大仓版本已验收。

## 第二轮及父端完成顺序

第二轮远端e0f70679042c96f77c67b94ca89f862e74abaae4/run40885305611：Windows专项symlink5/5零跳过，exclusive79/80，唯一剩gate-read父端在exit时检查终态消息。旧锁错误、补查超时和其余IPC失败本轮未出现，但全门禁仍未通过。

再补父端修复：OS exit不等于IPC/stdio已排空，所有依赖最终消息或stdout的父端改在close之后判定；新增确定性exit→最后消息/日志→close成功及close仍无结果拒绝两项。没有加固定sleep，没有放松子进程exit code或结果断言。当前累计每模式82项，仍须Windows复测。

## 第三轮结果与范围收敛

第三轮a4b78c9/run40886508106：Windows默认exclusive82/82、0skip，strict symlink5/5；shared-read79/82。shared两项冷路径锁失败保留，实验保持关闭，不继续扩大优化。其补查超时经原始事件回放确认是观察谓词要求同一tick的误报：发布成功后另一tick才verified是允许的。修复测试按编辑后outcomes序列确认published→后续verified，实际查询新marker有/旧marker无；新增4项顺序回归。当前默认累计86项，协议及时间预算均未修改，不用此测试修正宣称两项锁错误已修复。

## 默认第四轮锁失败：先补根因诊断

默认-only第四轮run40889950358 Windows85/86（0skip）在五进程重复切换查询出现gate BEGIN阶段database locked；默认不能因第三轮曾通过就放行。Linux86/86。此轮仅补最终open/begin失败及慢gate诊断，记录cold/warm、各阶段耗时、重试、action是否开始和同机时间线；日志在gate关闭后写，诊断写失败不影响真实操作结果。500ms/1秒保持不变。新增3项确定性测试，最新默认89项。需要依据Windows实际失败证据定位后修复，不以重跑一次绿灯掩盖间歇风险。

## 第五轮诊断与最小等待策略修复

诊断run40892224762：Windows88/89，未复现真实锁错误，不能视为旧间歇错误已修复。唯一测试失败是每次发布后等待80ms便假定所有客户端访问过中间代；Windows查询本身可超过80ms，读者合法跳过未查询的代。现改每次发布后显式全部客户端查询当前tag再继续，保留reopens>=4及1秒预算，并记录各客户端A/B/C/D访问。

慢/失败样本显示等待主要在open/BEGIN/COMMIT，而非暖准入action（约0.07ms）；一例单次BEGIN墙钟264.9ms、外层retries0，不能将SQLite busy_timeout=25误作25ms墙钟保证。针对性修改仅gate：open/BEGIN与COMMIT的原生busy_timeout=0，由既有同一started+500ms的JS重试统一管理；action仍25ms且只执行一次；lease库策略不变。单次原生文件IO仍可能超出墙钟预算，不能声称已证明硬实时。

另同一个IMMEDIATE gate内先检查costs是否有行，仅非空才DELETE。SQLite实测空DELETE仍增加data_version；跳过避免冷开重复持久化无效写，有旧历史仍必须清空。两项联合修改的Windows收益需实测，不能单独归因，也尚未证明原失败根因完全关闭。新增7项真实子进程锁/预算/错误回滚/costs回归，默认累计96项。默认全套后固定3轮原五进程切换场景，全部保留、任一失败即失败，禁止挑绿重跑。

## Real OceanBase cold-reopen follow-up (after 11ea183a)

The Windows/Linux 96-case suite and three contention repeats passed at
`11ea183a` / remote `576ce129`; that did not establish the large-repository gate.
The subsequent OceanBase 10 QPS run completed publication and source verification,
but one of five processes failed cold admission with `database is locked` after
502 ms (action had not begun). This run remains a failure, despite its 109 ms
publication pause and successful other queries.

The cold graph factory previously ran while the global coordination IMMEDIATE
transaction was held. Opening a multi-gigabyte graph serialized other processes'
admission behind native graph initialization. The isolated follow-up moves only
this synchronous factory call after successful gate COMMIT. The gate still
checks idle, acquires the real connection lease, persists any write intent, and
increments the local active count before releasing admission authority. The
connection lease protects the path throughout opening, query execution, and
closing: a concurrent publisher must drain/cancel rather than rename under it.
The factory must be synchronous, non-reentrant, and close internal handles if it
throws before returning. Gate COMMIT failure does not invoke the factory.

Neither the 500 ms gate retry deadline nor 1 second drain/short-query budgets
changes. This is not a switch to the experimental shared-read admission mode.
The frozen 11ea183a evidence is retained; new cross-process tests, actual large
DB cold-open comparisons, and Windows runs must establish the follow-up result.

The cold-open change passed Linux 102/102 and actual 3.38 GB five-process cold
opening (three fixed rounds, 15/15 success, versus 10/15 in the instrumented
baseline). However Windows CI 40904686177 failed 101/102: four cold admissions
hit BEGIN contention before action. Open time accumulated 392–430 ms through
repeated close/reopen attempts. The same publisher also held successive durable
state transactions for about 628 ms (COMMIT 91–111 ms each), so this is not
proof that repeated open is the only cause.

The next isolated change reuses a successfully opened gate connection only
within one gate call's pre-action BEGIN retries. Read-only pre-SELECT contention
rolls back the started transaction before retry; rollback failure closes and
throws rather than reusing unknown state. Each call still closes its connection;
there is no persistent connection cache. The original absolute 500 ms deadline,
lease policies, one-shot action, and COMMIT retry semantics are unchanged.
Publication-phase labels now distinguish the durable transactions in telemetry.
This reduces unnecessary open work but does not claim to cure writer starvation
or make filesystem I/O a hard real-time deadline. New Windows evidence is required.
