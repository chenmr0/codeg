# 全局宏上下文：细分计时与 Rust 原型

本轮针对 `macroScan`，不是 tree-sitter 解析器，也不替换已验收的 Rust 目录扫描器。

## 当前状态

- 2026-09-06，用户在 EulerOS 2.0 SP15 x64 / Node 22.21.1 上完成 HERT_BBU 真机验证：30743 个相关文件、530963452 字节，三轮宏上下文中位数 TS 7267.175ms → Rust 3210.591ms，减少 55.8%；逐文件 verify 通过，全部上下文哈希一致。807 个特殊文件走 TS 回退、读取错误为 0。这是该项目的宏上下文等价性和性能证据，不是所有 Linux 场景或完整数据库图的等价性证明。
- 同一新增两文件场景的用户日志显示完整命令由 13.176 秒降至 7.623 秒；该项是前后单次日志对比，不是三轮 A/B。新日志同时将收尾瓶颈定位到 `changedRefsMs=2010ms`，后续单独优化，不与宏扫描混为一项。
- 普通 `codegraph sync -v` 自动显示新的宏上下文细分计时；宏扫描仍默认使用 TS。
- 目录扫描器原来的自动启用规则保持不变，可以同时出现 `scan-detail mode=rust` 和 `macro-detail mode=ts`。
- 新 Rust 宏扫描器为独立的 `codegraph-macros` 程序，Windows / Linux x64 预编译候选产物与目录扫描器分开。新二进制不能沿用此前目录扫描器的验收结论。
- 没有持久化缓存、数据库结构变更、tree-sitter 语法更新或宏冲突规则修改；现有数据库可以继续使用，不需要重新 init。
- 原型保留 TS 宏收集的现有行为，包括三套扫描器并不完全一致的匹配细节，不在性能移植中夹带语义修复。

## 运行方式

```bash
# 默认 TS 宏扫描；Rust 目录扫描仍可自动启用
codegraph sync -v

# 显式启用新宏扫描原型
CODEGRAPH_RUST_MACROS=1 codegraph sync -v

# 逐文件双跑对比，使用 TS 结果；这是验证模式，不用于测速
CODEGRAPH_RUST_MACROS=verify codegraph sync -v
```

`CODEGRAPH_RUST_MACROS` 未设置、`0` 或 `auto` 都不会开启原型。只在需要构建 C/C++/ObjC 上下文时调用；空同步不启动宏扫描器。

`CODEGRAPH_RUST_MACROS_WORKERS=1..8` 可控制 I/O 工作线程，默认 4；非法值回到默认值。`CODEGRAPH_RUST_MACROS_TIMEOUT_MS=100..120000` 控制整次辅助进程的超时，默认 60000ms。可用 `CODEGRAPH_RUST_MACROS_PATH` 指定开发候选程序。验证模式的时限也包含等待 TS 对照的时间。

## 不改数据库的实际项目验收

在已安装的新候选包目录执行：

```bash
cd "$(npm root -g)/@sdd/codegraph-wx"
node scripts/benchmark-macro-context.mjs /usr1/518C10/HERT_BBU 3
```

脚本仅枚举并读取源码，不打开 CodeGraph 数据库，不运行 sync，不修改业务文件。三轮交替 TS/Rust 顺序，每个样本使用独立 Node 进程，避免同一进程的堆/GC/JIT 状态影响另一方案；计时不包含进程启动和目录枚举。要求最终宏集合、定义及顺序哈希相同；末尾再做逐文件对比。源码在测试期间应保持不变。脚本只输出数量、耗时和哈希，不输出源码或宏定义内容。缺少辅助程序、执行失败、结果不一致时以非零状态退出，不把 TS 回退当成 Rust 性能结果。

测速后，再用显式开启宏原型的 sync 验证真实新增文件场景。对图结果应比较符号名称、类型、位置、签名和边，不能只比较节点数量。上述 EulerOS 实测来自用户返回的真机输出；其他平台或重编译后的新程序仍需各自验收，交叉编译成功不等于运行通过。

