# 本机共享常驻 MCP 服务（首版）

已有 `codegraph serve --mcp` 的默认行为保持不变。新模式需要主动启用：Agent 和 Python 各有独立的 stdio 代理与 MCP 会话，连接同一项目的常驻 daemon，共享图谱引擎。它们不共享同一条 stdin 管道。

本机模式不开放 HTTP 或网络端口，不安装系统服务，不提供开机自启；机器重启后需再次启动。切换模式不改变索引格式，也不要求重建索引。

## 启动、查看、停止

在已经初始化的项目中使用：

```bash
codegraph service start --path /absolute/project
codegraph service status --path /absolute/project
codegraph service stop --path /absolute/project
```

路径省略时使用当前目录。三个命令都支持 `--json`；`service start --no-watch` 可禁用该服务的文件监听。文件监听设置属于服务进程，后来连接的客户端不会改变它。`--no-watch` 不应被理解为所有索引检查或首次初始化工作都被关闭。

启动成功表示服务已开始监听；首次客户端调用仍可能需要等待图谱加载，并不表示所有索引检查已经完成。

服务启动后，最后一个客户端退出不会触发空闲回收，需由维护者主动停止。`stop` 会停止接收工作、关闭客户端并等待引擎排空，**所有连接该项目服务的客户端都会断开**，不是只停止当前客户端。停止前请确认其他使用者不再需要它。

如果同一项目已有普通自动回收 daemon，`start` 不会悄悄替换或改造它。请先退出正在使用该 daemon 的 Agent/脚本，确认影响后显式 `service stop`，再启动常驻服务。较旧版本的 daemon 不支持新的身份握手，`service stop` 会拒绝管理它；此时应退出其原有客户端并等待旧版空闲退出，或通过原有启动器停止，再启动新服务。

状态查询会核对实际连接，不只看 PID 文件；连接/身份异常应先排查，不能盲目删除锁或结束 PID。

## Agent 配置

在需要保证共享的 Agent 中，将原有命令参数改为：

```json
{
  "command": "codegraph",
  "args": ["serve", "--mcp", "--path", "/absolute/project", "--shared-required"]
}
```

`--shared-required` 要求同时提供 `--mcp` 和明确的项目路径。它仅连接已经运行的常驻服务，服务不存在或不兼容时会失败，**不会自动启动服务或回退为独立引擎**。路径要指向与服务一致的项目。

未使用 `--shared-required` 的现有配置保持原来的启动、共享、自动回收及独立引擎回退规则。需要严格保证 Agent 与脚本共用时，两边都使用这个选项。

## Python 示例

安装标准 Python MCP SDK，然后运行随包提供的 `scripts/examples/shared_mcp_client.py`：

```bash
python -m pip install mcp
codegraph service start --path /absolute/project
python scripts/examples/shared_mcp_client.py /absolute/project
```

脚本通过标准 MCP stdio 客户端启动轻量代理，并实际调用 `status`。脚本结束后代理退出，常驻服务继续运行；后续脚本可连接同一服务。可通过 `--command` 指定实际 CodeGraph 可执行文件路径。

仅得到 `tools/list` 不能证明共享已成功；验证时应实际调用工具，并对照 `service status` 的项目、模式与 PID。不同项目应启动各自的服务。

## 兼容边界

首版面向本机使用；Windows 命名管道与 Linux/macOS Unix socket 复用已有机制，当前尚未完成 Windows 实机验收，不承诺其命名管道权限与 Unix socket 完全等效。平台实际验收范围以本次发布记录为准。服务不是网络认证网关，不提供远程多用户权限模型。

升级代码包后应在停止现有客户端并确认无工作进行时重启服务，避免让旧服务长期运行。不要用更改 PID 文件或内部环境变量的方式管理服务。
