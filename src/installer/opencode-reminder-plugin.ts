/**
 * Dependency-free OpenCode plugin installed beside the CodeGraph MCP entry.
 *
 * OpenCode's tool.execute.after hook detects the exact decision point where
 * an agent has started a native grep/read chain. A session-scoped pending flag
 * then lets experimental.chat.system.transform inject the reminder into the
 * next model request as a real system instruction. Indexed sessions that
 * never fall back pay no prompt-token cost, and native tool output remains
 * untouched.
 *
 * Keep the generated file plain JavaScript. OpenCode auto-discovers direct
 * .js children of .opencode/plugins (project) and
 * ~/.config/opencode/plugins (global), and its current stable plugin API does
 * not require importing @opencode-ai/plugin for this hook shape.
 */

export const OPENCODE_REMINDER_PLUGIN_MARKER = 'CODEGRAPH_WX_OPENCODE_REMINDER_PLUGIN';
export const OPENCODE_REMINDER_PLUGIN_FILENAME = 'codegraph-wx-reminder.js';

export const OPENCODE_REMINDER_PLUGIN_SOURCE = `// ${OPENCODE_REMINDER_PLUGIN_MARKER}
// Installed by CodeGraph. Re-running codegraph install updates this file.
import { existsSync } from "node:fs"
import { extname, isAbsolute, join, relative, resolve } from "node:path"

const SOURCE_EXTENSIONS = new Set([
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx", ".ipp", ".inl", ".tcc",
  ".m", ".mm", ".cs", ".cshtml", ".razor", ".java", ".kt", ".kts", ".scala", ".sc",
  ".go", ".rs", ".swift", ".dart", ".pas", ".dpr", ".dpk", ".lpr", ".dfm", ".fmx",
  ".py", ".pyw", ".rb", ".rake", ".php", ".module", ".install", ".theme", ".inc",
  ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".xsjs", ".xsjslib",
  ".vue", ".svelte", ".lua", ".luau", ".liquid", ".twig",
])

const OUTPUT_SOURCE_RE = /(?:^|[\\\\/\\s(])[^:\\r\\n]*\\.(?:c|h|cc|cpp|cxx|hh|hpp|hxx|ipp|inl|tcc|m|mm|cs|cshtml|razor|java|kt|kts|scala|sc|go|rs|swift|dart|pas|dpr|dpk|lpr|dfm|fmx|py|pyw|rb|rake|php|module|install|theme|inc|ts|tsx|mts|cts|js|jsx|mjs|cjs|xsjs|xsjslib|vue|svelte|lua|luau|liquid|twig)(?=[:\\s)\\]\\r\\n]|$)/im
const SOURCE_DISCOVERY_COMMAND_RE = /(?:^|[|;&]\\s*|\\b)(?:rg|grep|findstr|select-string|get-childitem|gci|dir|ls|get-content|gc|type)\\b/i
const SYSTEM_REMINDER_MARKER = "[CODEGRAPH_WX_DYNAMIC_SYSTEM_REMINDER]"
const SYSTEM_REMINDER = SYSTEM_REMINDER_MARKER + "\\n" +
  "优先使用 CodeGraph wx 系列工具，而不是read、grep、Bash源码搜索等。仅在文件未索引、CodeGraph明确报告索引过期或等待重新索引、连续精确符号查询仍无结果、查找AST图谱可能不覆盖的引用，或读取配置/文档/Markdown时，才回退到相关文件或行的原生搜索/读取。"

function findIndexRoot(start) {
  if (!start || typeof start !== "string") return null
  // OpenCode supplies the worktree/project root. Do not walk above it: a
  // stray ~/.codegraph-wx directory must not make every unrelated project look
  // indexed.
  const root = resolve(start)
  return existsSync(join(root, ".codegraph-wx")) ? root : null
}

function absolutePath(value, directory) {
  if (typeof value !== "string" || value.trim() === "") return null
  return resolve(isAbsolute(value) ? value : join(directory, value))
}

function isInside(root, file) {
  const rel = relative(root, file)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

function isSourcePath(value) {
  return typeof value === "string" && SOURCE_EXTENSIONS.has(extname(value).toLowerCase())
}

function toolPath(args) {
  if (!args || typeof args !== "object") return null
  return args.filePath ?? args.path ?? args.file ?? null
}

function shellCommand(args) {
  if (!args || typeof args !== "object") return ""
  const value = args.command ?? args.cmd ?? args.script
  return typeof value === "string" ? value : ""
}

function sessionSet(map, sessionID) {
  let value = map.get(sessionID)
  if (!value) {
    value = new Set()
    map.set(sessionID, value)
  }
  return value
}

export const CodeGraphReminderPlugin = async ({ directory, worktree }) => {
  const projectDirectory = resolve(worktree || directory || process.cwd())
  const modifiedBySession = new Map()
  const pendingBySession = new Set()

  return {
    "tool.execute.after": async (input, output) => {
      const tool = String(input.tool || "").toLowerCase()
      const sessionID = input.sessionID || "default"
      const args = input.args && typeof input.args === "object" ? input.args : {}

      if (tool.startsWith("codegraph_wx_")) {
        pendingBySession.delete(sessionID)
        return
      }

      if (tool === "edit" || tool === "write") {
        const changed = absolutePath(toolPath(args), projectDirectory)
        if (changed) sessionSet(modifiedBySession, sessionID).add(changed.toLowerCase())
        // Exploration has transitioned into implementation. A later native
        // source fallback will arm a fresh reminder when appropriate.
        pendingBySession.delete(sessionID)
        return
      }

      const directSourceTool = tool === "grep" || tool === "read"
      const command = shellCommand(args)
      const shellSourceTool = (tool === "bash" || tool === "shell") &&
        SOURCE_DISCOVERY_COMMAND_RE.test(command)
      if (!directSourceTool && !shellSourceTool) return

      const indexRoot = findIndexRoot(projectDirectory)
      if (!indexRoot) return

      const rawPath = toolPath(args)
      const target = absolutePath(rawPath, projectDirectory)
      if (target && !isInside(indexRoot, target)) return

      const outputText = typeof output?.output === "string" ? output.output : ""
      const sourceMatch = (target && isSourcePath(target)) ||
        ((tool === "grep" || shellSourceTool) && OUTPUT_SOURCE_RE.test(outputText)) ||
        (shellSourceTool && OUTPUT_SOURCE_RE.test(command))
      if (!sourceMatch) return

      if (target && modifiedBySession.get(sessionID)?.has(target.toLowerCase())) return

      pendingBySession.add(sessionID)
    },
    "experimental.chat.system.transform": async (input, output) => {
      const sessionID = input?.sessionID
      if (!sessionID || !pendingBySession.has(sessionID)) return
      if (!output || !Array.isArray(output.system)) return
      if (output.system.some((part) => typeof part === "string" && part.includes(SYSTEM_REMINDER_MARKER))) return

      // Mutate in place: OpenCode passes the live system prompt array to this
      // hook and later converts each entry into a role=system model message.
      // Keep the flag armed across requests so an auxiliary title/summary
      // inference cannot consume the reminder before the main agent sees it.
      output.system.push(SYSTEM_REMINDER)
    },
    event: async ({ event }) => {
      if (event?.type !== "session.idle" && event?.type !== "session.deleted") return
      const sessionID = event.properties?.info?.id ?? event.properties?.sessionID
      if (!sessionID) return
      modifiedBySession.delete(sessionID)
      pendingBySession.delete(sessionID)
    },
  }
}
`;
