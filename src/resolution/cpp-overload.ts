import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { cppIdentityTokens as tokens, isCppIdentityIdentifier as identifier } from '../extraction/c-cpp-macro-types';

type Callback = { kind:'callback'; owner:string | null; result:string; parameters:string[]; qualifiers:string; noexcept:boolean };
type Parameter = Callback | {kind:'scalar'; type:string};
type Callable = { result:string; parameters:string[][]; qualifiers:string; noexcept:boolean };
const CV = new Set(['const', 'volatile']);
const BUILTIN = new Set(['void','bool','char','wchar_t','char8_t','char16_t','char32_t','short','int','long','signed','unsigned','float','double']);
const MAX_SOURCE = 16 * 1024;

function closeAt(ts: string[], start: number): number {
  const pairs: Record<string,string> = {'(':')','[':']','{':'}','<':'>'};
  const stack: string[] = [];
  for (let i=start;i<ts.length;i++) {
    const token=ts[i]!;
    if (pairs[token]) stack.push(pairs[token]!);
    else if (Object.values(pairs).includes(token)) {
      if (stack.pop()!==token) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

function parameters(ts: string[]): string[][] | null {
  if (!ts.length || ts.join(' ')==='void') return [];
  const parts: string[][]=[];
  let start=0;
  for(let i=0;i<=ts.length;i++) {
    if (['(','[','{','<'].includes(ts[i]!)) { const end=closeAt(ts,i); if(end<0)return null; i=end; }
    else if (i===ts.length || ts[i]===',') {
      if (i===start) return null;
      parts.push(ts.slice(start,i)); start=i+1;
    }
  }
  return parts;
}

/** A deliberately bounded type grammar. Unknown types never compare equal. */
function scalar(raw: string[], parameter: boolean): string | null {
  const ts=[...raw];
  if (parameter && ts.length>1 && identifier(ts.at(-1)!) && !BUILTIN.has(ts.at(-1)!) && !CV.has(ts.at(-1)!)) ts.pop();
  if (!ts.length || ts.some(t=>!BUILTIN.has(t) && !CV.has(t))) return null;
  const base=ts.filter(t=>!CV.has(t));
  if (!base.length) return null;
  const word=base.find(t=>['void','bool','char','wchar_t','char8_t','char16_t','char32_t','float','double'].includes(t)) ?? 'int';
  const size=base.filter(t=>t==='long'||t==='short');
  const sign=base.includes('unsigned')?'unsigned':word==='char'&&base.includes('signed')?'signed':'';
  const cv=parameter?[]:[...new Set(ts.filter(t=>CV.has(t)))].sort();
  return [...cv,sign,...size,word].filter(Boolean).join(' ');
}

function suffix(ts: string[]): {qualifiers:string; noexcept:boolean} | null {
  let noexcept=false;
  const qualifiers: string[]=[];
  for(let i=0;i<ts.length;i++) {
    const t=ts[i]!;
    if(CV.has(t)||t==='&'||t==='&&') qualifiers.push(t);
    else if(t==='noexcept') {
      noexcept=true;
      if(ts[i+1]==='(') {
        if(ts[i+3]!==')'||!['true','false'].includes(ts[i+2]!)) return null;
        noexcept=ts[i+2]==='true'; i+=3;
      }
    } else return null;
  }
  return {qualifiers:qualifiers.sort().join(' '),noexcept};
}

function callable(node: Node): Callable | null {
  if(!node.signature || node.typeParameters?.length) return null;
  const ts=tokens(node.signature);
  // A declaration terminator is not part of its function type. Remove only
  // this final token, and continue rejecting unsupported suffix syntax.
  if(node.isDeclaration && ts.at(-1)===';') ts.pop();
  const name=ts.findIndex((t,i)=>t===node.name && ts[i+1]==='(');
  if(name<0) return null;
  let start=name;
  while(start>=2 && ts[start-1]==='::' && identifier(ts[start-2]!)) start-=2;
  if(ts[start-1]==='::') start--;
  const result=scalar(ts.slice(0,start).filter(t=>!['static','inline','constexpr','consteval','extern'].includes(t)),false);
  const close=closeAt(ts,name+1);
  if(!result || close<0) return null;
  const params=parameters(ts.slice(name+2,close)), tail=suffix(ts.slice(close+1));
  return params && tail ? {result,parameters:params,...tail} : null;
}

function nominalOwner(raw: string[], scope: Node, context: ResolutionContext): string | null {
  const absolute=raw[0]==='::';
  const ts=absolute?raw.slice(1):raw;
  if(!ts.length || ts.length%2!==1 || !ts.every((t,i)=>i%2?t==='::':identifier(t))) return null;
  // Relative lookup inside a namespace/class can involve aliases, imports or
  // bases. This bounded matcher only proves global or explicitly absolute names.
  if(!absolute && scope.qualifiedName!==scope.name) return null;
  const name=ts.join('');
  const matches=context.getNodesByQualifiedName(name).filter(n=>n.language==='cpp');
  if(matches.length!==1 || matches.some(n=>!['struct','class','union'].includes(n.kind) || n.typeParameters?.length)) return null;
  return name;
}

function parameter(raw: string[], node: Node, context: ResolutionContext): Parameter | null {
  let ts=raw;
  for(let i=0;i<ts.length;i++) {
    if(['(','[','{','<'].includes(ts[i]!)) { const end=closeAt(ts,i); if(end<0)return null; i=end; }
    else if(ts[i]==='=') { ts=ts.slice(0,i); break; }
  }
  const simple=scalar(ts,true);
  if(simple) return {kind:'scalar',type:simple};
  const open=ts.indexOf('('), end=open<0?-1:closeAt(ts,open);
  if(open<0 || end<0 || ts[end+1]!=='(') return null;
  const result=scalar(ts.slice(0,open),false);
  const pointer=ts.slice(open+1,end), star=pointer.indexOf('*');
  if(!result || star<0) return null;
  let owner:string|null=null;
  if(star>0) {
    if(pointer[star-1]!=='::') return null;
    owner=nominalOwner(pointer.slice(0,star-1),node,context);
    if(!owner) return null;
  }
  const after=pointer.slice(star+1).filter(t=>!CV.has(t));
  if(after.length>1 || after.length===1&&!identifier(after[0]!)) return null;
  const close=closeAt(ts,end+1);
  if(close<0) return null;
  const nested=parameters(ts.slice(end+2,close)), tail=suffix(ts.slice(close+1));
  if(!nested || !tail || !owner && tail.qualifiers) return null;
  const types=nested.map(p=>scalar(p,true));
  if(types.some(t=>t===null)) return null;
  return {kind:'callback',owner,result,parameters:types as string[],...tail};
}

function sourceAt(ref: UnresolvedRef, context: ResolutionContext): {args:string[][]; prefix:string[]; caller:Node} | null {
  const caller=context.getNodesInFile(ref.filePath).find(n=>n.id===ref.fromNodeId);
  const lines=context.getFileLines?.(ref.filePath) ?? context.readFile(ref.filePath)?.split(/\r?\n/);
  if(!caller || !lines || caller.startLine>ref.line || caller.endLine<ref.line || ref.line-caller.startLine>256) return null;
  let prefix='',tail='';
  for(let row=caller.startLine-1;row<ref.line;row++) {
    const text=lines[row]; if(text===undefined)return null;
    prefix+=text.slice(row===caller.startLine-1?caller.startColumn:0,row===ref.line-1?ref.column:undefined)+'\n';
    if(prefix.length>MAX_SOURCE)return null;
  }
  for(let row=ref.line-1;row<Math.min(lines.length,ref.line+32);row++) {
    tail+=lines[row]!.slice(row===ref.line-1?ref.column:0)+'\n';
    if(tail.length>MAX_SOURCE)return null;
    // Stop as soon as the complete call has been captured; later code is not evidence.
    const ts=tokens(tail), name=tokens(ref.referenceName.replace(/\./g,'::'));
    if(!name.every((t,i)=>ts[i]===t) || ts[name.length]!=='(') return null;
    const close=closeAt(ts,name.length);
    if(close>=0) {
      const args=parameters(ts.slice(name.length+1,close));
      return args?{args,prefix:tokens(prefix),caller}:null;
    }
  }
  return null;
}

function hasPossibleMacroExpansion(ts: string[], context: ResolutionContext): boolean {
  // Source-spelled components are not expanded evidence, including members
  // after :: (and even keyword-like macro names used as scalar arguments).
  // A known function-like macro without a following '(' is inert. For other
  // definitions we cannot prove the active #define/#undef/include environment.
  return ts.some((token,index)=>identifier(token) && context.getNodesByName(token).some(node=>{
    if(node.kind!=='macro') return false;
    const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const functionLike=new RegExp(`^\\s*#\\s*define\\s+${escaped}\\(`).test(node.signature ?? '');
    return !functionLike || ts[index+1]==='(';
  }));
}

function before(line:number, column:number, otherLine:number, otherColumn:number): boolean {
  return line<otherLine || line===otherLine && column<otherColumn;
}

function contains(outer:Node, inner:Node): boolean {
  return outer.filePath===inner.filePath
    && before(outer.startLine,outer.startColumn,inner.startLine,inner.startColumn)
    && !before(outer.endLine,outer.endColumn,inner.endLine,inner.endColumn);
}

/** An out-of-line definition omits `static` even when its member is static.
 * Recover that property only from the matching declaration in its unique
 * same-file class, never from a same-named overload or another translation
 * unit. Missing `static` on a definition is not evidence of non-staticness.
 */
function memberIdentity(node:Node, fn:Callable, context:ResolutionContext): {owner:string|null}|null {
  const ownerName=node.qualifiedName.slice(0,-node.name.length-2);
  const owners=context.getNodesByQualifiedName(ownerName).filter(n=>n.language==='cpp' && n.filePath===node.filePath);
  if(owners.length!==1 || !['struct','class','union'].includes(owners[0]!.kind) || owners[0]!.typeParameters?.length) return null;
  const owner=owners[0]!;
  // Header identities also require include visibility and dependency-aware
  // replay after header edits. Neither is proved by this bounded matcher.
  if(contains(owner,node)) return {owner:node.isStatic?null:ownerName};
  if(before(node.startLine,node.startColumn,owner.endLine,owner.endColumn)) return null;
  const identity=(candidate:Callable)=>JSON.stringify([candidate.result,candidate.parameters.map(p=>scalar(p,true)),candidate.qualifiers,candidate.noexcept]);
  const key=identity(fn);
  const declarations=context.getNodesByQualifiedName(node.qualifiedName).filter(n=>n.language==='cpp'
    && n.kind==='method' && contains(owner,n));
  const matching=declarations.filter(declaration=>{
    const candidate=callable(declaration);
    return candidate && candidate.parameters.every(p=>scalar(p,true)!==null) && identity(candidate)===key;
  });
  if(!matching.length || matching.some(n=>!!n.isStatic!==!!matching[0]!.isStatic)) return null;
  return {owner:matching[0]!.isStatic?null:ownerName};
}

function argument(ts: string[], site: NonNullable<ReturnType<typeof sourceAt>>,
  ref: UnresolvedRef, context: ResolutionContext): Parameter[] | null {
  if(hasPossibleMacroExpansion(ts,context)) return null;
  if(ts.length===1) {
    if(/^\d+$/.test(ts[0]!) && Number(ts[0])<=0x7fffffff) return [{kind:'scalar',type:'int'}];
    if(ts[0]==='true'||ts[0]==='false') return [{kind:'scalar',type:'bool'}];
  }
  if(ts[0]!=='&') return null;
  const absolute=ts[1]==='::', name=ts.slice(absolute?2:1);
  if(!name.length || name.length%2!==1 || !name.every((t,i)=>i%2?t==='::':identifier(t))) return null;
  const head=name[0]!;
  if(!absolute) {
    if(site.caller.qualifiedName!==site.caller.name || site.caller.kind!=='function') return null;
    // A local/parameter/alias can shadow the global function or class. Accept
    // earlier address-of uses, but no declaration or other unexplained use.
    if(site.prefix.some(t=>['using','typedef','template','class','struct','union','enum','#','[',']'].includes(t))) return null;
    if(site.prefix.some((t,i)=>t===head && !(site.prefix[i-1]==='&'
      && (name.length>1 ? site.prefix[i+1]==='::' : [')',',',';'].includes(site.prefix[i+1]!))))) return null;
  }
  // A graph-wide definition is not proof that its overload was declared at
  // this call. Use the visible declaration itself; a later definition of that
  // same function is unnecessary. Other-file/later nodes provide no witness;
  // a separate identity check may recover an existing method's static flag.
  const matches=context.getNodesByQualifiedName(name.join('')).filter(n=>n.language==='cpp'
    && n.filePath===ref.filePath
    && (n.startLine<ref.line || n.startLine===ref.line && n.startColumn<ref.column));
  if(!matches.length || matches.some(n=>!['function','method'].includes(n.kind))) return null;
  const result:Parameter[]=[];
  const functions=matches.map(node=>({node,fn:callable(node)}));
  if(functions.some(f=>!f.fn))return null;
  for(const {node,fn:parsed} of functions) {
    const fn=parsed!;
    const params=fn.parameters.map(p=>scalar(p,true));
    if(params.some(p=>p===null))return null;
    let owner:string|null=null;
    if(node.kind==='method') {
      const identity=memberIdentity(node,fn,context);
      if(!identity) return null;
      owner=identity.owner;
    }
    result.push({kind:'callback',owner,result:fn.result,parameters:params as string[],qualifiers:fn.qualifiers,noexcept:fn.noexcept});
  }
  return result;
}

// null = unknown conversion, Infinity = proven incompatible, 0/1 = exact/standard.
function conversion(actual: Parameter, expected: Parameter, context: ResolutionContext): number | null {
  if(actual.kind==='scalar'||expected.kind==='scalar') {
    if(actual.kind==='scalar'&&expected.kind==='scalar') return actual.type===expected.type?0:null;
    // An indexed function is only a witness from a possibly incomplete
    // address-of overload set. It does not establish a uniquely typed value
    // which may be converted to bool.
    return expected.kind==='scalar'&&expected.type==='bool'?null:Infinity;
  }
  if(actual.owner!==expected.owner) {
    if(!actual.owner||!expected.owner) return Infinity;
    return context.hasCppInheritance?.(actual.owner)===false && context.hasCppInheritance?.(expected.owner)===false ? Infinity:null;
  }
  if(actual.result!==expected.result || JSON.stringify(actual.parameters)!==JSON.stringify(expected.parameters)
    || actual.qualifiers!==expected.qualifiers || expected.noexcept&&!actual.noexcept) return Infinity;
  return actual.noexcept&&!expected.noexcept?1:0;
}

/** Macro overloads share a source anchor, so name/proximity scores tie. Never
 * let an ID hash decide which overload receives the calls edge. This gate runs
 * after name/import/framework selection and also in read-only resolver workers.
 * It does not claim to implement general C++ overload resolution.
 */
export function refineCppOverload(result: ResolvedRef, target: Node | null | undefined, ref: UnresolvedRef,
  context: ResolutionContext): ResolvedRef | null {
  if(ref.language!=='cpp'||ref.referenceKind!=='calls'||!target||!['function','method'].includes(target.kind))return result;
  const group=context.getNodesByQualifiedName(target.qualifiedName).filter(n=>n.language==='cpp'
    && n.filePath===target.filePath && n.startLine===target.startLine && n.startColumn===target.startColumn
    && ['function','method'].includes(n.kind));
  if(group.length<2)return result;
  // Explicit parameter ranks say nothing about the implicit object's cv/ref
  // qualification. Do not choose among non-static member overloads until that
  // receiver evidence is supported. Static members need no implicit object.
  if(group.some(n=>n.kind==='method' && !n.isStatic)) return null;
  const site=sourceAt(ref,context);
  if(!site)return null;
  const args=site.args.map(a=>argument(a,site,ref,context));
  const viable:Array<{node:Node; ranks:number[]|null}>=[];
  for(const node of group) {
    const fn=callable(node);
    if(!fn) {viable.push({node,ranks:null});continue;}
    if(fn.parameters.length!==args.length) {viable.push({node,ranks:null});continue;}
    const params=fn.parameters.map(p=>parameter(p,node,context));
    const ranks=args.map((values,i)=>{
      if(!values||!params[i])return null;
      const ranks=values.map(a=>conversion(a,params[i]!,context));
      return ranks.includes(null)?null:Math.min(...ranks as number[]);
    });
    if(ranks.includes(Infinity))continue;
    viable.push({node,ranks:ranks.includes(null)?null:ranks as number[]});
  }
  if(!viable.length||viable.some(v=>v.ranks===null))return null;
  const best=viable.filter(a=>viable.every(b=>a===b || a.ranks!.every((r,i)=>r<=b.ranks![i]!)
    && a.ranks!.some((r,i)=>r<b.ranks![i]!)));
  // A conversion-only winner relies on excluding all missing alternatives.
  // The graph does not prove the address candidate set complete, so retain
  // such calls as unresolved; an exact positive witness is required here.
  return best.length===1 && best[0]!.ranks!.every(rank=>rank===0)
    ? {...result,targetNodeId:best[0]!.node.id}:null;
}
