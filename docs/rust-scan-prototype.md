# Rust 扫描原型与历史评测

> 本文保留早期“默认关闭、手动编译”原型的设计和评测背景。当前已加入预编译分发、验收记录和默认自动选择；安装/打包请以 [预编译发布说明](native-scan-release.md) 为准。未验证的程序不会自动启用。

## 范围

这是独立的目录/文件状态扫描原型，不是社区的 Rust 源码提取内核。宏处理、源码解析、引用恢复和数据库写入仍由现有代码负责，数据库结构不变，无需重新 init。

第一版通过一次子进程调用交换 JSON 快照，**尚未使用 N-API**。这样可先验证扫描算法与收益，并用 Windows GNU 独立程序构建，避免先引入 MSVC/Node 原生模块链接依赖。若端到端实测值得继续，再考虑 N-API；不能把原先估算的 0.9–1.2 秒当成已实现结果。

Rust 在一次扫描中完成目录遍历、忽略匹配及普通源文件 size/mtime 采集。返回顺序对齐 Node：Unix 对 ASCII 名称排序，Windows 保留文件系统枚举顺序。TypeScript 校验协议和结果，再按原流程核对数据库。on 模式下成功的完整快照可代替本轮重复的 exists/stat；不缓存到下一次 sync。

## 构建

普通 `npm install` / `npm run build` 不安装 Rust，也不会自动下载原生程序。显式执行：

```bash
npm run build
npm run build:rust-scan
cargo test --manifest-path codegraph-scan/Cargo.toml
# 已编译二进制的真实差分测试，缺少二进制时必须失败而不是跳过
CODEGRAPH_RUST_SCAN_EXPECT=1 npx vitest run __tests__/rust-scan-native.test.ts
```

需要目标机器上的 Rust 工具链。可设置 `CODEGRAPH_CARGO` 指向 cargo。构建脚本仅暂存当前主机程序到 `dist/native-scan/<platform>-<arch>/`，不自动跨平台构建；Windows 的 exe 不能拿到 Linux 运行。源码包包含 `codegraph-scan` 的构建输入。

