import { maskCStyleCommentsAndLiterals } from './grammars';

interface Range { start: number; end: number; insideType?: boolean }
interface State { stack: Array<boolean | 'type'>; parens: number; brackets: number; header: number }
interface Conditional { entry: State; branches: State[]; hasElse: boolean }

/** Source evidence independent of tree-sitter's error-recovered parent chain.
 * Branches are scanned separately: two alternative opening braces must not
 * swallow a real global after #endif. An ambiguous join keeps only the common
 * scope prefix, never guessing that later declarations are local.
 */
export class CCppSourceScope {
  private readonly executable: Range[] = [];
  private readonly directives: Range[] = [];
  private readonly unclosedStandaloneBody: boolean;
  private readonly balanced: boolean;

  constructor(source: string) {
    const code = maskCStyleCommentsAndLiterals(source);
    let state: State = { stack: [], parens: 0, brackets: 0, header: 0 };
    const conditions: Conditional[] = [];
    const copy = (s: State): State => ({ ...s, stack: [...s.stack] });
    let activeStart: number | null = null;
    let activeInsideType = false;
    const transition = (offset: number): void => {
      const active = state.stack.includes(true);
      if (active && activeStart === null) {
        activeStart = offset;
        activeInsideType = state.stack.includes('type');
      }
      if (!active && activeStart !== null) {
        this.executable.push({ start: activeStart, end: offset, insideType: activeInsideType });
        activeStart = null;
      }
    };
    for (let i = 0; i < code.length; i++) {
      const char = code[i]!;
      if (char === '#' && /^[ \t]*$/.test(code.slice(code.lastIndexOf('\n', i - 1) + 1, i))) {
        let end = code.indexOf('\n', i);
        while (end >= 0 && /\\\r?$/.test(source.slice(i, end))) end = code.indexOf('\n', end + 1);
        if (end < 0) end = code.length;
        this.directives.push({ start: i, end });
        const directive = /^#[ \t]*(\w+)/.exec(code.slice(i, end))?.[1];
        if (directive === 'if' || directive === 'ifdef' || directive === 'ifndef') {
          conditions.push({ entry: copy(state), branches: [], hasElse: false });
        } else if (directive === 'else' || directive === 'elif') {
          const conditional = conditions.at(-1);
          if (conditional) {
            conditional.branches.push(copy(state));
            conditional.hasElse ||= directive === 'else';
            state = copy(conditional.entry);
          }
        } else if (directive === 'endif') {
          const conditional = conditions.pop();
          if (conditional) {
            const branches = [...conditional.branches, copy(state)];
            if (!conditional.hasElse) branches.push(conditional.entry);
            state = copy(branches[0]!);
            for (const branch of branches.slice(1)) {
              let common = 0;
              while (common < state.stack.length && common < branch.stack.length
                && state.stack[common] === branch.stack[common]) common++;
              state.stack.length = common;
              if (state.parens !== branch.parens) state.parens = conditional.entry.parens;
              if (state.brackets !== branch.brackets) state.brackets = conditional.entry.brackets;
            }
          }
        }
        // Directives are not part of a declaration prefix. Preserve a header
        // spanning a conditional parameter list, otherwise start on fresh code.
        if (state.parens === 0 && state.brackets === 0) state.header = end + 1;
        transition(i);
        i = end;
        continue;
      }
      if (char === '(') state.parens++;
      else if (char === ')') state.parens = Math.max(0, state.parens - 1);
      else if (char === '[') state.brackets++;
      else if (char === ']') state.brackets = Math.max(0, state.brackets - 1);
      else if (char === '{' && state.parens === 0 && state.brackets === 0) {
        const header = code.slice(state.header, i).trim();
        // A type template parameter is not the declaration's container.
        const bare = stripTemplateParameters(header);
        const callable = /\)\s*(?:(?:const|volatile|noexcept|override|final)\b\s*|&&?\s*)*(?:(?:->|requires\b|:)\s*[\s\S]*)?$/.test(bare)
          && !/^\s*(?:return|case)\b/.test(bare);
        // A base class can be decltype(factory()); that trailing ')' does
        // not turn the class body into executable code. A base-list colon
        // precedes its first '(' (unlike a constructor initializer list).
        const beforeParen = bare.split('(', 1)[0]!;
        const baseList = /(^|[^:]):([^:]|$)/.test(beforeParen);
        const container = /^(?:(?:inline|export|typedef)\s+)*(?:namespace|class|struct|union|enum)\b/.test(bare)
          && (!callable || baseList);
        const lambda = /(?:^|[=({,:])\s*\[[^\]]*\]\s*(?:\([^)]*\))?\s*(?:mutable\s*)?(?:noexcept\s*)?(?:->[^;{}]+)?$/.test(bare);
        state.stack.push(container && !/\bnamespace\b/.test(bare) ? 'type'
          : !container && (state.stack.includes(true) || lambda || callable));
        state.header = i + 1;
        transition(i + 1);
      } else if (char === '}' && state.parens === 0 && state.brackets === 0) {
        state.stack.pop();
        state.header = i + 1;
        transition(i);
      } else if (char === ';' && state.parens === 0 && state.brackets === 0) {
        state.header = i + 1;
      }
    }
    // An unmatched opening brace may be supplied/closed by an unresolved
    // macro. It is not proof that every later declaration is local. Only
    // completed ranges may suppress symbols or blank an auxiliary body.
    this.unclosedStandaloneBody = state.stack.length === 1 && state.stack[0] === true;
    this.balanced = state.stack.length === 0 && state.parens === 0 && state.brackets === 0;
  }

  isExecutable(offset: number): boolean { return this.contains(this.executable, offset); }
  isDirective(offset: number): boolean { return this.contains(this.directives, offset); }
  hasUnclosedStandaloneBody(): boolean { return this.unclosedStandaloneBody; }
  isBalanced(): boolean { return this.balanced; }

  /** Auxiliary declaration parsing needs body boundaries, not statements.
   * Preserve every offset/newline so recovered declarations still map back to
   * the invocation and following source body. Primary parsing owns the calls.
   */
  maskExecutableBodies(source: string, invocationLines?: ReadonlySet<number>): string {
    const parts: string[] = [];
    let offset = 0;
    let line = 1, nextNewline = source.indexOf('\n');
    for (const range of this.executable) {
      while (nextNewline >= 0 && nextNewline < range.start) {
        line++;
        nextNewline = source.indexOf('\n', nextNewline + 1);
      }
      // A macro-supplied opening brace may have an unresolved macro closer.
      // Only isolate bodies whose opening brace remains source-written;
      // otherwise a later unrelated '}' could masquerade as their boundary.
      if (invocationLines?.has(line)) continue;
      // Unresolved constructor/member macros need their original class-body
      // evidence. Only isolate standalone function bodies in this sparse pass.
      if (range.insideType) continue;
      const body = source.slice(range.start, range.end).replace(/[^\r\n]/g, ' ');
      // Keep a null statement: `{}` after a qualified declarator can be
      // parsed as a braced initializer instead of a function definition.
      // Reuse a non-newline character so all coordinates remain unchanged.
      parts.push(source.slice(offset, range.start), body.replace(/ /, ';'));
      offset = range.end;
    }
    parts.push(source.slice(offset));
    const masked = parts.join('');
    if (!invocationLines?.size) return masked;
    const originalLines = source.split('\n');
    // One expanded invocation can itself define nested types and methods.
    // Those declarations are the purpose of this parse, so never erase their
    // source line while masking the following user-written body statements.
    return masked.split('\n').map((line, i) => invocationLines.has(i + 1) ? originalLines[i]! : line).join('\n');
  }

  private contains(ranges: Range[], offset: number): boolean {
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ranges[mid]!.start <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && offset < ranges[lo - 1]!.end;
  }
}

function stripTemplateParameters(header: string): string {
  let remaining = header;
  while (/^template\s*</.test(remaining)) {
    let depth = 0, end = -1;
    for (let i = remaining.indexOf('<'); i < remaining.length; i++) {
      if (remaining[i] === '<') depth++;
      else if (remaining[i] === '>' && --depth === 0) { end = i; break; }
    }
    if (end < 0) break;
    remaining = remaining.slice(end + 1).trimStart();
  }
  return remaining;
}
