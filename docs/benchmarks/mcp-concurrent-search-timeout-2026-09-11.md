# MCP 并发查询导致 ripgrep 兜底伪超时：真实进程复现

2026-09-11，源码 `c06ed32` / 版本 `1.0.7`，Windows / Node v24.11.1。

后续已按用户要求实施独立 worker 修复，并通过相同 MCP 并发场景验收，见 [worker 修复与验证](raw-source-worker-fix-2026-09-11.md)。以下为修复前的基线复现记录。

**已验证：同一 MCP 进程中的另一条同步数据库查询，可以使已在 0.745 秒内完成的 ripgrep 被包装层报告为超时，并显示 `0/23340 files scanned`。** 同一连接的并发请求和共享 daemon 的两个独立客户端都已复现。没有缩短默认 8 秒预算，也没有通过 sleep、忙循环或伪造查询结果制造阻塞。

这验证了一条足以解释“独立调用很快，MCP 却超时”的真实代码路径。它不是对远端现场的最终归因：仍需要确认原调用发生时是否有其他请求占用了同一个 MCP 进程。

## 输入与隔离条件

- 项目：`D:\c_proj\mame`，提交 `57cf29e2c75e24ac168d35a418cbd6d26113088e`。
- 索引：`bench-logs/mame-init-20260909/fork-macro-context/codegraph.db`，1,614,524 节点，23,380 文件，639,529 个不同符号名。
- 索引只读打开；不修改 MAME 源码，不执行同步。关闭 watcher 和启动 catch-up，证明并发查询本身足以触发问题；本记录没有将后台同步称为已验证原因。
- 显式使用默认预算值 `CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS=8000`。
- 请求 A：一次 batch 查询用户提供的两个符号：
  - `LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ`
  - `LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ`
- 请求 B：一次合法的 8 符号 batch，查询 `CG_CONCURRENCY_MISSING_SYMBOL_1_8F31` 至 `CG_CONCURRENCY_MISSING_SYMBOL_8_8F31`。这些符号不存在，走当前产品的大小写纠正及模糊搜索链。
- 观察 A 的真实 rg 子进程启动事件后，客户端发送 B，让两次调用确实重叠。这控制的是请求抵达时机，不修改搜索实现和结果。
- 同时在另一个 Node 进程运行 A 的原文兜底作为对照，并向正在测试的 MCP 发送轻量 `ping`。

stdio 组使用真实 `dist/bin/codegraph.js serve --mcp`。daemon 组使用真实 `Daemon`、`MCPEngine`、`MCPSession`、`SocketTransport` 以及生产 `connectWithHello` 握手函数，两个独立连接共享 engine。仅将 socket/pid 路径隔离到本测试范围；未使用或干扰用户已有 daemon。握手完成后才开始计时。

## 实测结果

| 模式 / 场景 | A 的 MCP 总耗时 | A 的结果 | 同期独立原文兜底 | MCP ping 延迟 |
| --- | ---: | --- | ---: | ---: |
| stdio，串行对照 | 4.585 秒 | 完整扫描，0 命中 | — | — |
| stdio，同一连接并发，枚举阶段重叠，第 1 次 | 17.217 秒 | 超时，`0/23340` | 1.067 秒，成功 | 13.619 秒 |
| stdio，同一连接并发，枚举阶段重叠，第 2 次 | 17.175 秒 | 超时，`0/23340` | 1.059 秒，成功 | 13.521 秒 |
| stdio，并发结束后的串行对照 | 4.364 秒 | 完整扫描，0 命中 | — | — |
| daemon，两客户端并发，内容搜索阶段重叠，第 1 次 | 18.207 秒 | 超时，`0/23340` | 0.991 秒，成功 | 13.927 秒 |
| daemon，两客户端并发，内容搜索阶段重叠，第 2 次 | 16.840 秒 | 超时，`0/23340` | 1.069 秒，成功 | 13.124 秒 |

两次 daemon 实验各自还有前后串行对照，均成功：第一次 4.570 / 4.500 秒，第二次 4.497 / 4.217 秒。并发结束后同一个进程恢复正常，不需要重建索引或重新启动来恢复。

