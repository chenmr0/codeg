/**
 * User-provided Chinese tool-routing rules for the instructions files written
 * by the installer (AGENTS.md / CLAUDE.md / GEMINI.md). Tool examples use the
 * existing codegraph MCP service prefix; tool arguments stay unchanged.
 */

export const CODEGRAPH_SECTION_START = '<!-- CODEGRAPH_START -->';
export const CODEGRAPH_SECTION_END = '<!-- CODEGRAPH_END -->';

/** Full managed block, including the markers used for upgrade and removal. */
export const CODEGRAPH_INSTRUCTIONS_BLOCK = `${CODEGRAPH_SECTION_START}
## codegraph 源码探索协议
优先使用 codegraph 获取完成任务所需的**最小充分上下文**，不要把 \`Read\` 原样替换成整文件或连续文件窗口。本节为仓库专用规则；与通用工具说明冲突时，以本节为准。
### 1. 按已知信息直接选择入口
不要执行固定的“目录 → 大纲 → 符号”流水线：
- 已知目录、不知道文件：\`codegraph_files(path=<目录>)\`。
- 已知文件、不知道符号：\`codegraph_node(file=<文件>, symbolsOnly=true, outlineQuery=<可选名称片段>, outlineLimit<=30)\`。
- 已知名称/复制来的函数签名，但不确定位置或重载：一个目标用 \`codegraph_search(query=<名称或完整签名>, includeCode="if_unique")\`；2–8 个名称用一次 \`codegraph_search(queries=[...])\`，禁止循环单查询。
- 已知精确符号和位置：\`codegraph_node(symbol=<符号>, file=<可选文件>, line=<可选行>, includeCode=true, includeRelations=false)\`。
- 已知 1–8 个精确实现目标：优先一次 \`codegraph_node(targets=[...])\` 原生批量；它与 \`codegraph_context(targets=[...])\` 使用同一个 implementation bundle。不要循环单目标 \`codegraph_node\`。
- 查调用方/被调用方/影响：\`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`。
已知符号、签名、文本锚点或精确文件范围时直接从对应入口开始，不需要先查目录或大纲。
### 2. \`search(includeCode="if_unique")\`
\`\`\`text
codegraph_search(
  query=<符号名或完整 callable signature>,
  path=<可选路径>,
  line=<可选行>,
  includeCode="if_unique"
)
\`\`\`
- 若候选收敛为一个逻辑符号/重载，结果直接包含声明和定义两端源码（若两端均已索引）；声明和对应定义视为同一个逻辑结果。**不得再调用 \`node\` 重读。**
- 若仍有多个重载/同名符号，结果只返回候选，不猜测、不内联源码；复制候选 \`signature\`，或使用 \`path\`/\`line\` 消歧。
- 限定 owner 写错但 leaf symbol 存在时，工具先返回结构化 owner 纠正候选并跳过全仓 raw 扫描；从候选修正限定名，不得转用 Grep。
- 支持带返回类型及常见 \`const\`、\`override\`、\`final\`、\`noexcept\` 尾限定的 C/C++ 完整签名。
多个独立名称必须合并：
\`\`\`text
codegraph_search(queries=[
  {query: "ObDtlBasicChannel::attach", includeCode: "if_unique"},
  {query: "ObDtlBasicChannel::flush", includeCode: "if_unique"},
  {query: "ObVirtualChannelInfo::get_info", includeCode: "if_unique"}
])
\`\`\`
批量查询中的真正 graph miss 会合并成一次多模式 raw-source 扫描，而不是每个名称扫描一次仓库。
### 3. \`node.targets\` / \`context\` 精确混合批处理
一次调用可混合 1–8 个 target：
\`\`\`text
codegraph_node(
  targets=[
    # 精确符号
    {symbol: <符号>, file: <可选文件>, line: <可选行>, signature: <可选签名>},
    # 容器成员聚焦，members 最多 32 个
    {symbol: <类/结构体>, file: <可选文件>, members: [<成员1>, <成员2>]},
    # 精确文件中的文本锚点
    {file: <文件>, text: <字面量>, contextLines: <行数>, maxMatches: <数量>},
    # 精确文件范围
    {file: <文件>, offset: <起始行>, limit: <行数>},
    # 批量文件大纲；outlineQuery 中 | 表示 OR，也可使用 outlineQueries 数组
    {file: <文件>, symbolsOnly: true, outlineQuery: "attach|flush|send_message", outlineLimit: 30},
    # 模型冗余传入 text + 范围时会自动恢复：返回显式范围，text 仅作断言
    {file: <文件>, text: <应位于范围内的字面量>, offset: <起始行>, limit: <行数>}
  ],
  includeRelations=false
)
\`\`\`
规则：
- 同一问题中已经明确的符号、成员、文本锚点和 file regions 必须尽量合并到一次 \`codegraph_node(targets=[...])\`；\`codegraph_context(targets=[...])\` 是等价入口。
- C++ \`members\` 会尽量同时返回头文件声明和同一 callable owner 的 \`.cpp\` out-of-line 定义，并附最近的 \`public/protected/private\` 标签、注释和少量相邻行，供直接编辑；不要为确认访问域再读整个头文件。
- 同文件重叠或相邻范围会自动合并、去重；不要手工分页或重复请求重叠窗口。
- 批量 \`targets\` 只接受精确目标，不接受自然语言任务描述；不确定名称时先用 \`search\` 或文件大纲。
- 默认 \`includeRelations=false\`；只有确实需要关系轨迹时才开启。
- 多窗口是否预检只按字符预算决定：即使总行数较多，只要渲染结果不超过 20K 字符就直接返回；超过预算的非 manifest 请求才在输出源码前预检。
### 4. \`node\` 模式与自动纠正
\`codegraph_node\` 只使用以下模式：
\`\`\`text
# 符号源码
codegraph_node(symbol=..., file=可选, line=可选, includeCode=true, includeRelations=false)
# 文件符号大纲
codegraph_node(file=..., symbolsOnly=true, outlineQuery=可选, outlineLimit<=30)
# 单个精确文件窗口
codegraph_node(file=..., offset=..., limit<=500)
# 1–8 个精确目标的原生批量 implementation bundle
codegraph_node(
  targets=[
    {symbol: <符号>, file: <可选文件>, members: [<可选成员>]},
    {file: <文件>, symbols: [<符号1>, <符号2>], texts: [<字面量1>]}
  ],
  includeRelations=false
)
\`\`\`
禁止：
- 混用 \`symbol\` 与 \`offset\`/\`limit\`；
- 在文件模式传 \`includeCode=true\`；
- 裸调用 \`codegraph_node(file=<文件>)\`；
- 按 \`offset\` 连续翻页读取文件。
工具会自动处理常见参数偏差：
- 符号大小写不一致时，尝试大小写不敏感的精确纠正；仍有多个候选时保持歧义，不猜测。
- \`node\` 单文件窗口和 \`node.targets\`/\`context\` region 超过 500 行时自动截断到 500；输出仍受字符预算约束，不需要先失败再重试。
- target 同时包含 \`file + text + offset + limit\` 时不再报参数冲突：显式窗口优先返回，\`text\` 只验证锚点是否位于该窗口，并在标签中报告命中/未命中。
- \`search.query\`、\`context.symbol\` 和关系工具的 \`symbol\` 可直接接收 callable signature。
- \`search.includeCode\` 多余的首尾引号会自动纠正；\`node(file=..., outlineQuery/outlineLimit=...)\` 会自动推断 \`symbolsOnly=true\`。
- \`node.targets\` 文件大纲支持 \`symbolsOnly\`、\`outlineQuery="a|b"\`、\`outlineQueries=["a", "b"]\` 和逐文件 \`outlineLimit\`，无需拆成多次大纲调用。
自动截断只是防失败兜底；已知更小边界时仍应请求最小范围。多个范围或范围与符号混合时使用一次 \`node.targets\`（或等价的 \`context.targets\`）。
### 5. 关系查询
对可能重载/同名的符号，为 \`callers\`、\`callees\`、\`impact\` 传入 \`file\` + \`line\` 或 \`signature\`。关系工具不会聚合不同逻辑重载；仍有歧义时只返回精确候选，不执行遍历。
对已经精确消歧的 C++ 虚函数/override，\`codegraph_callers\` 会沿索引中的 virtual-dispatch family 聚合基类声明和派生实现两端的调用方；若结果提示已扩展 dispatch family，不要再用 Grep 搜基类调用。
结果足以支持当前判断时立即停止，不要打开全部调用链节点，也不要用 \`grep\` 复核。
### 6. \`text_search\` 与原生工具回退
- 不知道精确文件的宏、注册字符串、表名、日志文本：把多个字面量合并到一次 \`codegraph_text_search\`，\`path\` 使用最窄源码目录，不得使用仓库根目录。
- 已知精确文件且还需要符号/范围：将 \`{file, text}\` 合并进一次 \`node.targets\`（或等价的 \`context.targets\`），不要额外调用 \`text_search\`。
- 生成文件默认跳过；但当 \`path\` 精确指向单个生成文件时会自动纳入。目录级搜索生成产物时才显式传 \`includeGenerated=true\`。
- 修改 inner-table schema 时，\`ob_inner_table_schema_def.py\` 是事实来源，生成的 \`ob_inner_table_schema.*.cpp\` 是校验目标。一次 \`node.targets\` 同时取得 definition 的精确文本区域和生成函数/尾部锚点；禁止按窗口翻页生成文件。修改 \`.py\` 后应在 \`src/share/inner_table\` 按脚本说明运行 \`python2.6 generate_inner_table_schema.py\`，再编译/测试验证；只有生成器不可用时才允许手改生成产物，并明确说明原因。
- \`CONFIRMED_ABSENT\` 表示完整当前源码范围确认不存在；\`DECLARATION_ONLY\` 表示精确 overload 只有声明、没有配对的索引定义，并已附完整标识符出现证据；\`RAW_MATCHES\` 已附 grep 等价证据。三者均不得再用 Grep 重复复核；只有 \`INCONCLUSIVE\` 才需要缩窄范围重试。
仅在以下情况使用 \`grep\`、\`glob\` 或 \`Read\`：
1. 文件未被索引；
2. pending-sync/stale 提示明确点名该文件（stale 只作用于列出的文件）；
3. 大小写纠正、完整签名、\`file\`/\`line\` 消歧后精确符号仍失败；
4. 最窄 \`path\` 的 \`text_search\` 仍失败，或内容不在已索引源码中；
5. 配置、文档或 Markdown；
6. 修改后读取尚未同步的当前源码。
回退前必须说明：\`codegraph 回退原因：<条件和证据>\`。禁止用原生工具复核非空的 codegraph 结果。
### 7. 信息充分与停止条件
不存在固定的 codegraph 调用次数、首个 Edit 时点或“每文件一个窗口”限制。开始修改前应拿到任务实际需要的充分信息：待修改源码/结构、相关直接关系、精确编辑位置和必要测试/注册点。
信息充分后停止重复探索。不得为了“更完整”而预防性读取无关文件、全部调用方/被调用方或相邻实现；codegraph 已返回的源码视为已读。
### 8. 正反例
#### 唯一符号：合并 \`search → node\`
正确：
\`\`\`text
codegraph_search(
  query="ObAllVirtualDtlChannel::get_row(ObVirtualChannelInfo &channel, ObNewRow *&row)",
  includeCode="if_unique"
)
\`\`\`
错误：
\`\`\`text
codegraph_search(query="get_row")
codegraph_node(symbol="get_row", includeCode=true)
\`\`\`
原因：无论搜索是否已唯一，都固定执行第二次调用。
#### 同一 C++ 类的多个成员：一次 member focus
正确：
\`\`\`text
codegraph_node(
  targets=[{
    symbol: "ObDtlBasicChannel",
    file: "src/sql/dtl/ob_dtl_basic_channel.h",
    members: ["attach", "flush", "send_message", "push_back_send_list"]
  }],
  includeRelations=false
)
\`\`\`
错误：对四个成员循环四次单目标 \`codegraph_node\`。
#### 符号、文本锚点和编辑边界：一次混合 context
正确：
\`\`\`text
codegraph_node(
  targets=[
    {symbol: "ObAllVirtualDtlChannel::get_row"},
    {symbol: "ObVirtualChannelInfo", members: ["tenant_id_", "channel_id_"]},
    {file: "src/observer/virtual_table/ob_all_virtual_dtl_channel.cpp", text: "OB_FAIL(get_row", contextLines: 12},
    {file: "src/observer/virtual_table/ob_all_virtual_dtl_channel.h", offset: <已知边界>, limit: 80}
  ],
  includeRelations=false
)
\`\`\`
错误：分别调用 \`node\`、\`text_search\`、多个重叠窗口，再用 \`Read\` 复核。
#### 只知道陌生测试文件：先获取大纲
\`\`\`text
codegraph_node(
  file="unittest/sql/dtl/<候选文件>.cpp",
  symbolsOnly=true,
  outlineQuery="TEST",
  outlineLimit=30
)
\`\`\`
从大纲选出测试符号后，使用 \`search(includeCode="if_unique")\`、\`node(symbol=...)\` 或合并到 \`context\`；不得直接 \`Read\` 整个测试文件。
#### 修改 inner-table schema：事实来源 + 生成结果一次取齐
正确：
\`\`\`text
codegraph_node(
  targets=[
    {
      file="src/share/inner_table/ob_inner_table_schema_def.py",
      text="table_name    = '__all_virtual_dtl_channel'",
      contextLines=80
    },
    {
      symbol="ObInnerTableSchema::all_virtual_dtl_channel_schema",
      file="src/share/inner_table/ob_inner_table_schema.12101_12150.cpp"
    }
  ],
  includeRelations=false
)
\`\`\`
随后只修改 \`ob_inner_table_schema_def.py\`，运行生成器并检查生成 diff。
错误：对 \`ob_inner_table_schema.*.cpp\` 连续调用多个 \`offset/limit\` 窗口，找到列尾后再手工同时维护 \`.py\` 和生成 \`.cpp\`。
${CODEGRAPH_SECTION_END}`;
