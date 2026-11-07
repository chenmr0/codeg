# 从异机接手 OceanBase 第三阶段

下列命令在 Claude Code 所在机器执行。交接分支为 `codex/phase3-claude-handoff-20261108`，产品候选为 `7e37003d5e1829d69251c706c4e23d85e6d62962`，内部基线为 `c6b509d3557b7485a9fee14dbfc5980258205beb`。[四步交接和停止条件](./2026-11-08-phase3-claude-code-handoff.md) · [原始第三阶段计划](https://github.com/chenmr0/codeg/blob/f2c69c56bdc141fe75a25a7a7b0f032762b002b2/docs/plans/2026-11-04-explore-graph-quality-and-cost-audit.md#L289)

**数据包已在原机器生成，公开上传待明确授权。** 当前 Git 分支提供校验清单和工具。以下在线恢复步骤在数据附件发布后可用。有访问控制的镜像也可以按原文件名提供分片，使用同一份清单校验。

## 获取代码和数据

要求 Git、Python 3.10 或更高版本，以及支持大于 4 GB 文件的本地文件系统。下例用 `python3`，Windows 可换成 `python`。建议给数据恢复单独预留 16 GiB，后续完整建库另行规划空间。用一个新目录保存已验证的输入。

```sh
git clone --single-branch --branch codex/phase3-claude-handoff-20261108 https://github.com/chenmr0/codeg.git codeg-phase3
cd codeg-phase3
python3 -B scripts/agent-eval/restore-phase3-data.py --dest ../phase3-inputs
```

恢复工具读取仓库中的 [SHA256 分片清单](../benchmarks/phase3-data-20261108.json)。完整数据共 47 个分片，合计 1,354,895,348 字节。它校验分片、拼接压缩流、解压后的原始内容，并逐文件核验 16,317 个源码文件和 3,955 个运行时及证据文件。看到 `Verification complete.` 后才能进入对照。网络中断后可对同一目录重试。若接收方已通过私有渠道拿到 47 个分片，用 `--from-dir /path/to/parts --dest ../phase3-inputs`；离线复核时沿用同一 `--from-dir` 并加 `--verify-only`。

## 把历史路径映射到 Claude 的机器

下表以 `DATA` 表示 `../phase3-inputs` 的绝对路径。原始 JSON 中的 Windows 绝对路径是历史测量证据，保持原字节及 SHA，在本次新运行合同中填写实际路径。

| 四步交接里的对象 | 还原后的位置 / 处理 |
| --- | --- |
| 原阶段目录 `$A`、修复目录 `$S` | `DATA/artifacts/explore-real-binding-20261106`、`DATA/artifacts/explore-include-directory-20261106`，包含所需脚本、协议、原始结果及回执。评分脚本的旧跨目录依赖也在 `DATA/artifacts` |
| 两臂 OceanBase 源码 | 共用的输入在 `DATA/source/oceanbase`。按源清单向新实验目录的 baseline/candidate 各复制一份并建立独立 Git 根 |
| 完整 v40 图 | `$S/replay/evidence/complete/codegraph.db`。与完整基线主库同 SHA，同一份数据同时供应重放及新基线项目。独立 portable 协调文件在 `DATA/baseline-portable`，按四步交接放到基线副本下 |
| 停机图 | `$S/replay/evidence/frontier/codegraph.db` 和同目录的 `codegraph.db-wal`。两件一起复制到新的工作副本，按 WAL 状态只读打开。原始 SHM 存在 `DATA/forensics/stopped/codegraph.db-shm`，仅作现场哈希核验 |
| 两套产品的精确运行时字节 | `DATA/artifacts/phase3-runtime-snapshots/<完整产品提交>/`，各含 src、dist 及 package/lock 文件。node_modules 按目标系统的 lockfile 安装。原实验 Node v24.11.1 |
| 新尝试目录 `$Run` | 在已还原的输入之外另建，例如 `../phase3-run-01`。新建库、进度、profile、日志及独立工作树写到这里。更新各模板的输入/输出映射并重新冻结 |

在刚克隆的交接仓库中可准备两份产品工作树。先核对提交，再在各工作树按锁文件安装依赖并构建，记录产物与提供的冻结运行时清单的差异。

```sh
git worktree add --detach ../phase3-c6 c6b509d3557b7485a9fee14dbfc5980258205beb
git worktree add --detach ../phase3-7e 7e37003d5e1829d69251c706c4e23d85e6d62962
```

新合同须校验实际打开的 DB、WAL、源码及运行时，先复现六组有序 admission。异机时间戳、系统页缓存和磁盘条件按新机器实测记录。原始 `build/scripts/run.py` 使用 Windows 进程资源采样，在 Linux/macOS 上适配实验驱动的资源监控并记录替换口径。支持包清单列出了省略的 150 个历史 V8 临时编译缓存。完整基线、停机图、源清单、正式结果和评分口径均有独立校验。

## 可转发给 Claude Code 的指令

> 获取 `chenmr0/codeg` 的 `codex/phase3-claude-handoff-20261108` 分支。先阅读本文，恢复并验证远端数据，再按同目录 `2026-11-08-phase3-claude-code-handoff.md` 执行四步。用本机实际路径映射冻结合同。产品从 `7e37003d` 开始，吞吐参照为 `c6b509d3`。先复现六组冻结结果并剖析慢批次，根据证据决定是否修复。达到条件后新建完整候选库，核对 34 个位置及五题 Explore，更新执行分支上的原计划。若附件不可访问、哈希不符或触发停机条件，记录具体文件及失败步骤，然后停止该次尝试。
