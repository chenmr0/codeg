# locate 阅读指南输出验收（2026-10-10）

后续已按用户澄清改为“需求相关源码上下文”，默认直接提供预取代码，以减少 agent 自行 grep/read。本文前面的实测保留旧版记录，最新结果见文末。

本次改造默认文本输出，检索排序保持原有策略。JSON 保留，并增加文档原文和结构化关系证据字段。

## 展示变化

- 先列需求与源码对应：符号、定义位置、文档行号及必要原文、具体匹配依据。
- 将选中符号的索引关系集中展示，合并重复调用位置，保留关系方向和推断标记；索引没有调用行时明确说明，不拿定义行替代。
- 按文件合并重叠源码行，非连续部分显示缺口。短函数在预算允许时完整展示，长函数注明定义范围与实际展示范围。
- 范围外、未命中、仅原文命中、草案差异集中说明。
- 默认隐藏分数和检索统计，`--verbose` 才增加调试区；`--json` 继续用于程序读取。
- 文本直接按其最终表示执行总 token 预算，不再先按 JSON 总预算裁剪。单条采用独立阅读条目和 JSON 中较大的计数，正文、关系、源码、Markdown 标记和范围说明都受限。

## MAME 实测

同一份 [需求文档](../examples/locate/mame-snapshot-feedback.md)，使用已有 MAME 索引，每次启动新 CLI 进程，未清理系统文件缓存。

| 输出 | 总／单条预算 | 墙钟耗时 | tokens | 候选数 | 展示源码行数 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 默认阅读指南 | 6000／900 | 673 ms | 3366 | 9 | 133 |
| 阅读指南＋verbose | 6000／900 | 680 ms | 3659 | 9 | 133 |
| 小预算阅读指南 | 1800／350 | 944 ms | 1726 | 4 | 63 |
| 极小预算阅读指南 | 512／128 | 1068 ms | 489 | 1 | 0 |
| JSON | 6000／900 | 711 ms | 5435 | 9 | — |

默认仍保留原来的 9 个候选。截图保存与手动截图入口均展示完整定义；长函数 `handler_ingame` 和 `open_next` 只展示相关窗口，并给出完整定义范围。极小预算只够保留位置和依据时，会明确写“本次未展示源码”。

验证脚本逐行将 Markdown 代码块与 MAME 当前文件对照，检查每行内容、行号、同文件行去重、代码围栏闭合。对文本、verbose、小预算及 JSON 重新计算实际 stdout 的 `o200k_base` token 数；对 JSON 中每个候选和文档线索检查单条上限。

## 测试与构建

25 项测试通过：`locate-output.test.ts`（8）、`locate.test.ts`（14）、`cli-query-output.test.ts`（3）。覆盖重叠片段合并、缺口和完整范围说明、结构化调用方向、推断标记、缺失调用行、源码中的 Markdown 围栏、文本／JSON／verbose 的预算、CLI 和定位回归。

TypeScript 编译通过，继续使用之前的临时构建配置，排除工作区中两份未接入且与本分支不兼容的未跟踪 extraction 文件；未改变正式构建配置或那两份文件。

输出：

- `artifacts/locate/mame-reading-guide.md`
- `artifacts/locate/mame-reading-guide-verbose.md`
- `artifacts/locate/mame-reading-guide-small.md`
- `artifacts/locate/mame-reading-guide-tiny.md`
- `artifacts/locate/mame-guide-json.json`
- 汇总：`artifacts/locate/guide-validation.json`
- 复测脚本：`artifacts/locate/verify-guide.cjs`

## 后续调整：直接提供源码上下文

默认输出改为“按文件的实际源码 → 静态调用关系 → 少量核验／排除信息 → 可按需补查的精确缺失区间”。需求原文、逐条匹配解释和排序统计仅放在 `--verbose` 中；JSON 继续保留完整证据。输出包含项目根目录，便于 agent 继续读取相对路径。没有源码的候选只作为位置线索，不计入已预取定义数。

同一份 MAME 需求复测：

| 输出 | 墙钟耗时 | tokens／上限 | 已提供源码的定义数 | 源码行数 |
| --- | ---: | ---: | ---: | ---: |
| 默认源码上下文 | 672 ms | 2487／6000 | 9 | 133 |
| verbose | 657 ms | 3698／6000 | 9 | 133 |
| 小预算 | 845 ms | 1687／1800 | 6 | 79 |
| 极小预算 | 927 ms | 492／512 | 0（仅保留位置线索） | 0 |
| JSON | 710 ms | 5435／6000 | 9 | — |

默认相同的 133 行源码占用更少的输出 token；这是输出效率改进，尚未测量后续 agent 实际减少了多少 grep/read 调用。27 项输出、定位和 CLI 测试通过，默认／verbose／JSON／小预算的端到端源码行和 token 校验通过。

新版原始输出：`artifacts/locate/mame-prefetched-context.md`；JSON：`mame-context-json.json`；汇总：`prefetch-validation.json`；复测脚本：`verify-context.cjs`（均位于 `artifacts/locate/`）。
