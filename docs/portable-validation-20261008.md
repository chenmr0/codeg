# 2026-10-08 便携安装验证记录

## 范围

基线：`9d1c262a68c7c1272d0d5e2ac49d9c5c31933a81`（实时远端 `codex/mcp-data-readiness`）。独立分支：`feat/portable-installer-20261008`。未合入字段引用实验；未重新运行历史性能 benchmark；未发布、推送、合并或修改系统库。

## 已通过

- `npm run build`：TypeScript 与资产构建。
- `npm run test:portable`，附加 `CODEGRAPH_TEST_PORTABLE_RUNTIME=<绝对Node二进制路径>`：38/38。shell mock 安装用例27项，ELF只读审计11项；不执行下载的运行时。
- 定向 Vitest 9文件、209/209：portable-launcher、installer、installer-targets、node-version-check、rust-scan-install、rust-scan-artifact、rust-macro-artifact、rust-scan-release、rust-scan-pack。
- 对固定 Node24.21.0 glibc217 归档核对 SHA256：`b1d164136d4b218d663e664f40ba5e260ebc07f90e2bd784c63a57d8c0e6aa8a`。二进制 SHA256：`1e75c95b1af4ec41e83d75816856b205f00c9427fd7d2dadd81472b38ff53d2c`。
- 只读 `readelf`：Node 最大 GLIBC_2.17；依赖 libdl/libm/libpthread/libc/ld-linux-x86-64，无动态 GLIBCXX/CXXABI。目录扫描、宏扫描、ripgrep 均为静态 ELF。包内无 `.node`。
- `build:portable --prepare-only`：实际生成完整候选归档（约66 MiB），包括15个生产 npm 包、私有 Node 与3个原生 helper；候选明确标记 runtimeTestsPassed=false。
- 整包安装烟测的**单独测试副本**：把私有 Node 替换为云机已经安装的 Node24.19.0，实际执行 `scripts/smoke-portable.mjs`。子进程 PATH 无 Node/npm/Rust/C 编译器；带空格路径、版本链接、四个有效代理目标的稳定绝对 MCP 命令、临时 HOME 的非 `--yes` CodeAgent 安装、SQLite FTS5、C WASM 解析/调用边、两个 native差分检查、init/空sync/增量sync、ripgrep、重复安装均通过。该副本不是分发制品，不代表低glibc运行时已验收。

## 未通过声称 / 待办

- 固定 Node24.21.0 unofficial运行时：已下载与静态检查，**尚未执行**；执行许可仍待确认。正式 `build:portable` 与原始候选包的 `smoke:portable` 必须在批准后运行。
- SLES12 SP5/glibc2.22：**未实测**。云机为 Linux x64、glibc2.41、内核6.18.44；没有旧加载器、SLES VM、Docker或Podman。符号门槛符合不等于旧内核/加载器/NSS/业务场景通过。
- 整个仓库全量测试：未跑，只完成上述打包/安装相关定向回归。
- 在线“一条curl命令”发布入口：未上线，需要维护者另行授权发布归档、校验文件与审查后的安装脚本。本次离线安装路径已实现。

每个候选归档的真实 SHA256 和源提交见对应 `.sha256` / `.manifest.json`，不要把较早候选的摘要用于重建后的文件。后续获得运行许可应以原始固定运行时重建、运行真实归档烟测，并更新本记录。
