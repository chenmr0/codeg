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