所有超时请求均返回与用户现场相同的结构：

```text
Raw-source scan incomplete for `LICENSE_SMART_SCHEDULE_ADAPTIVE_QQ`
(INCONCLUSIVE: time budget reached; 0/23340 files scanned). Absence is not proven.

Raw-source scan incomplete for `LICENSE_INTRA_SITE_RESOURCE_PRECISE_ORCHESTRA_AJ`
(INCONCLUSIVE: time budget reached; 0/23340 files scanned). Absence is not proven.
```

## 关键证据：rg 自己报告只用了 0.745 秒

第二次 daemon 实验记录了实际 rg stdout 的完整 JSON `summary`，而不只是在 Node 的 `close` 回调里计时。A 的内容搜索进程输出：

```json
{
  "elapsed_total": { "human": "0.744531s", "nanos": 744531300, "secs": 0 },
  "stats": {
    "bytes_printed": 0,
    "bytes_searched": 555415002,
    "matched_lines": 0,
    "matches": 0,
    "searches": 23376,
    "searches_with_match": 0
  }
}
```

该子进程最后的退出码为 **1**（正常的无匹配），`signal=null`。但是 CodeGraph 报告 `timeBudgetReached=true`、扫描文件数为 0。

rg 按实际 glob 范围搜索了 23,376 文件；CodeGraph 的源码证据统计范围是其中 23,340 个索引文件，所以两个完整计数略有不同。这与“进度为零”的错误无关。

### 同一次调用的时间线

以下均相对于请求 A 抵达 MCP 的时刻：

| 时刻 | 事件 |
| --- | --- |
| 0 秒 | A 开始数据库查询 |
| 3.337 秒 | A 进入源码证据函数，开始独立的 8 秒预算 |
| 3.393 秒 | A 启动 `rg --files` |
| 3.548 秒 | A 的枚举成功结束，收到 904,780 字节文件列表 |
| 3.595 秒 | A 启动 `rg --json`；随后另一个客户端的请求 B 开始数据库查询 |
| 约 4.34 秒 | 根据 rg 自报的 0.744531 秒运行耗时，A 的内容扫描已经完成；这是由子进程内部计时推算的完成时点 |
| 16.775 秒 | B 的同步查询完成并进入自己的原文兜底 |
| 16.838 秒 | MCP 事件循环恢复，测到约 13.192 秒的事件循环延迟；A 的超时回调执行 `child.kill()`，此刻主线程尚未处理 A 的 stdout |
| 16.839 秒 | A 的 `close` 和 278 字节 stdout 被处理，退出码 1、无终止信号；观察钩子解析到了上述成功完成的 summary |
| 16.839 秒 | 包装层仍以 `timeout=true, files=0` 完成 A 的原文证据结果 |

同一时段的 `ping` 延迟约 13.124 秒，独立进程的相同源码扫描约 1.069 秒成功。结合 rg 自身的运行时间，可以将这次超时定位为 MCP 主线程处理延迟，而不是磁盘扫描实际花了十几秒。

## 因果链和代码位置

1. **请求可以重叠。** `src/mcp/transport.ts:285` 的 stdio `line` 回调是异步回调，但 EventEmitter 不会等上一次回调完成；socket 路径在 355 行明确不等待 `handleLine`。这是协议层允许并发的行为。
2. **不同客户端也共享同一 engine。** `src/mcp/daemon.ts:150` 创建一个 `MCPEngine`，270 行为连接创建 session 时传入同一个 engine。`src/mcp/session.ts:239` 将工具调用交给共享 ToolHandler，查询没有 worker 隔离或重工具准入队列。
3. **当前查询链持续阻塞事件循环。** 未命中的裸符号会执行两遍同步 FTS → LIKE → 编辑距离链。每遍读取并处理约 64 万个名字；8 符号 batch 在本机可占用主线程约 13–14 秒。函数返回 Promise 或批次内使用 `await`，不等于这些同步查询会让出事件循环给 I/O。
4. **rg 的 stdout、close 和超时回调都依赖这个主线程。** `src/mcp/raw-source-evidence.ts:318` 的 `setTimeout` 在事件循环恢复后执行；它依据过期 deadline 标记 interruption，没有获得独立线程提供的子进程完成状态。
5. **超时一旦标记，正常结果也不会挽回。** 323 行的 `if (interruption) return` 丢弃之后到达 `data` 回调的内容。后续即便收到正常退出码 1，interruption 仍保留，内容搜索的超时分支在 453 行返回零计数。

