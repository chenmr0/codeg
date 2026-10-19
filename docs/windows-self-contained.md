# Windows 无 Rust 自包含打包

独立入口：`scripts/build-self-contained.ps1`。从一个 Git 提交构建应用，复用已有原生组件，分别输出 Windows x64 ZIP 和 Linux x64 tar.gz。每包内置固定 Node 运行时、全部生产 npm 依赖、对应平台 ripgrep、WASM/SQL 资源和两个 Rust 组件。目标机无需安装 Node、npm 或 Rust，解压后运行，也不需要联网下载依赖。

现在同一入口还会生成**单文件离线安装器**，这是面向普通用户的推荐交付方式：

| 系统 | 下载一个文件 | 安装方式 |
| --- | --- | --- |
| Windows x64 | `codegraph-1.1.2-win32-x64.exe` | 双击，等待安装成功后按 Enter 关闭 |
| Linux x64 | `codegraph-1.1.2-linux-x64.run` | `sh codegraph-1.1.2-linux-x64.run` |

无需手动解压，不需要额外下载安装脚本、Node/npm/Rust。安装器内置载荷及校验和，离线完成验证、版本切换和用户 PATH 设置。打开新终端执行 `codegraph --version`。ZIP/tar.gz 继续保留给便携使用和排查问题，不是执行单文件安装时还需要下载的文件。

原有 `npm run build`、`npm pack`、prepack/postinstall、包名和版本规则均不变；此入口不修改仓库的 `dist`、`node_modules` 或 `package.json`。普通 npm tgz 仍要求目标机有 Node/npm。自包含打包是独立流程，不调用 `npm publish`。

## 打包机准备

- Windows x64，Node 22 或 24、npm >= 10、Git、PowerShell、支持 ZIP/USTAR 的 Windows `tar.exe`。
- Windows EXE 封装使用系统自带的 `IExpress.exe`，不需要 Rust 或额外安装编译器；只选择 Linux 目标时不需要 IExpress。
- 首次构建可访问 npm registry 和 nodejs.org；代理/registry 可使用现有 npm 配置。
- 当前源码对应的预编译组件，不需要安装 Rust/Cargo：

```text
dist/
  native-scan/
    win32-x64/codegraph-scan.exe + manifest.json
    linux-x64/codegraph-scan + manifest.json
  native-macros/
    win32-x64/codegraph-macros.exe + manifest.json
    linux-x64/codegraph-macros + manifest.json
```

可从现有可信安装包或 `.github/workflows/rust-scan-prebuilt.yml` 产物取得这四个目录。不能只复制 exe 或手改 manifest。脚本会检查组件版本、源码指纹、SHA256 和可执行文件格式。Rust 源码或包版本变化导致不匹配时，须重新获取匹配产物；脚本不会调用编译器，也不会绕过校验。

### 其他开发者首次拉取后

`dist/`、`node_modules/`、运行时缓存和安装制品不提交到 Git。新 checkout 不会自带预编译组件，必须先取得上述 CI 产物或维护者提供的匹配 npm 包。首次运行打包脚本会在隔离目录自动安装开发依赖，无需先在仓库执行 `npm ci`。

例如，已有维护者提供的 `sdd-codegraph-wx-1.1.2.tgz` 时，可以只提取其中的预编译组件，然后打包：

```powershell
# 在拉取后的仓库根目录执行；替换为实际 npm 包路径
New-Item -ItemType Directory -Force .\release\prebuilt-import | Out-Null
tar -xzf 'D:\downloads\sdd-codegraph-wx-1.1.2.tgz' -C .\release\prebuilt-import package/dist/native-scan package/dist/native-macros
.\scripts\build-self-contained.ps1 -PrebuiltDir "$PWD\release\prebuilt-import\package\dist"
```

只修改 TypeScript/打包脚本且组件版本、Rust 源码指纹未变化时可复用原生产物。若校验提示版本或源码指纹不匹配，应重新取得对应构建产物，不要跳过校验。

## 一条命令生成两个包

在仓库根目录运行：

```powershell
.\scripts\build-self-contained.ps1
```

默认构建 `HEAD` 对应的**已提交源码**，未提交修改和未跟踪文件不会进入应用构建。先提交想发布的改动；也可显式指定提交或分支。打包器、运行时锁及随包验证器来自当前脚本目录，应用源码版本记入 manifest。

