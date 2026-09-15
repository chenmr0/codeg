# 精准查询与 Linux 随包 ripgrep 计时

## 1. MCP 默认关闭模糊查询

MCP `search` 默认严格区分大小写并精确匹配，不增加工具调用参数。需要模糊查询时，仅通过 MCP 服务器环境变量 `CODEGRAPH_SEARCH_FUZZY=1` 启用。**旧安装包需要更新到包含本次修改的构建并重启 MCP。** 本工作区已构建、测试，但没有自动更新其他机器上的安装。

单次查询或 batch 保持原有调用格式：

```json
{
  "queries": [
    { "query": "TIFM_X2itfSonNeedProbeMsg", "includeCode": "if_unique" },
    { "query": "TIFM_X2itfIsMixedAddr", "includeCode": "if_unique" },
    { "query": "TIFM_X2itfSonFillProbeXnTnlCfgInfo", "includeCode": "if_unique" }
  ]
}
```

需要启用模糊查询时，在 MCP 服务器配置中添加：

```json
"env": {
  "CODEGRAPH_SEARCH_FUZZY": "1"
}
```

不设置该环境变量，或设为 `"0"`，都使用默认精确查询。只有值为 `"1"` 才启用模糊查询；没有单次请求或 batch 项覆盖参数。修改 MCP 配置后重启对应服务进程；若使用共享 daemon，也需让它以新环境重新启动。

默认精确查询跳过大小写纠正、FTS/LIKE/编辑距离建议以及错误 owner 恢复。精确符号命中仍支持 path/line/signature 与 `includeCode: "if_unique"`；精确未命中仍执行原有的区分大小写的原文证据扫描。原文兜底在两种模式中都保留。

只查索引可使用已有 CLI 默认模式：

```bash
codegraph query TIFM_X2itfSonNeedProbeMsg --path /your/project --json
```

不要传 `--fuzzy`。CLI 此路径既不做模糊搜索，也不执行 MCP 原文兜底。

### 验证

- 构建通过；搜索语义、底层 exact 查询及 MCP batch context 共 **114 项测试通过**。
- 相同三条原始查询：无环境变量、无新增工具参数时 **1.066 / 1.072 / 1.040 秒**；设置 `CODEGRAPH_SEARCH_FUZZY=1` 后为 **6.300 秒**。没有清空操作系统缓存。
- 默认模式的大小写纠正、FTS、LIKE、编辑距离和全量名字读取均为零次；环境变量启用后恢复六遍搜索链。两种模式每个 batch 都保留一次完整原文扫描，覆盖 23,340 文件，无超时。
- 数据：`bench-logs/search-default-exact-20260915/`。
- 首次回归中 112 项通过，2 项只因默认模式的未命中提示文字变化失败；更新断言后两项复跑通过，原文命中和完整扫描后不存在的断言均保留。

## 2. Linux 直接测试随包 ripgrep，不经过 8 秒预算

无需在 Linux 更新 CodeGraph 就能直接找到已安装包的 ripgrep。下面命令使用 Bash，`codegraph` 需在 PATH 中。

### 找到实际二进制

```bash
CG_ENTRY="$(readlink -f "$(command -v codegraph)")"

RG="$(node --input-type=module - "$CG_ENTRY" <<'NODE'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const fromCodeGraph = createRequire(process.argv[2]);
const module = await import(pathToFileURL(fromCodeGraph.resolve('@vscode/ripgrep')).href);
console.log(module.rgPath ?? module.default?.rgPath);
NODE
)"

printf 'codegraph entry: %s\nripgrep: %s\n' "$CG_ENTRY" "$RG"
"$RG" --version
```

这从当前 CLI 安装位置解析依赖，避免误用系统 `/usr/bin/rg`，也不依赖猜测 npm 全局目录。若 `codegraph` 是 shell 包装脚本或 alias，请将 `CG_ENTRY` 改成实际安装包的 `dist/bin/codegraph.js` 绝对路径。如果 MCP 配置另外指定了 `CODEGRAPH_RG_PATH`，MCP 实际使用的是该覆盖路径。

### 分开测文件枚举和内容扫描

```bash
cd /your/project
OUT="$(mktemp -d /tmp/codegraph-rg.XXXXXX)"

# C/C++ 范围；如项目还有其他源文件扩展名，请补充。
GLOBS=(
  --glob '*.c' --glob '*.h' --glob '*.cc' --glob '*.hh'
  --glob '*.cpp' --glob '*.hpp' --glob '*.cxx' --glob '*.hxx'
  --glob '*.inl' --glob '*.ipp' --glob '*.inc' --glob '*.C' --glob '*.H'
)

# 1. 文件枚举，real 是墙钟耗时。
if time "$RG" --files --null --hidden --no-messages \
  "${GLOBS[@]}" -- . > "$OUT/files.bin"; then
  printf 'inventory exit=0\n'
else
  printf 'inventory exit=%s\n' "$?"
fi

# 2. 一次多模式内容搜索：区分大小写、固定字符串、不设超时。
if time "$RG" --json --stats --fixed-strings --case-sensitive --text \
  --hidden --no-messages "${GLOBS[@]}" \
  --regexp 'TIFM_X2itfSonNeedProbeMsg' \
  --regexp 'TIFM_X2itfIsMixedAddr' \
  --regexp 'TIFM_X2itfSonFillProbeXnTnlCfgInfo' \
  -- . > "$OUT/search.jsonl"; then
  printf 'search exit=0 (matched)\n'
else
  printf 'search exit=%s (1=no match, 2=error)\n' "$?"
fi

# 完整扫描的最后一条 JSON 通常是 summary。
tail -n 1 "$OUT/search.jsonl"
printf 'logs: %s\n' "$OUT"
```

