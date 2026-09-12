# 原文兜底独立 worker：修复与验证

2026-09-11，基于 `c06ed32` 完成本次修改。范围是用户选择的“将原文兜底放入独立 worker”。

## 修复后的行为

原文证据函数将文件清单快照和查询条件交给独立 worker。范围筛选、文件枚举、ripgrep 启动、stdout 消费、超时判断、结果解析以及 Node 补扫全部在 worker 执行。主线程接收已经确定的扫描结果，不会因为消息晚到而重新将结果判为超时。

默认 8 秒现在明确是 **worker 实际扫描预算**，不包含主线程读取索引清单、等待 worker 空位、线程启动及结果交付时间。主线程的长数据库查询仍可能推迟 MCP 回复；这次修复保证扫描结果不会因此被错误地改成超时，没有优化数据库查询本身。

接口的返回结构和缓存语义保留：缓存仍由主线程基于 watcher、pending files 和索引 epoch 管理。worker 不接收 CodeGraph 对象，不打开 SQLite，不复制数据库，也不共享数据库连接。

## 实现

- `src/mcp/raw-source-evidence.ts`：保留入口和缓存，将实际扫描拆为接收纯数据的 `scanRawSourceSnapshot`，由 worker 调用；主线程入口只提交紧凑的 `{path, size}` 文件清单。
- `src/mcp/raw-source-types.ts`：定义可序列化任务、结果和进度消息，保留原始查询和报告字段。
- `src/mcp/raw-source-worker.ts`：独立管理扫描和取消，子进程结束并完成结果处理后关闭线程。
- `src/mcp/raw-source-worker-client.ts`：每个进程最多同时运行两个扫描 worker，其他任务排队。每个 worker 执行一次扫描，完成后退出。启动或执行失败明确返回错误，不降级为主线程扫描。
- `src/index.ts`：项目关闭时取消该实例仍在运行或排队的原文扫描。

取消通过消息和共享原子标志传递；排队任务可直接移除，运行中的 rg 会被取消并等待结束。Node 补扫使用可取消的文件读取。共享控制区另外记录当前子进程 PID，使宿主进程立即退出时也能清理已启动的 rg，而不依赖忙碌主线程先收到进度消息。

构建后的 `dist/mcp/raw-source-worker.js` 随现有 dist 发布流程一起打包。只有源码模式测试使用 TypeScript 引导加载器，发布包运行不需要 TypeScript 开发依赖。

## MAME 真实 MCP 并发复测

复用此前的只读 MAME 索引，1,614,524 节点、23,340 个原文证据范围内的文件。请求 A 仍为用户提供的两个 `LICENSE_...` 标识符，请求 B 仍为八个不存在符号的真实数据库查询，预算保持默认值 8 秒。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 两个客户端共享 daemon，在内容搜索阶段并发 | 错误超时，`0/23340` | 完整扫描 23,340 文件，`timeBudgetReached=false` |
| 同一 stdio 连接，在文件枚举阶段并发 | 超时，`0/23340` | 完整扫描 23,340 文件，`timeBudgetReached=false` |

修复后实测：

| 指标 | 共享 daemon | 同一 stdio 连接 |
| --- | ---: | ---: |
| worker 内 rg 枚举耗时 | 170 ms | 186 ms |
| worker 内 rg 内容搜索耗时 | 764 ms | 912 ms |
| MCP ping 延迟 | 17.778 秒 | 17.720 秒 |
| A 的总响应时间 | 22.844 秒 | 22.590 秒 |
| A 的最终结果 | 两个 `CONFIRMED_ABSENT` | 两个 `CONFIRMED_ABSENT` |

这些时间证明主线程即使长时间不能处理消息，worker 仍能完成扫描并保留成功结果。**总响应时间不是本次优化目标，不应把这组数据解读成查询加速收益。** stdio 复测期间还运行了生命周期测试，不将与历史基线的总耗时差异归因于代码性能变化。

结果保存在：

- `bench-logs/mcp-search-concurrency-1789128664819/`：共享 daemon 的内容搜索阶段复测。
- `bench-logs/mcp-search-concurrency-1789128786311/`：同一连接的枚举阶段复测。

复现脚本增加了对 worker 进度消息的观察，保留原先对旧版主线程 rg 的观察路径；只调整计时位置，不修改扫描行为。增加 `--expect-success` 后，目标返回 `INCONCLUSIVE` 会使脚本失败。

```powershell
npm run build
node scripts/repro-mcp-search-concurrency.cjs --daemon-test --trigger search --rounds 1 --expect-success
node scripts/repro-mcp-search-concurrency.cjs --trigger inventory --rounds 1 --expect-success
```

## 测试

新增 `__tests__/raw-source-worker.test.ts`，8 项均通过：

- 主线程阻塞时间超过扫描预算，worker 已完成的结果仍然成功。
- worker 自身的预算耗尽仍返回 `INCONCLUSIVE`。
- 活跃扫描取消后，已启动的子进程结束再返回。
- 排队任务取消不启动 worker，后续任务仍能执行。
- 项目关闭取消它拥有的运行及排队任务。
- worker 错误明确传播，槽位可复用。
- rg 无法启动时在 worker 内进行 Node 补扫。
- 宿主直接退出时清理已知 rg 子进程。

相关测试共 122 项通过：原文 worker 8、批量上下文 73、搜索语义 15、请求取消 1、daemon 9、启动同步 gate 8、staleness banner 5、初始化 3。最终代码另复跑了原文、预算、缓存和取消相关选择集。

初始化测试第一次运行时，3 项在 Windows 删除子进程工作目录时失败，业务断言没有失败。原清理逻辑发出 SIGKILL 后立即删除目录；现改为关闭 stdin、等待进程及其 stdio 结束后清理，并保留强制退出后备。单独重跑 3 项通过。

`npm run build`、测试脚本语法检查和 `git diff --check` 通过。原 MAME 数据库仍为 5,246,017,536 字节，修改时间保持 2026-09-10 01:17:11。

## 范围边界

这次没有修改符号数据库搜索算法，也没有实施此前提出的 GBK 解码或真实超时进度展示修复。真实扫描超过预算时仍按原语义返回不完整结果。本地 Windows 已完成真实 MCP 验证，尚未在用户的远端 Linux 项目中部署或实跑修复版。
