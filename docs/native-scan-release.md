# Rust 扫描预编译发布与自动启用

## 用户安装体验

正式包的 Windows x64 / Linux x64 目录扫描与宏上下文程序均在发布前完成各自验收，npm 安装后普通 `codegraph sync` 按场景自动选择。不需要设置开启开关，不需要 Rust/Cargo/C++ 编译工具，也不在用户机器上编译或下载 Rust。

保留此前 Node/npm 运行要求及 JavaScript 依赖安装流程：这些依赖仍通过既有 npm 镜像或离线缓存提供。内置 Rust 程序不等于把 Node 和全部 npm 依赖都打进这个单一 tgz。

- `CODEGRAPH_RUST_SCAN=0`：显式关闭，完全使用此前 TypeScript 路径。
- 未设置、空值或 `auto`：只自动采用平台、版本、SHA-256 和目标平台验收记录均匹配的程序。
- `verify`：诊断用，双跑比较，始终采用 TypeScript 清单。
- `1`：开发/验收用，允许显式尝试尚未盖验收记录的程序，但仍执行扫描协议校验和失败回退。

缺失、损坏、未验证、不可执行或场景不支持时回退 TypeScript。日志的 `nativeStatus=used` 才表示实际使用了 Rust；`nativeReason` 说明为何回退。没有跨轮源码缓存，没有更改数据库结构，不需要重新 init。

宏上下文使用独立门槛：Windows/Linux x64 且 C-family 候选至少 5000 个时，只有 `codegraph-macros` 的版本、源码指纹、SHA-256 和 `macro-parity-v1` 目标平台验收戳都匹配才自动运行。小上下文保持 TypeScript；特殊文件逐项回退，进程/协议错误则丢弃部分结果并由 TypeScript 完整重建。`CODEGRAPH_RUST_MACROS=0` 强制关闭，`1` 强制尝试开发候选，`verify` 双跑并采用 TypeScript。

安装脚本只在 Linux 恢复随包程序的执行权限（解决 Windows 打包导致的 mode 丢失），不执行扫描器，不下载，不编译。若禁止安装脚本且安装文件没有执行位，需要管理员手动修正该程序的权限；无法修正时仍回退。

## 与社区分发方案的关系

参考社区 CodeGraph 1.6.0 的 `scripts/build-kernel.sh`、`.github/workflows/release.yml`、`scripts/build-bundle.sh` 和 `scripts/pack-npm.sh`：平台矩阵预构建 → 目标平台测试 → 收集产物 → 缺失产物阻止发行 → 运行时加载/回退。

保留当前 `@sdd/codegraph-wx` 的单 tgz 安装方式，将两个 x64 程序直接装入包内，适合已有的内网分发流程；不要求安装时再拉取多个原生平台 npm 包。扫描器仍是独立进程，不为了打包迁移到 N-API，不采用社区账号/包作用域作为本包发布目标。

## 发布者流程（不是业务机器要求）

1. 在源码工作树安装开发依赖并 `npm run build`。
2. 编译对应目标：

   ```bash
   npm run build:rust-scan -- --target x86_64-pc-windows-msvc
   npm run build:rust-scan -- --target x86_64-unknown-linux-musl
   npm run build:rust-macros -- --target x86_64-pc-windows-msvc
   npm run build:rust-macros -- --target x86_64-unknown-linux-musl
   ```

   构建机需要已安装对应 Rust target。Linux 使用 Rust 随附的自包含链接库和 LLD，检查产物没有动态加载器和共享库依赖；Windows 静态链接 CRT。必须保留通用 CPU 基线，不能使用 `target-cpu=native`。

3. **在目标操作系统上**运行目录与宏相关测试，再分别运行 `npm run validate:rust-scan` 和 `npm run validate:rust-macros`。两者均只使用独立临时目录且无需编译器；只有全部通过才给各自精确 SHA 写入验收记录。重编译会清除旧记录，不能把 Windows 测试结果冒充 Linux 验收。
4. 收集两个平台的 `dist/native-scan/<platform>-x64/` 和 `dist/native-macros/<platform>-x64/`，保留二进制和 manifest.json。
5. `npm run check:native-artifacts`，然后普通 `npm pack`。prepack 默认要求两个程序的两平台产物齐全、源码指纹一致且分别通过验收；缺一不可。
6. `npm run smoke:native-package -- /path/to/package.tgz --macros`：在隔离 npm prefix 安装，再从 PATH 移除 Rust/Cargo，验证目录扫描、宏程序、增删改、空同步和真实 CLI。

`manifest.json` 的哈希用于完整性/一致性校验，不是数字签名，不能取代可信的包来源或软件供应链审查。

## 自动化

`.github/workflows/rust-scan-prebuilt.yml` 提供 Windows 和 Linux 原生 runner 的构建/测试矩阵，收集产物后生成 `codegraph-prebuilt-npm` artifact，并在无 Rust/Cargo PATH 的环境安装验收。这个独立工作流只产出 artifacts，不发布 npm、不创建版本、不推送代码。

既有 Release 工作流依赖上述工作流并收集其预编译产物；x64 bundle 打包也检查产物。其他平台目前仍走 TypeScript，不宣称已经提供对应 Rust 预编译。执行既有 Release 仍会触发它原有的远程发布行为，需由维护者单独授权；本次本地开发没有触发它。

## 首次 EulerOS 验收

目标已确认：EulerOS 2.0 SP15 x86_64，glibc 2.38。本地 Windows 已能生成 Linux x64 静态候选程序，但没有 Linux/WSL/Docker，**不能只凭交叉编译成功宣称 Linux 已通过运行验收**。

发布者若需先向该机器传送候选包，可显式使用 `CODEGRAPH_PACK_ALLOW_INCOMPLETE=1 npm pack`。这是有提示的候选打包开关，不放宽运行时自动选择：未验收的 Linux 程序仍会回退 TypeScript。

在 EulerOS 安装候选 tgz 后，执行一次以下发行验收（不需要 Rust/Cargo）：

```bash
nativePackageDir="$(npm root -g)/@sdd/codegraph-wx"
cd "$nativePackageDir"
npm run validate:rust-scan
npm run validate:rust-macros
npm run smoke:native-package -- --installed "$nativePackageDir"
```

需要安装目录可写，以保存验收记录。验收通过后，该安装无需再设置开关即可自动加速；将验证输出及两个 Linux manifest 返回发布者，后者核对二进制哈希后可组装正式包。正式包的后续用户不需要重复做发行验收。

业务仓库保持静止、备份索引后再比较 `CODEGRAPH_RUST_SCAN=verify codegraph sync -v` 与普通 `codegraph sync -v`。14 组内置检查不代替真实项目验收；复杂忽略规则、中文源码目录/文件、符号链接等仍可能触发保守回退。
