# wx 与社区版共存

wx 保留 `codegraph init/query/sync/serve/install` 等 CLI 用法和 MCP 工具的名称、参数。运行数据改为以下独立位置：

| 项目 | wx 行为 |
| --- | --- |
| 索引目录 | 项目内 `.codegraph-wx/`，不自动发现或导入旧 `.codegraph/` |
| 数据库与索引锁 | `.codegraph-wx/codegraph.db`、`.codegraph-wx/codegraph.lock` |
| 后台状态 | `.codegraph-wx/daemon.pid`、`daemon.log`；管道/socket 按 wx 身份和实际数据目录生成 |
| MCP 配置项 | `codegraph_wx`；启动命令绑定安装器所在 wx 包的 CLI 和 Node 绝对路径 |
| 自动刷新 | 新生成的 Git hooks 固定调用 wx，使用独立的 wx 标记 |
| 提示与权限 | 使用 wx 数据目录、MCP 服务前缀、提示块标记及提醒插件文件名 |

目录专用排除只覆盖 wx 默认目录、wx 目录变体和当前自定义数据目录。社区版目录按普通 `.gitignore`、`.codegraphignore` 等规则处理。`.codegraphignore` 文件名和已有环境变量名保持不变。

## 存量用户升级

1. 升级 wx 包后，使用确定属于 wx 的入口运行 `codegraph install`，重启 MCP 客户端。仅更新 npm 包不会自动重写客户端配置。
2. 在业务项目内运行 `codegraph init` 建立新索引，或按下节手动导入。
3. 使用 Git 自动刷新 hooks 的项目，在项目内执行 `codegraph install --location=local`，会更新已有的新旧 CodeGraph 标记块。新 hooks 只刷新 wx 索引。

### 安装器的清理规则

当前启用的 OpenCode、CodeAgent、Claude Code、Gemini 安装器按固定名称和标记维护配置。标记内或固定名称下的用户修改也会被替换：

| 配置 | 安装时的处理 |
| --- | --- |
| 提示词 | 清理所有完整的 `CODEGRAPH_START/END` 和 `CODEGRAPH_WX_START/END` 块，在第一个块的位置写入一份 WX 提示；没有标记时追加。块外文字保持原样 |
| MCP | 删除 `codegraph`、`codegraph_wx` 服务项，再生成一份标准 `codegraph_wx`；这两个键内的自定义参数、环境变量、开关会重置 |
| 提醒插件 | 清理指定插件目录中的 `codegraph-reminder.js/.ts`，重写 `codegraph-wx-reminder.js/.ts`；其他目录里的同名文件不受影响 |
| 扩展注册 | 按客户端对应作用域解析完整路径，移除新旧提醒扩展的注册，添加一份标准 WX 注册 |
| 权限 | 清理 allow 中的 `mcp__codegraph__*`、`mcp__codegraph_wx__*`；仅选择自动允许时添加 WX allow。保留其他权限 |
| 旧客户端 hooks | 清理旧安装器的 `mark-dirty`、`sync-if-dirty` 命令，保留同组其他 hook；这些废弃命令不会重新添加 |
| Git hooks | 本地安装更新已有新旧 CodeGraph 标记块，不额外启用其他 hook；块外命令保持原样 |

`codegraph` 和 `codegraph_wx` 是安装器维护的服务名。需要让社区版 MCP 同时存在时，请用独立名称（例如 `codegraph_community`）配置社区版，并绑定社区版入口。

安装器先在内存中生成该客户端全部文件的最终内容，验证通过后备份到 `~/.codegraph-wx/install-backups/<批次>/`。`manifest.json` 记录原文件路径和对应 `.bak` 文件；原本不存在的文件记录为 `backup: null`。备份不位于客户端自动加载目录中。重复安装内容相同时不写文件，也不新增备份。

JSON/JSONC 无法解析、标记缺失或交叉时，该客户端的配置保持原样，并报告具体错误。写入中发生错误会尝试回滚该客户端本批次的改动；若检测到客户端同时保存文件，则保留它的新内容并报告备份位置。各客户端独立处理，错误不会导致其他客户端被静默跳过。重新运行安装器后重启客户端。

社区版项目索引不会被 wx 的 `uninit` 删除。安装器不会自动导入旧数据库。

## 手动导入索引

- 最稳妥的方式是直接由 wx 重新 `init`，无需使用旧库。
- 需要保留已有索引时，先停止使用源数据库的 CLI、MCP 客户端和后台服务。确保 SQLite WAL 已正常写回，或通过 SQLite 的一致性备份生成快照；不能在源库仍被写入时只复制 `.db` 文件。
- 把确认完整的数据库副本放到 `.codegraph-wx/codegraph.db`。不要复制 `daemon.pid`、socket、`codegraph.lock` 等运行状态文件，也不要把两个目录链接到同一份数据库。
- 导入后运行 wx 的 `codegraph status` 和 `codegraph sync`。语言范围变化可能触发完整重建；来源版本的数据库若不兼容，应在 wx 目录重新初始化。

## 同名 CLI 的边界

两个 npm 包都提供 `codegraph` 时，同名入口的实际指向取决于安装方式和 PATH。Windows 可用 `Get-Command codegraph -All` 检查入口；再检查该入口实际引用的包路径。安装、升级或卸载社区版之后，同名入口可能变化。

MCP 和新 hooks 直接绑定 wx 包内脚本，避免通过这个共享入口选择版本。需要确定手动命令属于 wx 时，可使用：

```text
node <wx安装目录>/dist/bin/codegraph.js query <符号名>
```

如果移动 wx 安装目录或 Node 安装位置，需要重新运行安装器并更新 Git hooks。

`CODEGRAPH_DIR` 仍支持自定义项目内目录。双版本共存时应为 wx 设置独立目录；显式把它设置成社区版目录，会重新共享数据库，失去目录隔离。
