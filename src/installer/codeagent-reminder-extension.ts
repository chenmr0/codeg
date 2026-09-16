/**
 * Dependency-free CodeAgent 3.0 extension installed beside the CodeGraph MCP
 * entry.
 *
 * CodeAgent's `tool.executeAfter` hook detects the exact decision point where
 * an agent has started a native grep/read chain. A session-scoped pending flag
 * then lets `experimental.chat.messagesTransform` append the reminder to the
 * last user message of the next model request. Main sessions that never
 * fall back pay no prompt-token cost, and native tool output remains
 * untouched.
 *
 * Subagent startup also uses systemTransform to reuse the same short reminder.
 * Keep messagesTransform for later native-tool fallback: CodeAgent caches
 * the system-prompt hook result per session/compact cycle (prompt-cache
 * preservation), so it fires once per session and cannot respond to a
 * mid-session fallback. messagesTransform fires before every API request and
 * is the only dynamic channel. Two constraints shape the injection:
 *
 *   - The reminder must be appended to the last user message, never prepended
 *     as a new message: the request fingerprint is computed from the first
 *     message AFTER this hook, so a prepend would corrupt attribution.
 *   - The edit must be copy-on-write: normalized messages can share object
 *     references with the session history, so mutating content in place would
 *     leak the reminder into the transcript and re-send it forever.
 *
 * Keep the generated file plain JavaScript. CodeAgent (Bun) imports .ts
 * extensions directly, and this hook shape needs no @codeagent/extension
 * import.
 */

export const CODEAGENT_REMINDER_EXTENSION_MARKER = 'CODEGRAPH_WX_CODEAGENT_REMINDER_EXTENSION';
export const CODEAGENT_REMINDER_EXTENSION_FILENAME = 'codegraph-wx-reminder.ts';

export const CODEAGENT_REMINDER_EXTENSION_SOURCE = `// ${CODEAGENT_REMINDER_EXTENSION_MARKER}
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
  // CodeAgent supplies the worktree/project root. Do not walk above it: a
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
  // file_path is the snake_case key CodeAgent's Read/Edit/Write tools use;
  // filePath/path/file cover MCP and opencode-style tools.
  return args.file_path ?? args.filePath ?? args.path ?? args.file ?? null
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

export default async function CodeGraphReminderExtension({ client, directory, worktree }) {
  const projectDirectory = resolve(worktree || directory || process.cwd())
  const modifiedBySession = new Map()
  const pendingBySession = new Set()
  // messagesTransform receives no sessionID, so the main session is read
  // from the client. Subagent tool calls carry the subagent's agentId in
  // executeAfter; dual-arming the main session keeps their fallbacks visible
  // to the orchestrator's requests.
  const mainSessionID = () =>
    typeof client?.getSessionId === "function" ? String(client.getSessionId() || "") : ""

  return {
    tool: {
      executeAfter: async (input, output) => {
        const tool = String(input.tool || "").toLowerCase()
        const sessionID = input.sessionID || mainSessionID() || "default"
        const args = input.args && typeof input.args === "object" ? input.args : {}

        if (tool.startsWith("mcp__codegraph_wx__") || tool.startsWith("codegraph_wx_")) {
          pendingBySession.delete(sessionID)
          pendingBySession.delete(mainSessionID())
          return
        }

        if (tool === "edit" || tool === "write") {
          const changed = absolutePath(toolPath(args), projectDirectory)
          if (changed) {
            sessionSet(modifiedBySession, sessionID).add(changed.toLowerCase())
            const main = mainSessionID()
            if (main && main !== sessionID) {
              sessionSet(modifiedBySession, main).add(changed.toLowerCase())
            }
          }
          // Exploration has transitioned into implementation. A later native
          // source fallback will arm a fresh reminder when appropriate.
          pendingBySession.delete(sessionID)
          pendingBySession.delete(mainSessionID())
          return
        }

        const directSourceTool = tool === "grep" || tool === "read" || tool === "glob"
        const command = shellCommand(args)
        const shellSourceTool = (tool === "bash" || tool === "powershell") &&
          SOURCE_DISCOVERY_COMMAND_RE.test(command)
        if (!directSourceTool && !shellSourceTool) return

        const indexRoot = findIndexRoot(projectDirectory)
        if (!indexRoot) return

        const rawPath = toolPath(args)
        const target = absolutePath(rawPath, projectDirectory)
        if (target && !isInside(indexRoot, target)) return

        const outputText = typeof output?.output === "string" ? output.output : ""
        // Glob carries a pattern, not a file path, so its source relevance
        // comes from the pattern itself (e.g. "src/**/*.cpp") or the listed
        // filenames. This is a deliberate extension over the opencode plugin,
        // which only watches grep/read.
        const pattern = typeof args.pattern === "string" ? args.pattern : ""
        const sourceMatch = (target && isSourcePath(target)) ||
          ((tool === "grep" || shellSourceTool) && OUTPUT_SOURCE_RE.test(outputText)) ||
          (tool === "glob" && (OUTPUT_SOURCE_RE.test(pattern) || OUTPUT_SOURCE_RE.test(outputText))) ||
          (shellSourceTool && OUTPUT_SOURCE_RE.test(command))
        if (!sourceMatch) return

        if (target && modifiedBySession.get(sessionID)?.has(target.toLowerCase())) return

        pendingBySession.add(sessionID)
        const main = mainSessionID()
        if (main && main !== sessionID) pendingBySession.add(main)
      },
    },
    experimental: {
      chat: {
        systemTransform: async (input, output) => {
          if (!(input?.agentID || output?.agentID) || !findIndexRoot(projectDirectory)) return
          if (!Array.isArray(output?.system)) return
          if (output.system.some(part => typeof part === "string" && part.includes(SYSTEM_REMINDER_MARKER))) return
          output.system.push(SYSTEM_REMINDER)
        },
        messagesTransform: async (_input, output) => {
          const sessionID = mainSessionID()
          if (!sessionID || !pendingBySession.has(sessionID)) return
          if (!output || !Array.isArray(output.messages)) return

          // Append the reminder to the last user message so the model sees it
          // with the current turn's input. Copy-on-write: normalized messages
          // can share object references with the session history, so the
          // element is replaced with a shallow copy instead of mutating
          // content in place. Keep the flag armed across requests so an
          // auxiliary title/summary inference cannot consume the reminder
          // before the main agent sees it.
          for (let i = output.messages.length - 1; i >= 0; i--) {
            const msg = output.messages[i]
            if (!msg || msg.type !== "user" || !msg.message || typeof msg.message !== "object") continue
            const content = msg.message.content
            if (typeof content === "string") {
              if (content.includes(SYSTEM_REMINDER_MARKER)) return
              output.messages[i] = {
                ...msg,
                message: { ...msg.message, content: content + "\\n\\n" + SYSTEM_REMINDER },
              }
            } else if (Array.isArray(content)) {
              if (content.some((block) =>
                block && typeof block === "object" &&
                typeof block.text === "string" && block.text.includes(SYSTEM_REMINDER_MARKER))) return
              output.messages[i] = {
                ...msg,
                message: {
                  ...msg.message,
                  content: [...content, { type: "text", text: SYSTEM_REMINDER }],
                },
              }
            }
            return
          }
        },
      },
    },
    event: async (event) => {
      if (event?.type !== "session.idle") return
      const sessionID = event.sessionID
      if (!sessionID) return
      modifiedBySession.delete(sessionID)
      pendingBySession.delete(sessionID)
    },
  }
}
`;
