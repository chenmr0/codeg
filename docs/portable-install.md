# Linux x64 自包含安装包（旧 glibc 候选）

本方案在独立分支 `feat/portable-installer-20261008` 开发，基于 `codex/mcp-data-readiness` 的 `9d1c262`。不包含已放弃的字段引用实验分支。

## 用户端：不需要系统 Node/npm/Rust

包内包含私有 Node、完整生产 npm 依赖、SQLite、tree-sitter WASM、ripgrep、目录扫描与宏扫描程序。不会安装或修改系统 Node、glibc、libstdc++，不需要 sudo。当前新目标仅支持 **Linux x86_64**。

拿到维护者提供的归档和可信 SHA256 后，一条命令安装（完全离线）：

```sh
sh scripts/install-portable.sh --archive /path/codegraph-linux-x64-glibc217.tar.gz --sha256 '<维护者提供的64位SHA256>'
```

这里的 `scripts/install-portable.sh` 是与归档配套分发、可事先审查的脚本。默认装入 `~/.local/share/codegraph-wx`，链接 `~/.local/bin/codegraph`。目录可含空格；可用 `CODEGRAPH_INSTALL_DIR`、`CODEGRAPH_BIN_DIR` 覆盖，必须为绝对路径。不改 shell 配置；必要时自行把 `~/.local/bin` 加入 PATH。

归档和安装器**尚未发布 GitHub Release**。维护者另外授权发布后，安装器支持 `CODEGRAPH_VERSION=<已发布tag> sh scripts/install-portable.sh`，从 `chenmr0/codeg` 下载固定版本及其 `.sha256`。不查 latest，不从社区仓库安装，不在用户机运行 npm 或下载依赖。当前请使用离线包，不把未来的下载命令当作已上线能力。

安装前检查 SHA256、归档路径与文件类型，拒绝路径穿越、符号/硬链接及特殊文件；解压后先运行真实 CLI `--version`，成功才原子切换 `current`。不会覆盖其他发行版已有的 `codegraph`。旧版本保留在 `versions/<归档SHA256>`，安装失败不会先删除旧版本。SHA256 是完整性校验，不能代替可信分发渠道或签名。

通过 `codegraph install` 配置代理前，先验证 `codegraph --version` / `codegraph --help`。代理 MCP 配置在便携安装下使用稳定的 `current/bin/codegraph` 绝对路径，不依赖 shell PATH，更新版本无需重新绑定 CodeAgent；交互配置会跳过旧的全局 npm 安装提示。当前 portable launcher 禁止 inherited `codegraph upgrade` 路径，避免错误安装社区发行版；升级时重跑本安装器并传入新归档及校验值。旧目录中的根 `install.sh` / `install.ps1` 和 release 工作流属于继承方案，本次未改为新的发布入口，不要混用。

## Node 与老系统兼容边界

