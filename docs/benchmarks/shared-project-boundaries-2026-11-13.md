# 共享服务项目边界与客户端兼容性回归

## 范围

基线为 `39faa470500513879423f720b1673c4551ecb87f`。本组只修复：

1. 显式服务命令和严格 MCP 连接越过未初始化的嵌套 Git 工作树，误选外层服务。
2. 常驻 daemon 对所有客户端施加项目限制，影响普通 MCP 的跨项目查询。
3. Windows 项目大小写变体产生不同管道或被握手拒绝。

不修改索引算法、图谱排序、sync 策略和外部源码授权策略。

## 实现

- 保留显式 `--path`，让服务层在原始位置执行有界查找。
- 普通子目录可找到所属项目；遇到 `.git` 目录或工作树 `.git` 文件后，不再越过未初始化的项目边界。先解析路径别名，避免别名隐藏真实边界。
- `sharedRequired` 通过客户端 hello 传递，只限制选择严格模式的会话。普通客户端仍可传 `projectPath` 查询另一项目，服务常驻与否不再决定所有客户端的查询范围。
- 管道散列和服务/会话身份比较共用 Windows 大小写归一规则，POSIX 区分大小写保持不变。身份归一只用于比较和散列，不改实际文件访问路径。

## 回归证据

- 先写边界和 Windows 管道回归：基线分别出现 3 个与 1 个预期失败，修复后通过。
- 最终构建成功；以下 7 个套件共 **43 项通过**：
  - `service-project-boundaries.test.ts`
  - `service-windows-identity.test.ts`
  - `service-session-windows.test.ts`
  - `service-session-routing.test.ts`
  - `shared-service-probe.test.ts`
  - `daemon-client-liveness.test.ts`
  - `daemon-handshake-buffering.test.ts`
- 用真实 `git worktree add` 创建嵌套工作树，外层有索引、内层无索引。修复前实际 CLI `service stop` 和严格 `serve` 都尝试连接外层 socket；修复后均退出 1，提示 `No initialized CodeGraph project found`，连接前即停止。
- 普通子目录和内层建立自身索引后的归属控制实验通过；目录软链接别名不再绕过工作树边界。
- 用真实 TCP 字节传输驱动生产 `Daemon`、`MCPSession`、`MCPEngine` 和两个真实小 C 项目索引：普通客户端成功查到 B 的函数，严格客户端拒绝 B（-32602），仍可查询 A。精确基线在同一测试中返回 -32602，修复版通过。TCP 仅为隔离测试载体，产品仍使用本机 socket/命名管道，并未新增网络服务。

## 未完成的验证

- 当前 Linux 环境拒绝 Unix socket 创建/连接（`EPERM`）。新增真实 CLI 生命周期测试的 2 个 Linux 用例在服务启动阶段受阻，未到业务断言。不能把它们计为通过，也不能据 TCP 诊断宣称已验证外层真实 daemon PID 与客户端在 `service stop` 后保持存活。
- Windows 没有可用实机。大小写逻辑与会话校验在 Linux 上通过平台分支/受控发现测试；原生 Windows 管道共享、磁盘大小写行为仍需实机 CI。
- 原生平台端到端测试已加入 `shared-service.test.ts`：嵌套停止隔离、普通/严格会话共存、Windows 路径和 rootUri 大小写共享。需在支持 IPC 的 Linux 和 Windows 上继续执行。
- 本次不是完整仓库全套回归，不以 43 项定向测试代表发布验收。

## 复跑

```bash
npm run build
node --liftoff-only node_modules/vitest/vitest.mjs run \
  __tests__/service-project-boundaries.test.ts \
  __tests__/service-windows-identity.test.ts \
  __tests__/service-session-windows.test.ts \
  __tests__/service-session-routing.test.ts \
  __tests__/shared-service-probe.test.ts \
  __tests__/daemon-client-liveness.test.ts \
  __tests__/daemon-handshake-buffering.test.ts --maxWorkers=1 --minWorkers=1

# 原生 IPC 环境
node --liftoff-only node_modules/vitest/vitest.mjs run \
  __tests__/shared-service.test.ts --maxWorkers=1 --minWorkers=1
```

升级后应先用原版本停止旧 daemon，再启动新版本；Windows 归一后的管道名可能与旧版本不同。
