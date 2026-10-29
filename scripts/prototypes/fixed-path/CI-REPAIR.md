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
