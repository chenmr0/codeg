import { describe, expect, it } from 'vitest';
import { admitExploreGraph, type ExploreNeighbor } from '../src/mcp/explore-admission';
import type { Node } from '../src/types';

const n = (id: string): Node => ({ id, name:id, qualifiedName:id, kind:'function', language:'typescript',
  filePath:'graph.ts', startLine:1, endLine:2, startColumn:0, endColumn:1 });
const arc = (source: Node, target: Node, line = 1): ExploreNeighbor =>
  ({ node:target, edge:{source:source.id,target:target.id,kind:'calls',line} });

describe('bounded shared admission with reusable reservations', () => {
  it('reclaims an exhausted root allocation instead of losing the late target', () => {
    const roots = [n('busy'),n('small'),n('empty')];
    const leaves = Array.from({length:18},(_,i)=>n(`member${i}`));
    const graph = new Map([[roots[0]!.id,leaves.map((x,i)=>arc(roots[0]!,x,i))],
      [roots[1]!.id,[arc(roots[1]!,n('small-leaf'))]]]);
    const {graph:r,audit} = admitExploreGraph(roots,x=>graph.get(x.id)??[],24,3);
    expect(r.nodes.size).toBe(22);
    expect(r.nodes.has('member17')).toBe(true);
    expect(r.nodes.has('small-leaf')).toBe(true);
    expect(audit.reclaimedNodes).toBeGreaterThan(0);
    expect(audit.omittedNodeIds).toEqual([]);
  });
  it('gives competing roots turns and never crosses the global limit', () => {
    const roots=[n('left'),n('right')];
    const neighbors=(x:Node)=>roots.some(r=>r.id===x.id)
      ? Array.from({length:40},(_,i)=>arc(x,n(`${x.id}-${i}`),i)) : [];
    const {graph,audit}=admitExploreGraph(roots,neighbors,12,3);
    expect(graph.nodes.size).toBe(12);
    expect([...graph.nodes.keys()].filter(x=>x.startsWith('left-'))).toHaveLength(5);
    expect([...graph.nodes.keys()].filter(x=>x.startsWith('right-'))).toHaveLength(5);
    expect(audit.reason).toBe('global-node-limit');
    expect(audit.omittedNodeIds).toContain('left-39');
    expect(graph.edges.every(e=>graph.nodes.has(e.source)&&graph.nodes.has(e.target))).toBe(true);
  });
  it('keeps cycles and parallel call sites even when the node cap is full', () => {
    const [root,a,b,overflow]=['root','a','b','overflow'].map(n) as [Node,Node,Node,Node];
    const links=new Map([[root.id,[arc(root,a,1),arc(root,a,2),arc(root,b,3)]],
      [a.id,[arc(a,b,4),arc(a,overflow,6)]],[b.id,[arc(b,root,5)]]]);
    const {graph}=admitExploreGraph([root],x=>links.get(x.id)??[],3,3);
    expect([...graph.nodes.keys()]).toEqual(['root','a','b']);
    expect(graph.edges.map(e=>e.line).sort()).toEqual([1,2,3,4,5]);
  });
  it('does not charge globally shared nodes as new capacity or exceed depth', () => {
    const [a,b,shared,last,tooFar]=['a','b','shared','last','tooFar'].map(n) as [Node,Node,Node,Node,Node];
    const links=new Map([[a.id,[arc(a,shared)]],[b.id,[arc(b,shared)]],
      [shared.id,[arc(shared,last)]],[last.id,[arc(last,tooFar)]]]);
    const {graph}=admitExploreGraph([a,b],x=>links.get(x.id)??[],4,2);
    expect([...graph.nodes.keys()]).toEqual(['a','b','shared','last']);
    expect(graph.edges).toHaveLength(3);
    expect(admitExploreGraph([a],()=>[],0).graph.nodes.size).toBe(0);
  });
  it('reclaims proven targets without filling spare capacity with peripheral neighbors', () => {
    const root=n('anchor'),empty=n('empty');
    const children=Array.from({length:18},(_,i)=>n(`candidate${i}`));
    const proven=new Set(['candidate16','candidate17']);
    const {graph,audit}=admitExploreGraph([root,empty],x=>x.id===root.id
      ? children.map((v,i)=>arc(root,v,i)) : [],20,3,x=>proven.has(x.id));
    expect(graph.nodes.has('candidate16')).toBe(true);
    expect(graph.nodes.has('candidate17')).toBe(true);
    expect(graph.nodes.has('candidate10')).toBe(false);
    expect(graph.nodes.size).toBe(13);
    expect(audit.reclaimedNodes).toBe(2);
    expect(audit.reclaimRejectedNodeIds).toContain('candidate10');
    expect(audit.reason).toBeNull();
  });
});
