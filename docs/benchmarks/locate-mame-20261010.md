# MAME 需求定位验收（2026-10-10）

本记录对应阅读指南改造前的输出。新版展示和预算实测见 [阅读指南验收](locate-reading-guide-20261010.md)。

## 环境与准备

- 分支：`perf/reuse-sync-scan-metadata-20261009`。
- Node.js：24.11.1，Windows；CLI 使用 `--liftoff-only`。
- 项目：`D:\c_proj\mame`，本地 Git HEAD 为 `57cf29e2c75e24ac168d35a418cbd6d26113088e`。
- 使用当前分支编译产物执行 `codegraph init`，完成 21,811 个文件、1,590,483 个节点、8,536,493 条边的索引，约 11 分 3 秒。索引构建是准备步骤，不包含在定位时间中。
- 输入：[中文需求样例](../examples/locate/mame-snapshot-feedback.md)，含 20 个主要符号、伪代码、真实源码节选及混合改动草案。
- 每次测量启动新的 CLI 进程，记录完整墙钟时间；没有清理操作系统文件缓存，因此不是冷磁盘性能测试。

## 最终实测

| 输入／预算 | 墙钟耗时 | 候选数 | 总输出 tokens | 单条最大 tokens |
| --- | ---: | ---: | ---: | ---: |
| 文件，6000／900 | 592 ms | 9 | 3766 | 471 |
| 文本，6000／900 | 569 ms | 9 | 3766 | 471 |
| 文件，1800／350 | 1034 ms | 9 | 1767 | 329 |
| 文件，512／128 | 901 ms | 3 | 438 | 109 |

预算列为“总上限／单条上限”。使用本地 `o200k_base` 对实际 stdout 再次编码核验，计入 JSON 元数据、转义和换行。极小预算会丢弃无法容纳的完整候选，不保证保留默认结果的所有关键位置；返回值会记录省略数量。

默认结果的前七项：

1. `video_manager::save_snapshot` — `src/emu/video.cpp:332`
2. `video_manager::save_active_screen_snapshots` — `src/emu/video.cpp:361`
3. `mame_ui_manager::handler_ingame` — `src/frontend/mame/ui/ui.cpp:1649`
4. `video_manager::create_snapshot_bitmap` — `src/emu/video.cpp:1045`
5. `video_manager::open_next` — `src/emu/video.cpp:1114`
6. `util::png_write_bitmap` — `src/lib/util/png.cpp:1288`
7. `running_machine::popmessage` — `src/emu/machine.h:381`

此外返回截图目录和文件名配置访问器。没有为凑足 10 条而保留仅有图关联的通用单行访问器。

四个设计草案／虚构名称均为 `index_miss`；录像、存档和读档的四个明确范围外符号均为 `out_of_scope`，没有出现在源码候选中。`IPT_UI_SNAPSHOT` 虽未作为独立符号入库，但在已核验的 UI 源码中找到，返回 `source_match` 及位置。草案接收 `save_snapshot` 返回值，而源码签名为 `void`，结果包含该差异提示。

默认输出 `partial: true`，原因为 `neighbor_limit` 和 `source_file_limit`：主动限制一跳邻居和读取文件数量，不代表查找超时或索引构建失败。小 token 预算另外标记 `output_token_limit`。

## 验证与限制

- 定位功能 14 项测试：文档来源、干扰过滤、限定名消歧、重复线索、路径、源码片段、草案签名差异、取消／超时、过期源码、文件／文本 CLI、开关、输入校验、两种输出的 token 上限。
- 相关回归共 64 项测试通过：上述定位测试及 CLI node、CLI 位置格式、Node 版本检测、精确符号检索。最终排序调整后单独重跑定位测试。
- TypeScript 编译通过；工作区原有的未跟踪 `src/extraction/recovery-retention.ts` 依赖当前分支不存在的接口，默认 `npm run build` 会被它阻断。验收使用 `artifacts/locate/tsconfig.json` 临时排除它和另一份未接入的 `node-facts.ts`，没有修改这两份文件或仓库正式构建配置。
- 此样例验证了带代码锚点的中文需求，不构成对所有需求文档准确率或 P95 耗时的统计结论。

原始结果在 `artifacts/locate/mame-default-file.json`、`mame-default-text.json`、`mame-tight-json.json`、`mame-tiny-json.json`，汇总为 `mame-validation.json`。复测脚本为 `artifacts/locate/verify-mame.cjs`。
