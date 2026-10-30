# 366b594 大仓三轮与 FTS 候选检视摘要

**整体门禁仍未通过；不进入第二阶段。此分支仅增加报告和少量诊断证据，不改变生产代码，也未合入 FTS rowid 候选。**

## 大仓完整三轮：功能 3/3，性能 2/3

冻结 366b594926d461185ab3ef59aa46366fe7af8945，三轮均完整重建，未复用候选、未替换失败轮。第 3 轮查询最大 1410.898 ms（含调度 1411.577 ms），FTS 执行 1273.440 ms；切换暂停仅 19.470 ms，不能拿暂停值替代查询完成时间。本次充分性门禁失败，不将总延迟直接表述为严格测得的因果额外等待。

读 large-REPORT.md、large-metrics.json 和 large-over-budget-requests.json。原始大包保留云端，本次仅公开摘要；source-manifest.json 记录来源摘要和原始文件哈希，不声称公开了全部请求日志。

## FTS rowid：HOLD，未合入

实验候选 aac6ff0，持有说明提交 341c271；基于 366b594。单独维护完好的索引测试 72/72 和 40 次 ABBA 查询有性能收益，但随后公共 insertNode()/INSERT OR REPLACE 复现 native/SQL.js 孤儿 posting，旧新查询结果不同。**72 项绿灯不构成无条件等价证明。**

读 fts-REPORT.md、fts-replace-integrity-repro.jsonl 和对应脚本。fts-abba-timings.json 保留全部 40 个时间，未选快轮。这里只发布证据，不发布候选源码改动。兼容 guard 尚未实现，跨进程快照/完整构建后的性能仍未验证；不能关闭长尾门禁。

## Windows 证据不隐藏

- [366 冻结 CI](https://github.com/chenmr0/codeg/actions/runs/40993418535)：Windows 225/226，长请求排空测试失败；后续重复步骤跳过。
- [确定性测试修订 CI](https://github.com/chenmr0/codeg/actions/runs/40994642483)：全套 229/229，但 Windows cold 第 7/20 次失败。
- [原生阶段诊断 CI](https://github.com/chenmr0/codeg/actions/runs/40995669891)：双平台 20/20 未复现，**仅诊断，不是修复验收，不覆盖旧失败**。

以上与 Linux 大仓三轮为不同证据链。生产入口、旧布局迁移及断电持久性未验收；未发布正式包。