## 计时口径

`macro-detail`：

- `files/readFiles/readErrors/bytes`：相关源文件数、成功/失败读取数、成功贡献的源文件字节数，不代表物理磁盘读流量。
- `readWallMs`：TS 批次读取的墙钟时间，包含路径检查和 UTF-8 解码；原生模式下只含回退文件的 TS 读取。
- `namesMs/bodylessMs/definitionsMs`：TS 三个扫描阶段；原生模式下只含回退文件，在 verify 模式下含全部 TS 对照。
- `mergeMs`：收集贡献及沿用原规则筛选无歧义宏定义。
- `nativeReadSumMs/nativeScanSumMs`：Rust 多个线程的文件读取、扫描时间之和，可能大于整体墙钟时间，不能相加推算总耗时。
- `nativeWallMs`：整个流式原生处理区间，包含 Node 解码、合并、TS 回退或验证，与其他字段可能重叠。
- `totalMs`：完整上下文构建墙钟时间，A/B 应比较这个值。
- `mode=rust/verify/fallback/ts`、`reason`、`fallbackFiles`：实际路径及回退情况。异常后丢弃整个未完成原生上下文，再从 TS 重建。

`tail-detail` 记录提取结束之后的连续墙钟区间：准备与 WAL、后处理、变更文件引用、恢复引用、失败引用重试、关联文件重索引、孤立引用与关系补全、链式调用、数据库维护、最终状态及清理。`failed-ref-retry planMs` 是查询规划耗时，原有 `durationMs` 仍表示执行循环时间。两者不再混淆。

## 正确性与资源边界

- 使用本轮相同的文件清单，保持文件和定义顺序；原来的 `selectUnambiguousCppMacroDefinitions` 在 TS 端执行。
- 无数据库写入、跨轮缓存或源码改写；每次重新读取全局上下文。删除文件、读取失败不会被记成永久的“空宏缓存”。
- 1 个进程、默认 4 个长期工作线程，有背压的有界通道；单文件 8 MiB、单文件宏记录数 100000、响应单行 32 MiB、请求 8 MiB / 250000 路径上限。超限文件走 TS，不截断后声称成功。
- 复杂跨行宏头、某些块注释尾部、特殊空白、无效 UTF-8 等走逐文件 TS 回退。普通中文注释、字符串及路径不因非 ASCII 内容一概退出。
- 缺失程序、超时、崩溃、输出截断、顺序错误、协议或记录错误，均丢弃未完成的原生上下文，完整回退 TS。
- 进程退出后的存活状态不作为缓存；verify 模式始终采用 TS 贡献，并要求逐文件记录一致。

## 开发者构建

```bash
npm run build
npm run build:rust-macros -- --target x86_64-pc-windows-msvc
npm run build:rust-macros -- --target x86_64-unknown-linux-musl
npm run test:rust-macros
```

构建者需要对应 Rust target；使用 musl 自包含链接、检查 Linux ELF 无动态解释器/共享库依赖，Windows 静态 CRT。业务机器使用随包程序，不需要 Rust/Cargo。安装脚本只校验产物并恢复 Linux 执行权限，不下载、编译或执行宏扫描器。

`CODEGRAPH_RUST_MACROS_EXPECT=1 npm run test:rust-macros` 要求实际二进制存在，不允许通过跳过原生测试宣称验收。测试同时覆盖相关 C 提取、sync 和旧 Rust 目录扫描回归。

社区参考：本地 `codegraph-ori` 的 `6a056ec`，特别是 `c-fnptr-synthesizer.ts` 的批量事实扫描与 `codegraph-kernel/src/cfnptr.rs` 的 JS/Rust 语义差分约束。本实现不复制整个原生解析内核；不能用社区的性能数字代替本项目实测。