重点看：

- 两个 `time` 的 `real`：分别代表枚举和内容搜索的实际等待时间，**求和**才是这两步的总时间。
- `summary.data.elapsed_total`：rg 自报总耗时。
- `summary.data.stats.searches` / `bytes_searched` / `matches`：实际搜索文件数、字节数和命中数。
- **退出码 1 是正常完成但无匹配**；退出码 2 表示有错误，不能认为所有文件都扫描成功。不要用 `--quiet` 或 `--files-with-matches` 来测完整扫描，它们会改变扫描行为。

这里的文件范围是明确列出的扩展名，加上 rg 自身的 ignore 规则和 `--hidden`；没有读取索引文件清单，所以文件数量未必等于报告中的 97,648。CodeGraph 会从索引推导扩展名、检查索引覆盖并对遗漏文件进行 Node 补扫，还会对匹配结果检查标识符边界。因此这项测量回答“rg 自己需要多久”，不能直接当作完整 MCP 请求耗时。

## 3. 自动保存诊断结果的脚本

`scripts/benchmark-bundled-ripgrep.mjs` 把上述流程封装成跨平台脚本。旧 Linux 安装也可以使用：只需复制该脚本到 Linux，无需升级或重新索引，再执行：

```bash
node ./benchmark-bundled-ripgrep.mjs \
  --project /your/project \
  --codegraph-entry "$(command -v codegraph)"
```

默认搜索上面的三个 TIFM 名称。可以重复传入 `--query` 或 `--glob` 覆盖默认查询/扩展名：

```bash
node ./benchmark-bundled-ripgrep.mjs \
  --project /your/project \
  --codegraph-entry "$(command -v codegraph)" \
  --query TIFM_X2itfSonNeedProbeMsg --query TIFM_X2itfIsMixedAddr \
  --glob '*.cpp' --glob '*.h'
```

脚本不设置 deadline，不打开数据库、不启动 MCP、不更新索引。输出目录默认在系统临时目录，可用 `--out` 指定新目录；日志已存在时拒绝覆盖。结果包含 rg 路径/版本、完整参数、两个阶段的耗时和退出码、枚举文件数、rg summary，另保存完整原始输出。

本机 Windows 实跑该脚本：C/C++ glob 范围 21,484 文件，枚举 153 ms，搜索 659 ms，退出码 1，rg 自报搜索 432,992,720 字节。该范围不同于前面的完整索引范围，不混用二者数字；尚未在用户 Linux 机器执行。数据：`bench-logs/search-exact-20260915/standalone-ripgrep/results.json`。

## 4. 测 CodeGraph 完整原文兜底

要保持 CodeGraph 原本的文件范围、覆盖核对和 Node 补扫，可以暂时增大 **MCP 服务进程**的环境变量，并重新调用原来的查询：

```json
{
  "mcpServers": {
    "codegraph": {
      "command": "codegraph",
      "args": ["serve", "--mcp", "--path", "/your/project"],
      "env": {
        "CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS": "600000",
        "CODEGRAPH_NO_DAEMON": "1"
      }
    }
  }
}
```

- `600000` 为 10 分钟上限，仍然不是无限等待。**`0` 会立即用完预算，不是禁用超时。**
- `CODEGRAPH_NO_DAEMON=1` 让此诊断连接使用新启动的独立 MCP，避免继续连接继承旧环境的共享 daemon。修改配置后重启对应 MCP 服务；终端 `export` 不会改变已经运行的进程环境。
- `CODEGRAPH_RAW_EVIDENCE_TIMEOUT_MS` 已在当前既有扫描实现中支持；默认精确查询及 `CODEGRAPH_SEARCH_FUZZY` 开关需更新到包含本次修改的版本才生效。
- MCP 客户端可能另有工具请求超时；该变量只调整 CodeGraph 的原文预算，不能改变客户端期限。
- 如果直接 rg 几秒完成而 MCP 仍耗时很长，应继续比较数据库阶段、worker 排队/启动、覆盖核对/Node 补扫及主线程交付延迟。`0/N` 是中断分支的计数，无法单独判定卡在文件枚举还是内容搜索。
