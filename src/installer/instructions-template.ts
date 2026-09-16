/**
 * User-provided Chinese tool-routing rules for the instructions files written
 * by the installer (AGENTS.md / CLAUDE.md / GEMINI.md). Tool examples use the
 * isolated codegraph_wx MCP service prefix; tool arguments stay unchanged.
 */

export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_WX_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_WX_END -->';

/** Full managed block, including the markers used for upgrade and removal. */
export const CODEGRAPH_INSTRUCTIONS_BLOCK = `${CODEGRAPH_SECTION_START}
## 工具使用规则

### 项目上下文探索工具选择

探索源代码时，优先使用 \`codegraph_wx_*\` 获取符号、结构和调用关系。不要用 \`grep\`、\`glob\` 或 \`Read\` 重复扫描已经由 CodeGraph 回答的内容。

#### 工具路由

- 已知符号，只需位置或签名：
\`codegraph_wx_search(query=<符号名>, limit<=10)\`
- 已知唯一符号，需要查看实现：
\`codegraph_wx_node(symbol=<符号名>, includeCode=true)\`
不要先读取其所在文件。
- 符号可能重名或重载：
先用 \`codegraph_wx_search\` 定位目标定义，再用
\`codegraph_wx_node(symbol=<符号名>, file=<文件>, line=<行号>, includeCode=true)\`。
不要一次请求全部同名定义的源码。
- 查询调用关系：
直接使用 \`codegraph_wx_callers\`、\`codegraph_wx_callees\` 或 \`codegraph_wx_impact\`。
关系结果足够回答问题时立即停止，不要为了“多了解一些”继续读取源码。
- 只知道文件、不知道符号：
先调用 \`codegraph_wx_node(file=<文件>, symbolsOnly=true)\` 获取符号概要，
再针对需要的单个符号调用 \`codegraph_wx_node(symbol=...)\`。
- 只知道目录：
先调用 \`codegraph_wx_files(path=<目录>)\`，然后按文件概要和符号逐步缩小范围。
- 必须查看不属于独立符号的局部代码时：
使用 \`codegraph_wx_node(file=<文件>, offset=<起始行>, limit<=200)\`。
仅在缺少必要内容时扩展相邻范围。

#### 硬性限制

1. 禁止调用不带 \`symbol\`、\`symbolsOnly=true\` 或 \`offset+limit\` 的
\`codegraph_wx_node(file=...)\`。
2. 禁止为了定位符号、理解文件结构或查询调用关系而读取整个源文件。
3. 禁止对 \`callers\`、\`callees\` 或搜索结果中的所有符号循环调用
\`codegraph_wx_node\`；只读取与当前结论或修改直接相关的符号。
4. CodeGraph 已返回足够证据后立即停止，不做预防性、重复性探索。
5. 不用 \`grep\` 机械复核成功的 CodeGraph 结果。

#### 允许回退到 grep/Read 的情况

仅限以下情况，并把范围限制到相关文件或行：

- 文件未被 CodeGraph 索引；
- CodeGraph 明确报告索引过期或文件等待重新索引；
- 连续的精确符号查询仍无结果；
- 查找字符串、反射、动态注册、生成代码等 AST 图谱可能不覆盖的引用；
- 需要读取配置、文档或 Markdown。

#### 示例

##### 正例：修改一个函数

任务：“修改 \`Session::refreshToken\` 的超时处理。”
正确：

1. \`codegraph_wx_node(
symbol="refreshToken",
file="session.cpp",
includeCode=true
)\`
2. \`codegraph_wx_impact(symbol="refreshToken", depth=2)\`
3. 只在确有必要时读取某个直接调用者。

错误：

- \`codegraph_wx_node(file="session.cpp")\`

原因：修改目标是一个可命名符号，无需读取整个文件。

##### 正例：只知道文件名

任务：“看看 \`device_manager.cpp\` 里哪段代码负责设备初始化。”
正确：

1. \`codegraph_wx_node(file="device_manager.cpp", symbolsOnly=true)\`
2. 从概要中选出 \`initDevice\`
3. \`codegraph_wx_node(symbol="initDevice", file="device_manager.cpp",
includeCode=true)\`

错误：

- \`codegraph_wx_node(file="device_manager.cpp")\`

原因：应先看结构，再读取目标符号。
${CODEGRAPH_SECTION_END}`;