```powershell
.\scripts\build-self-contained.ps1 -Ref release/1.1.2-chinese `
  -PrebuiltDir 'D:\artifacts\codegraph\dist' `
  -OutputDir 'D:\packages\codegraph' `
  -CacheDir 'D:\caches\codegraph-bundle'

# 只生成一个平台
.\scripts\build-self-contained.ps1 -Target win32-x64
.\scripts\build-self-contained.ps1 -Target linux-x64
```

如本机 PowerShell 执行策略阻止脚本，可在已有 Node/npm 环境直接运行等价入口，无需修改全局策略：

```powershell
node .\scripts\build-self-contained.mjs --ref HEAD --target all
# 非标准 Node/npm 安装布局可显式指定 npm CLI：
node .\scripts\build-self-contained.mjs --npm-cli 'C:\path\node_modules\npm\bin\npm-cli.js'
```

默认输出在 `release/self-contained/`：

```text
codegraph-1.1.2-win32-x64.zip
codegraph-1.1.2-win32-x64.zip.sha256
codegraph-1.1.2-win32-x64.zip.manifest.json
codegraph-1.1.2-linux-x64.tar.gz
codegraph-1.1.2-linux-x64.tar.gz.sha256
codegraph-1.1.2-linux-x64.tar.gz.manifest.json
codegraph-1.1.2-win32-x64.exe
codegraph-1.1.2-win32-x64.exe.sha256
codegraph-1.1.2-linux-x64.run
codegraph-1.1.2-linux-x64.run.sha256
install-self-contained.ps1
install-self-contained.sh
```

同版本重复构建会替换同名输出；manifest 包含源提交和文件哈希，归档另有 SHA256。运行时锁为 `scripts/self-contained-runtimes.json`：固定官方 Node v24.21.0 及两个归档的官方 SHA256。更新锁时需重新核对官方校验和，并重新做目标机验证。

已有 ZIP/tar.gz 及其 `.sha256` 时，也可以只重新封装安装器，无需重新构建应用或下载依赖：

```powershell
node scripts/build-single-file-installers.mjs
# 支持 --bundle-dir DIR、--target all|win32-x64|linux-x64、--version 1.1.2
```

Windows EXE 默认显示安装过程，成功和失败都会等待按 Enter 后关闭。自动化可使用 `/Q`；它仍执行校验和安装，只是不等待键盘输入。Linux `.run` 支持 `--no-path` 和 `--help`。两端继续支持 `CODEGRAPH_INSTALL_DIR` 自定义安装目录；Linux 另支持 `CODEGRAPH_BIN_DIR`。自动化测试可设置 `CODEGRAPH_UPDATE_PATH=0`，避免修改真实用户 PATH。

缓存默认放在 `release/self-contained-cache/`。第一次完整构建会缓存 Node 归档与 npm 包。之后可以使用相同缓存离线重建：

```powershell
.\scripts\build-self-contained.ps1 -Offline
```

离线模式缺依赖或运行时会明确失败，不会偷偷联网。失败的临时构建目录会保留并打印路径，成功时仅清理本次临时目录。构建需要额外磁盘空间容纳源码、依赖、展开的 Node 和归档。

## 压缩包及外部安装器入口（兼容保留）

安装器使用我们自己的 `chenmr0/codeg` 仓库，不安装社区发行版。支持 Windows x64 和 Linux x64，目前没有 macOS 包。

### Linux：只下载一个 tar.gz，执行一行命令

新生成的 Linux 包在根目录内置 `install.sh`。用户只需下载 `codegraph-1.1.2-linux-x64.tar.gz`，在下载目录执行：

```sh
tar -xzf codegraph-1.1.2-linux-x64.tar.gz && sh codegraph-1.1.2-linux-x64/install.sh
```

这会自动安装到用户目录、验证包内文件及运行环境、切换版本并设置 PATH，全程不需要联网，不需要已有 Node/npm/Rust，也不用单独下载安装脚本或 `.sha256`。打开新终端执行 `codegraph --version`。安装成功后可删除下载的归档及本次解压目录，已安装版本是独立副本。

此入口使用包内 manifest 校验内容；如果发行方另外提供 `.sha256`，仍可在解压前自行验证下载文件。内部校验不替代独立的来源认证。没有 `install.sh` 的旧 tar.gz 需重新打包才支持此命令。

### 外部安装器入口（仍保留）

**本地包现在即可一键安装**，自动读取同目录的 `.sha256`，完成校验、解压、目标平台验证和命令入口设置：

```powershell
# 在仓库根目录：
.\scripts\install-self-contained.ps1 -Archive .\release\self-contained\codegraph-1.1.2-win32-x64.zip
# 或将输出目录中的安装器、ZIP、.sha256 一起带到目标机：
.\install-self-contained.ps1 -Archive .\codegraph-1.1.2-win32-x64.zip
```

```sh
sh ./install-self-contained.sh --archive ./codegraph-1.1.2-linux-x64.tar.gz
```

Windows 默认装到 `%LOCALAPPDATA%\codegraph-wx`，将其 `bin` 写入用户 PATH；Linux 默认装到 `~/.local/share/codegraph-wx-self-contained`，将 `~/.local/bin/codegraph` 链接到安装器管理的当前版本，并为 `.profile` 及当前 bash/zsh 配置添加 PATH。打开新终端即可运行 `codegraph --version`。Windows 在同一 PowerShell 会话中执行安装器还会立即刷新当前进程 PATH。

两端均采用版本目录，先验证候选再切换当前入口，旧版本不会被删除。遇到非本安装器管理的目标目录/命令入口会报错，避免覆盖其他安装。重复安装受支持；升级时重新执行安装器并指定新版本，不使用继承的 `codegraph upgrade`。

自定义目录或不修改 PATH：

```powershell
.\scripts\install-self-contained.ps1 -Archive .\release\self-contained\codegraph-1.1.2-win32-x64.zip -InstallDir 'D:\Tools\codegraph-managed' -NoPath
```

```sh
CODEGRAPH_INSTALL_DIR="$HOME/tools/codegraph-managed" CODEGRAPH_BIN_DIR="$HOME/tools/bin" \
  sh ./install-self-contained.sh --archive ./codegraph-1.1.2-linux-x64.tar.gz --no-path
