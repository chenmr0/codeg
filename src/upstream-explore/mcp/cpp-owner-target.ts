import type { Node } from '../types';

/** A separately named C++ owner and a precise method spelling can identify
 * the same body as Owner::method. This is selection evidence, NOT a decl/def
 * identity bridge: truncated signatures never authorize merging overloads.
 * Return at most one concrete body, after checking the complete name family. */
export function coNamedCppMethodTarget(
  token: string,
  candidates: readonly Node[],
  ownerTokens: readonly string[],
  ownerNodes: (name: string) => readonly Node[],
): Node | undefined {
  // Ordinary prose ("Service process") is not an exact body request.
  if (!/^[A-Za-z_$][\w$]*$/.test(token) || !/[_$]|[a-z][A-Z]/.test(token)) return undefined;
  const ownerOf = (node: Node) => node.qualifiedName.replace(/^::/, '').split('::').slice(0, -1).join('::');
  const definitions = candidates.filter(node => node.language === 'cpp' && node.kind === 'method'
    && node.name === token && node.isDeclaration !== true);
  const selected = new Map<string, Node>();
  for (const spelling of new Set(ownerTokens)) {
    const requested = spelling.replace(/^::/, '');
    if (!/^[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(requested)) continue;
    const simple = requested.split('::').at(-1)!;
    if (simple === token) continue; // constructor, not an owner/member pair
    const matching = definitions.filter(node => ownerOf(node) === requested
      // Native out-of-line methods can omit their lexical namespace. Such a
      // body is a POSSIBLE overload even for a fully qualified owner request.
      || requested.endsWith(`::${ownerOf(node)}`)
      || (!requested.includes('::') && ownerOf(node).split('::').at(-1) === simple));
    if (matching.length !== 1) continue; // overloads and duplicate bodies stay ambiguous
    const target = matching[0]!;
    const types = ownerNodes(simple).filter(node => node.language === 'cpp'
      && (node.kind === 'class' || node.kind === 'struct') && node.name === simple);
    const allIdentities = new Set(types.map(node => node.qualifiedName.replace(/^::/, '')));
    const identities = new Set([...allIdentities].filter(name => !requested.includes('::') || name === requested));
    if (identities.size !== 1) continue; // a bare owner shared by namespaces is ambiguous
    const identity = [...identities][0]!;
    const owner = ownerOf(target);
    if (owner !== identity) {
      if (!owner || !identity.endsWith(`::${owner}`)) continue;
      const possibleOwners = [...allIdentities].filter(name => name === owner || name.endsWith(`::${owner}`));
      if (possibleOwners.length !== 1) continue;
    }
    selected.set(target.id, target);
  }
  return selected.size === 1 ? selected.values().next().value : undefined;
}