Windows 无 MSVC 时，GNU Rust 工具链可用于基础独立程序构建；这不意味着它可直接替代官方 Node 的 MSVC 原生模块。[Rust 官方 Windows 工具链说明](https://rust-lang.github.io/rustup/installation/windows.html)

### 打包到 Linux 环境

上面的完整构建/测试命令用于源码工作树。要用 npm 包部署，在当前包含原型的工作树先执行 `npm run build`，再执行 `npm pack`。包包含编译后的 TypeScript、Rust 源码、Cargo.lock 和 helper 构建脚本；普通 npm 安装不自动构建 Rust。

在 Linux 安装该本地 tgz 后，使用目标 Linux 本机的 Cargo/链接器构建 helper（需要对安装目录有写权限）：

```bash
npm install -g /path/to/sdd-codegraph-wx-1.0.7.tgz
rustScanPackageDir="$(npm root -g)/@sdd/codegraph-wx"
(cd "$rustScanPackageDir" && npm run build:rust-scan)
```

已安装的 npm 包含有 `dist`，不需要、也不应在该安装目录再执行完整 `npm run build`（包不包含完整 TS 构建输入和测试）。如果采用源码部署，则在源码仓执行完整构建及真实差分测试。

目标环境无法下载 Cargo 依赖时，可在兼容的 Linux 环境构建 helper 后复制，并设置 `CODEGRAPH_RUST_SCAN_PATH` 指向它；Windows EXE 不能替代 Linux 程序。现阶段没有自动分发所有平台的原生二进制。

回到待测项目，先保持工作树静止并备份索引，再运行下一节的 verify。只有看到 `nativeStatus=verified`，才采用 `CODEGRAPH_RUST_SCAN=1` 测速；正式启用后应看到 `nativeStatus=used`。`fallback` 或 `mismatch` 都不能作为 Rust 加速结果。功能默认关闭，不设置开关仍使用此前的优化路径，数据库不需要重新 init。

## 验证与启用

先在静止工作树、隔离索引上校验，再计时：

```bash
# 原有 TypeScript 路径（默认）
time codegraph sync -v

# 同时跑两种扫描，比较路径、顺序、大小和修改时间；始终采用 TS 结果
time env CODEGRAPH_RUST_SCAN=verify codegraph sync -v

# 显式采用通过协议校验的 Rust 快照；加载/运行/不支持形态均可回退
time env CODEGRAPH_RUST_SCAN=1 codegraph sync -v

# 关闭，无需重新建立索引
time env CODEGRAPH_RUST_SCAN=0 codegraph sync -v
```

`CODEGRAPH_RUST_SCAN_PATH` 可指向自行编译的扫描程序。进程默认超时 15 秒，`CODEGRAPH_RUST_SCAN_TIMEOUT_MS` 可设置 100–60000 毫秒；超时、失败或输出超过上限都会回退，不接受部分结果。

`scan-detail` 增加 `nativeStatus=off|used|verified|mismatch|fallback`、`nativeReason`、`nativeMs`、`nativeDirectories`、`nativeMetadata`。采用原生结果时 `mode=rust`。verify 的 `nativeMs` 包含双跑与元数据核验，不用于计算加速比例。核对计数 `snapshotPresence` / `snapshotStats` 表示复用本轮快照的次数；原 `existsChecks` / `statChecks` 仍只统计 Node 实际检查。

## 当前保守边界

- 只接入有 `.codegraphignore` 否定规则、原本走完整文件系统遍历的项目。Git-only、显式 hybrid 路径和局部 watcher 核对不被替换。
- 初版拒绝非 ASCII 源码路径/目录、符号链接、转义/字符类/花括号等复杂忽略模式；遇到任一不支持项，整轮 Rust 结果丢弃并走 TS。带 ASCII 后缀且明确不参与索引的普通文件（如中文 Markdown）可跳过；非 ASCII 扩展名仍回退，避免 Unicode 大小写转换导致漏选源码。
- 根默认规则、根 `.gitignore`、根 `.git/info/exclude`、`.codegraphignore` 及其父目录扩展规则按同一来源和顺序提供给 Rust；不读取用户全局 Git excludes。嵌套规则逐层应用，不能默认套用 Rust 库所有行为。[Rust matcher API](https://docs.rs/ignore/latest/ignore/gitignore/struct.GitignoreBuilder.html)
- 原生 I/O 错误、无效规则、深度/文件/输出限制都不是“空目录”；不使用部分清单删除索引。
- 路径、扩展名、去重、数字范围、元数据计数和协议版本均在 TS 再检查。mtime 沿用 Node 浮点毫秒再取 floor 的比较方式。
- 快照不是工作树事务：扫描期间又发生的修改可能留到下次同步，和现有文件系统核对一样不能提供原子快照保证。需要验证差分时应保持工作树静止。
- 性能验收必须基于最新 TypeScript 优化版，不拿更旧的 2.59 秒或 Linux 6 秒直接计算 Rust 单项收益。记录进程启动到退出的总耗时，不能只报 Rust 内部时间。

## 测试层次

`__tests__/rust-scan.test.ts` 验证 TS 协议、回退、verify 权威性及快照接入，可在没有 Rust 的机器运行；它使用模拟响应，**不证明 Rust 实现已通过差分测试**。`cargo test` 验证 Rust 核心。`__tests__/rust-scan-native.test.ts` 使用真实程序比较文件顺序、大小、mtime 和忽略边界；无二进制时默认跳过，原生测试任务必须设置 `CODEGRAPH_RUST_SCAN_EXPECT=1`。实际项目还需 `CODEGRAPH_RUST_SCAN=verify`，通过后再进行端到端 A/B。

## 已完成的本机验证（2026-09-06）

Windows x64 / Node v24.11.1 / Rust 1.98.1 MSVC release 构建成功，Rust 核心 3 项、真实二进制差分测试 15 项通过。OceanBase 14,347 个源码文件、980 个目录通过 verify：文件清单、顺序、size 和 floor(mtimeMs) 均一致。

测速后相关回归共 17 个测试文件、834 项通过，4 项既有 Windows 文件符号链接测试因本机权限限制跳过；性能计时与这些回归未并发运行。

保持既有 `.codegraphignore`，最新 TS 路径复用版与 Rust 原型交替运行，使用隔离数据库、每次启动新 CLI 进程；排除预热、保留操作系统热缓存。普通空同步各 3 轮中位数 **1.720 → 0.642 秒**（耗时减少 62.7%）；`sync -v` 各 5 轮中位数 **1.779 → 0.660 秒**。时间包含 Rust 子进程、传输、Node/数据库启动，不只计算 Rust 内核。

原库 files/metadata 行哈希、图数量和 mtime 不变；源码状态、忽略配置不变；临时备份已清理。本地完整记录在 `bench-logs/rust-noop-ab-3d16Xa/REPORT.md` / `results.json`，复跑脚本 `bench-logs/rust-noop-ab.cjs`。这些机器本地评测产物不进入源码包。

以上是本机热缓存空同步结果，不是 Linux、冷磁盘、复杂忽略规则或变更文件同步的保证。原型仍默认关闭；Linux 应先本机构建并运行真实差分测试和 verify，再衡量收益，无需为此重建索引。

## 与此前优化叠加的 20 文件验收

2026-09-06，沿用之前 10 个 `.cpp`＋10 个 `.h`（365,685 字节、9,923 行），两端同时开启文件列表复用、文本缓存、安全注释筛选及路径复用，只切换 Rust 开关。原索引只读，使用两份隔离数据库，三轮交替运行完整 `sync -v`：

| 场景 | 此前优化，Rust 关闭 | 此前优化＋Rust | 耗时降低 |
|---|---:|---:|---:|
| 无变更 | 1.734 秒 | 0.681 秒 | 60.7% |
| 新增 20 文件 | 25.007 秒 | 24.071 秒 | 3.7% |
| 20 文件仅修改安全注释 | 13.140 秒 | 12.061 秒 | 8.2% |
| 删除 20 文件 | 2.955 秒 | 1.793 秒 | 39.3% |

新增均产生 1,647 个探针节点；安全注释修改两端均扫描 8,225 条、实际重试 1,351 条、安全跳过 6,874 条。24 次 CLI 全部成功，12 组配对的文件状态、图数量及探针节点/边/引用校验一致。Rust 没有替代宏扫描和引用解析，因此批量新增的整体收益有限；此样本仍不是对所有真实代码修改的性能承诺。

原库、既有源码及忽略配置不变，测试副本和两个索引副本已清理。完整本机报告位于 `bench-logs/rust-stacked-ab-VEQcnW/REPORT.md`。npm 打包预检已确认 Rust 源码、锁文件、构建脚本和当前平台 helper 在包内；Linux helper 仍需按部署小节准备。
