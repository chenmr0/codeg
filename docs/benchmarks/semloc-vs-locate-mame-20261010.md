# SemLoc 与 locate：同一份 MAME 需求的实际输出

本对照保留阅读指南改造前的原始结果。新版 locate 输出见 [阅读指南验收](locate-reading-guide-20261010.md)。

## 运行方式

输入是 [mame-snapshot-feedback.md](../examples/locate/mame-snapshot-feedback.md) 全文，未手工提取符号或删除干扰内容。输入 SHA-256：`f9d76f1ec0d1ed2ccbd5c799659c41975afd618ad9c3f618542dc2d225f09716`。

双方只读访问 `D:\c_proj\mame\.codegraph-wx\codegraph.db`，即当前 codegraph 分支构建的同一份 MAME 索引。

SemLoc 使用 `D:\c_proj\SemGraph\codegraph\src` 中当前原始 TypeScript 源码，在进程内调用 `ToolHandler.executeReadTool('semloc_locate', args)`。原有 `locateIssue`、`QueryBuilder` 和检索辅助代码均实际运行；适配层只将 CodeGraph 方法委托给原有查询器，并提供规范化项目路径。数据库连接使用 codegraph 的只读 SQLite 适配器，未通过 SemGraph 初始化或改写该索引，未启动 MCP 网络传输。源文件哈希保存在原始汇总中。

我们的工具通过实际 `dist/bin/codegraph.js locate --file ... --path ... --json` 运行，开启 `CODEGRAPH_EXPERIMENTAL_LOCATE=1`。

两组参数：

- 默认：SemLoc 为 20 候选、两轮扩展、不附源码；locate 为最多 10 候选、一次扩展、总 6000／单条 900 tokens，附源码。
- 补充对照：SemLoc 设置 `maxCandidates: 10, includeSource: true`，仍为两轮扩展。它的扩展前沿大小也受 maxCandidates 影响，因此不是简单截取默认结果。

## 耗时和输出大小

| 运行 | 进程墙钟 | 查询执行阶段 | 候选／含源码候选 | 实际输出 tokens | 去掉 JSON 排版空白后 tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| SemLoc 默认 | 5537 ms | 4811 ms | 20／0 | 5624 | 3817 |
| SemLoc 10 条＋源码 | 5299 ms | 4597 ms | 10／10 | 6430 | 5489 |
| locate 默认 | 592 ms | 92 ms | 9／9 | 3766 | 3766 |

全部使用本地 `o200k_base` 计数。SemLoc 原始处理器输出格式化 JSON，而 locate 输出紧凑 JSON，所以另外列出统一紧凑格式的大小，避免将排版差异当作检索质量优势。

SemLoc 墙钟包含约 0.44 秒原始 TS 模块编译／初始化，查询执行阶段不包含这部分。locate 查询时间包含工作线程启动，但不包含最终 token 编码和输出处理。这是单样例实测、未清理系统文件缓存，不是严格的 P95 或冷磁盘对照。三次运行均在一分钟内结束。

## SemLoc 默认返回的 20 条

| 排名 | 限定符号 | 位置 |
| --- | --- | --- |
| 1 | `video_manager::save_snapshot` | `src/emu/video.cpp:332` |
| 2 | `video_manager::save_snapshot` | `src/emu/video.h:78` |
| 3 | `video_manager::open_next` | `src/emu/video.cpp:1114` |
| 4 | `video_manager::open_next` | `src/emu/video.h:63` |
| 5 | `emu_file::open_next` | `src/emu/fileio.cpp:330` |
| 6 | `emu_file::open_next` | `src/emu/fileio.h:165` |
| 7 | `video_manager::save_active_screen_snapshots` | `src/emu/video.cpp:361` |
| 8 | `video_manager::save_active_screen_snapshots` | `src/emu/video.h:79` |
| 9 | `shaders::save_snapshot` | `src/osd/modules/render/d3d/d3dhlsl.cpp:209` |
| 10 | `shaders::save_snapshot` | `src/osd/modules/render/d3d/d3dhlsl.h:333` |
| 11 | `video_manager::create_snapshot_bitmap` | `src/emu/video.cpp:1045` |
| 12 | `video_manager::create_snapshot_bitmap` | `src/emu/video.h:107` |
| 13 | `running_machine::schedule_save` | `src/emu/machine.cpp:690` |
| 14 | `running_machine::schedule_save` | `src/emu/machine.h:189` |
| 15 | `video_manager::machine` | `src/emu/video.h:45` |
| 16 | `mame_ui_manager::handler_ingame` | `src/frontend/mame/ui/ui.cpp:1649` |
| 17 | `mame_ui_manager::handler_ingame` | `src/frontend/mame/ui/ui.h:340` |
| 18 | `emu_options::snapshot_directory` | `src/emu/emuopts.h:337` |
| 19 | `mame_ui_manager::machine` | `src/frontend/mame/ui/ui.h:151` |
| 20 | `video_manager::begin_recording_screen` | `src/emu/video.cpp:394` |

