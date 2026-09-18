# 数据库路径过渡兼容

新项目的 `codegraph init` 默认创建 `<项目根>/.codegraph-wx/codegraph.db`。
CLI 命令、MCP 服务配置项、MCP 工具名和调用参数保持不变。

## 路径选择

未显式设置 `CODEGRAPH_DIR` 时，CLI、MCP 和跨项目查询使用相同规则：

| 项目状态 | 使用的数据库 |
| --- | --- |
| 新旧数据库都不存在 | 尚未初始化；`init` 在 `.codegraph-wx/` 创建新库 |
| 只有 `.codegraph-wx/codegraph.db` | 新库 |
| 只有 `.codegraph/codegraph.db` | 默认原地使用旧库，不复制、不移动 |
| 新旧数据库同时存在 | 优先使用新库 |
| 新目录存在，但里面没有数据库；旧库存在 | 默认使用旧库 |
| 新库存在但打不开或已损坏 | 报告新库错误，不自动切换到旧库 |

兼容开启时，只有旧库的项目仍属于“已初始化”：再次运行 `init` 不会额外建立一份新索引。
原有的 `query`、`sync`、文件监听和 MCP 查询继续操作旧库。锁文件和后台状态跟随实际使用的数据库目录；新旧目录使用不同通信端点，防止复用另一份索引的后台服务。

## 关闭旧路径自动兼容

环境变量 **`CODEGRAPH_LEGACY_COMPAT`** 默认开启。设置为 `0` 或 `false` 时关闭旧路径自动发现：

```powershell
$env:CODEGRAPH_LEGACY_COMPAT = '0'
codegraph init
```

```bash
CODEGRAPH_LEGACY_COMPAT=0 codegraph init
```

关闭兼容后，如果项目只有旧库，查询会按“未初始化”处理；`init` 会在新目录建立索引，旧库保留。
恢复默认可删除该环境变量，也可设置为 `1`。已有新库时，恢复兼容仍优先使用新库。

MCP 用户应在原来的 `codegraph` 服务配置中合并以下环境设置，保留已有的 command、args 和其他 env 项：

```json
"env": {
  "CODEGRAPH_LEGACY_COMPAT": "0"
}
```

环境变量变更后重启 MCP 客户端和仍在运行的 CodeGraph 后台服务。提醒插件运行在客户端进程中；若需它也严格遵守关闭旧路径的设置，应将同一变量传给客户端进程。

## 显式目录配置与迁移边界

已有 `CODEGRAPH_DIR` 的语义保持不变：有效的显式目录始终优先，且不会自动回退到其他目录。
`CODEGRAPH_LEGACY_COMPAT=0` 关闭的是**自动回退**；显式设置 `CODEGRAPH_DIR=.codegraph` 仍可直接选择旧目录。

本功能不自动迁移索引。可关闭兼容后重新 `init`，再按自己的流程处理旧库。关闭兼容也不会自动删除旧目录。
过渡期间仍在使用旧库的用户，仍可能与社区版共享旧数据库；切换到新库才能分开这两份索引。