```

### 在线一键安装：发布完成后可用

以下是**预定入口，当前改动尚未发布，不能当成已经可访问的下载地址**：

```powershell
irm https://raw.githubusercontent.com/chenmr0/codeg/release/1.1.2-chinese/scripts/install-self-contained.ps1 | iex
```

```sh
# Linux x64，不含 macOS
curl -fsSL https://raw.githubusercontent.com/chenmr0/codeg/release/1.1.2-chinese/scripts/install-self-contained.sh | sh
```

上线需要维护者完成两件事：

1. 将安装脚本提交并推送到上述分支，确保 raw 地址可访问；若选择其他稳定分支，调整文档中的 raw URL。
2. 在 `chenmr0/codeg` 的对应 GitHub Release 上传原样命名的两个归档及其 `.sha256`。默认版本为 `1.1.2`、Release tag 为 `v1.1.2`；还可上传 `.manifest.json` 供审计。不要用社区发布脚本自动发布到其他仓库。

本实现没有执行 push、创建 Release 或上传资产。安装器默认固定版本，不盲目跟随 latest。之后更新入口默认版本，或通过 `CODEGRAPH_VERSION` 指定其他版本；发布 tag 与包版本不同可另设 `CODEGRAPH_RELEASE_TAG`：

```powershell
$env:CODEGRAPH_VERSION = '1.1.2'
$env:CODEGRAPH_RELEASE_TAG = 'v1.1.2-chinese'
# 然后执行在线安装命令
```

```sh
curl -fsSL https://raw.githubusercontent.com/chenmr0/codeg/release/1.1.2-chinese/scripts/install-self-contained.sh |
  CODEGRAPH_VERSION=1.1.2 CODEGRAPH_RELEASE_TAG=v1.1.2-chinese sh