stdio 的枚举阶段实验还有另一种表现：超时回调执行时还未读取 stdout，随后 close 时观察到约 64 KiB 的缓冲输出，子进程被 SIGTERM 终止。这与父进程长时间不消费管道输出、枚举进程受背压影响的机制相符；该组没有证明枚举进程早已完成。daemon 的内容搜索组则通过正常退出和完整 summary，明确证明了已完成扫描仍被误报超时。

## 验证边界

- 已在本机证明两种真实 MCP 拓扑均能产生原错误结构，使用默认 8 秒预算，四次并发复现全部成功。
- 没有在用户的远端 Linux 项目上运行本脚本。原项目的 99,785 或 97,458 文件统计不是本机数据；不能将复现的触发条件直接认定为现场已发生的事实。
- 后台同步未参与这些成功复现。是否有同步工作造成类似阻塞，需要单独采集现场日志；本结论不依赖它。
- 这是返回 `INCONCLUSIVE` 的错误超时及进度问题，没有把它描述为该现场已发生 `CONFIRMED_ABSENT` 误判。非 UTF-8 命中解码缺陷见另一份记录，是独立问题。

## 修复方向

优先避免重查询阻塞 MCP 的 I/O 线程，并让计时与子进程状态可靠：

1. 将同步数据库搜索及 CPU 密集候选处理移入 worker，使用适合 SQLite 后端的连接隔离方式。仅给同步函数加 `async` 不会解决阻塞。
2. 短期可在共享 engine 的重工具层限制并发，避免另一条重查询覆盖正在等待 I/O 的工具。不要将全部 JSON-RPC 消息串行化，`ping`、取消和 roots 响应必须继续流动；后台同步的影响也需要独立处理。
3. 考虑由独立 worker 管理原文搜索子进程、输出读取和超时，避免主线程恢复时先执行过期定时器，把已正常结束的扫描判为失败。增加“子进程已正常完成但主线程迟处理”的回归场景。
4. 修复超时进度显示，保留可靠的已完成批次计数，并区分扫描超时与事件循环阻塞；不能用固定 `0/N` 冒充实际进度。

此前的大小写精确索引查询、重复模糊搜索消除和符号名字缓存优化会减轻阻塞，但不能替代并发及计时正确性的修复。单纯延长 8 秒也无法消除主线程饥饿。

## 复现命令和产物

```powershell
# 同一 stdio 连接：在枚举阶段重叠两个真实请求，重复两次
node scripts/repro-mcp-search-concurrency.cjs

# 两个客户端共享真实 daemon：在内容搜索阶段重叠
node scripts/repro-mcp-search-concurrency.cjs --daemon-test --trigger search --rounds 1
```

脚本也支持 `--project <源码根目录>` 与 `--database <已有索引文件>`。它依赖同目录 `repro-search-miss.cjs` 中的只读索引打开钩子。当前默认目标为本机 MAME；其他仓库上的负载时长可能不同。

- 脚本：`scripts/repro-mcp-search-concurrency.cjs`。
- stdio 两次复现：`bench-logs/mcp-search-concurrency-1789125451240/results.json`。
- daemon 第一次：`bench-logs/mcp-search-concurrency-1789125899792/results.json`。
- daemon 第二次，含 rg 内部 summary：`bench-logs/mcp-search-concurrency-1789127354800/results.json`。
- daemon 两个目录同时包含 `server.jsonl` 和 `responses.jsonl`，保存阶段事件及实际 JSON-RPC 返回。
- 两个测试脚本的 `node --check` 与 `git diff --check` 通过。测试结束后 MCP 正常退出；daemon 在两个客户端断开后自行退出。
- 过程中两次额外的 daemon 客户端握手试跑没有进入查询测量，修正测试客户端握手后才得到上述结果；未将握手试跑计入复现次数。
- 本次没有修改产品代码。