SemLoc 的 10 条＋源码运行，候选顺序与上表前 10 条相同，但附有源码片段。默认第一项的理由包括 `appears in stack trace (save_snapshot)`；本输入是需求与代码节选，实际并没有堆栈，因此这条理由的措辞不准确。

## locate 返回的 9 条

| 排名 | 限定符号 | 位置 |
| --- | --- | --- |
| 1 | `video_manager::save_snapshot` | `src/emu/video.cpp:332` |
| 2 | `video_manager::save_active_screen_snapshots` | `src/emu/video.cpp:361` |
| 3 | `mame_ui_manager::handler_ingame` | `src/frontend/mame/ui/ui.cpp:1649` |
| 4 | `video_manager::create_snapshot_bitmap` | `src/emu/video.cpp:1045` |
| 5 | `video_manager::open_next` | `src/emu/video.cpp:1114` |
| 6 | `util::png_write_bitmap` | `src/lib/util/png.cpp:1288` |
| 7 | `running_machine::popmessage` | `src/emu/machine.h:381` |
| 8 | `emu_options::snapshot_directory` | `src/emu/emuopts.h:337` |
| 9 | `emu_options::snap_name` | `src/emu/emuopts.h:353` |

每项附签名、源码片段、文档行号和具体证据。例如第一项同时具备限定名匹配、保存入口调用关系、真实代码节选匹配及 PNG 错误字符串匹配。

结果还包含：

- 四个草案／虚构名称标为 `index_miss`；这不是对整个源码仓库不存在的断言。
- 录像、存档和读档的四个明确范围外符号标为 `out_of_scope`，没有进入候选列表。
- `IPT_UI_SNAPSHOT` 标为 `source_match`，附已读取源码中的位置。
- 文档第 88 行的草案接收 `save_snapshot` 返回值，但匹配定义返回 `void` 的提示。
- `partial: true`，原因为 `neighbor_limit` 和 `source_file_limit`。输出不是完整影响范围，也没有发生查询超时。

## 这个样例显示的差异

双方都把真正的图片保存函数排第一。SemLoc 前 10 条有 5 对定义／声明，并将其他类中的同名函数也列入；手动 UI 入口排第 16。默认前 20 条还出现了需求明确排除的存档与录像函数。将 SemLoc 数量限制为 10 后，范围外函数不在输出中，但 UI 入口、PNG 写入和提示机制也没有进入前 10。

locate 在这个样例中更符合“少而准”的目标：输出覆盖保存入口、UI 触发、PNG 写入、命名和提示机制，且附有来源及核验信息。不过这份样例参与过开发与调试，不能将本结果当成独立测试集上的准确率结论。

## 原始文件

- `artifacts/locate/comparison/semloc-default.json`：SemLoc 默认的原始 JSON 内容。
- `artifacts/locate/comparison/semloc-aligned.json`：SemLoc 10 条且附源码的原始 JSON 内容。
- `artifacts/locate/comparison/locate-default.json`：locate 的原始 CLI stdout。
- 对应 `semloc-*.mcp.json` 保存完整工具返回包装。
- `artifacts/locate/comparison/summary.json` 保存计数、耗时、源码哈希和候选位置。
- `artifacts/locate/compare-semloc.cjs` 为复现脚本。

本轮只新增对照脚本、结果和记录，没有修改两方定位算法。