- 固定 **Node v24.21.0 linux-x64-glibc-217**；版本、来源和 SHA256 保存在 `scripts/portable-runtime.json`。Node 24 的维护期至 2028-04-30；项目现有 engines 限制 `<25`，不用 Node 25/26。
- 来源为 [Node.js unofficial-builds](https://github.com/nodejs/unofficial-builds)，是实验性、有限测试的构建，不等同于官方 SLES 支持。维护者应先审查来源与运行许可，再执行新下载的运行时。
- 本次只读 ELF 检查：该 Node 最大符号需求为 **GLIBC_2.17**，动态依赖仅 glibc 家族及加载器，无 GLIBCXX/CXXABI 动态要求。无需随包塞入构建主机的 libstdc++。
- 两个 Rust helper 使用现有静态 musl 产物；ripgrep 为 npm 锁定的 Linux x64 静态程序。生产包没有 `.node` addon。将来引入 addon 时构建门禁会拒绝，必须重新评估 Node ABI/N-API、glibc 与 C++ 运行库。
- 官方 Node Linux 包一般要求 glibc≥2.28，因此不能仅换成常规 Node 24 下载包来满足 SLES12 SP5 glibc2.22。
- **ELF 符号门槛不等于旧系统运行验收。** SLES12 SP5 的加载器、内核、CPU、文件系统和 NSS/DNS 仍须实测。当前未在 SLES12 SP5 或真实 glibc2.22 环境运行；不得把现代 Linux 的通过记录称为 SLES 支持认证。

发行维护者更新 Node 时必须更新固定摘要并重新完成所有门禁，不使用漂移的 latest 链接。[维护计划](https://github.com/nodejs/Release#release-schedule)、[unofficial 构建工具链](https://github.com/nodejs/unofficial-builds/tree/main/recipes/centos7-toolchain)供核对。

## 维护者构建与验收

构建机需要 Linux x64、现成 Node/npm、GNU tar、curl、readelf；需要当前源码对应且已验收的 `dist/native-scan/linux-x64` 和 `dist/native-macros/linux-x64`，并提前 `npm ci` 安装开发依赖。本次不新增系统软件安装，也不改变已有 Rust 构建方式。

```sh
npm run build:portable
# 或使用已下载且校验过的同一个固定 Node 归档：
npm run build:portable -- --runtime-archive /path/node-v24.21.0-linux-x64-glibc-217.tar.gz
npm run test:portable
npm run smoke:portable -- release/codegraph-linux-x64-glibc217.tar.gz
```

构建严格检查两个 helper 的源码指纹/版本/哈希/验收记录，用 lockfile 安装完整生产依赖（包含目标 ripgrep optional package），扫描包内所有 ELF，拒绝超出 glibc2.17 的符号、动态 C++ 依赖、动态 helper、未审核 `.node` 及符号链接。只在 Linux x64 构建，避免跨主机 npm 装错平台 optional dependency。

默认构建会用私有 Node 检查版本、SQLite FTS5、真实 CLI、两个 native 差分验收，然后生成归档、SHA256 与 manifest。`smoke:portable` 另在隔离目录实际安装归档，子进程 PATH 不包含 Node/npm/Rust/C 编译器，覆盖带空格路径、WASM C 解析、调用边、init/sync、ripgrep 与重复安装。

尚未获准执行候选运行时或仅做静态检查时：

```sh
npm run build:portable -- --runtime-archive /path/node-v24.21.0-linux-x64-glibc-217.tar.gz --prepare-only
```

该模式只生成 `release/candidates/` 的 **未运行验收候选包**，manifest 明确记录 `runtimeTestsPassed: false`、`legacyOsTested: false`。不能把候选打包成功、模拟 shell runtime 测试通过冒充真实 Node 或目标操作系统验收。

本次没有改动已有发布 workflow，不自动发 release、tag、npm 包或提交到 main。`sourceCommit` 标记构建时 HEAD；开发工作树的未提交改动须由维护者另外留档，正式制品应从已提交且干净的树生成。

## 在 SLES12 SP5 上补齐验收

先在真实目标机确认 `uname -a`、`uname -m`、`getconf GNU_LIBC_VERSION`，并使用本地目录安装，不碰业务索引。按上面的离线命令安装，运行 `codegraph --version` / `--help`。再用 bundle 的私有 `node` 运行 `lib/scripts/validate-rust-scan.mjs`、`validate-rust-macros.mjs`，以及 `lib/scripts/smoke-native-package.mjs --installed <bundle>/lib --macros`，所有样例只写独立临时目录。

也可用已安装 bundle 的私有 Node 驱动源码附带的 `scripts/smoke-portable.mjs <原归档>`，在完全没有系统 Node/npm 的目标机复验完整安装。保存系统信息、归档哈希、manifest 和完整日志后，才能将该确切制品标记为目标机验收通过。当前云测试机只有 glibc2.41/现代内核，没有 SLES VM、旧加载器或容器执行器，因此未伪造这一结论。