```

下载失败、归档校验失败或目标验证失败会终止安装，不切换已有版本。Linux 安装器会在目标 Linux 上执行包内 `verify`，不把 Windows 构建结果当成 Linux 运行认证。

## Windows 手动解压安装与验证

```powershell
Get-FileHash .\codegraph-1.1.2-win32-x64.zip -Algorithm SHA256
# 与配套 .sha256 核对后解压
Expand-Archive .\codegraph-1.1.2-win32-x64.zip -DestinationPath 'D:\Tools'
& 'D:\Tools\codegraph-1.1.2-win32-x64\bin\verify.cmd'
& 'D:\Tools\codegraph-1.1.2-win32-x64\bin\codegraph.cmd' --version
```

可将解压目录中的 `bin` 加入用户 PATH；脚本不会自动改系统 PATH。运行时需要目录可写，以保存组件验收记录。目标系统需满足随包 Node 24 的 Windows x64 运行要求。

## Linux 手动解压安装与验证

```sh
sha256sum -c codegraph-1.1.2-linux-x64.tar.gz.sha256
mkdir -p "$HOME/.local/share"
tar -xzf codegraph-1.1.2-linux-x64.tar.gz -C "$HOME/.local/share"
bundle="$HOME/.local/share/codegraph-1.1.2-linux-x64"
"$bundle/bin/verify"
"$bundle/bin/codegraph" --version
export PATH="$bundle/bin:$PATH"
```

Linux tar 已显式设置 Node、启动器、ripgrep、原生组件的 Unix 执行位，不依赖 Windows chmod。

此包使用官方 Node Linux x64 运行时，面向符合该运行时要求的 glibc 系统；**不承诺 Alpine/musl、ARM64 或旧 glibc 系统兼容**。旧 glibc 需求继续使用已有 `docs/portable-install.md` 的 Linux 原生构建与 ELF 审计流程，不用此包替代。

Windows 构建会验证 Windows 包的私有 Node、SQLite FTS5、CLI、ripgrep、两个 Rust 组件及 init/sync 场景，失败则不输出该 Windows 包。Linux 包在 Windows 上只做静态检查，manifest 中 `validation.targetRuntimePassed` 保持 `false`；这不是 Linux 验收成功声明。把包交给真实 Linux、WSL 或 Linux CI，运行 `bin/verify` 才算完成目标验收。

`verify` 全程离线，在独立临时样例上运行；校验随包文件、版本、工具列表、原生差分测试和扫描冒烟测试。成功后生成 `target-validation.json`，两个组件各自生成实际平台验收记录。不会伪造另一平台的 stamp。重复运行验证受支持；原生 manifest 是可变验收元数据，二进制仍按哈希及源指纹校验。

MCP 配置可直接指定包内 Node 的绝对路径，并在 args 中传入 `--liftoff-only`、包内 `lib/dist/bin/codegraph.js` 的绝对路径、`serve`、`--mcp`，以及需要的 `--path` 项目路径；无需依赖宿主进程的 PATH。

更新时解压新包、验证，再切换 PATH/MCP 指向；保留项目索引目录。启动器禁止继承的 `codegraph upgrade` 外部发行版升级路径。

## 回归检查

```powershell
node --test scripts/test-self-contained.mjs
node --test scripts/test-self-contained-installers.mjs
node --test scripts/test-single-file-installers.mjs
# 可选：使用真实 ZIP 验证首次安装、重复安装和失败保护（隔离目录、不修改 PATH）
$env:CODEGRAPH_TEST_BUNDLE = (Resolve-Path .\release\self-contained\codegraph-1.1.2-win32-x64.zip).Path
node --test scripts/test-self-contained-installers.mjs
# 真实 EXE 测试：隔离目录，系统 Node 不在 PATH，不修改真实用户 PATH
$env:CODEGRAPH_TEST_EXE = (Resolve-Path .\release\self-contained\codegraph-1.1.2-win32-x64.exe).Path
node --test scripts/test-single-file-installers.mjs
```

Windows 可见窗口回归测试（会打开一个隔离测试窗口，安装结束后自动关闭；不修改真实用户 PATH）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-installer-window.ps1 -Exe .\release\self-contained\codegraph-1.1.2-win32-x64.exe
```

这个测试直接无参数启动最终 EXE，检查窗口可见且安装成功后保持打开，覆盖实际双击路径。IExpress 的 `ShowInstallProgramWindow=0` 才是默认显示，`1` 表示隐藏，不能套用 Win32 窗口常量的含义。

Linux 的真实单文件安装测试（使用隔离 HOME、安装目录和 PATH 配置）：

```sh
sh scripts/smoke-single-file-linux.sh /absolute/path/codegraph-1.1.2-linux-x64.run
```

本次已在 Windows 真实 EXE 和 Ubuntu/WSL2 x64（glibc 2.43）上运行安装验收：覆盖安装、重复安装、中文/空格路径、失败保护；Linux 额外覆盖损坏载荷拒绝及临时 HOME 的 PATH 设置。该结果不等于所有 Linux 发行版或旧 glibc 系统均已验收。Windows 构建时包内 `targetRuntimePassed` 仍按构建平台填写，目标安装会重新验证。

测试覆盖目标平台依赖选择、缺失 optional dependency、错误平台二进制、运行时篡改与 Linux tar 权限/校验和。完整验收还包括实际双平台打包、解压 Windows 包重复运行 verify，以及在 Linux 上运行 verify。仅通过单元测试不表示 Linux 已经运行验证。
