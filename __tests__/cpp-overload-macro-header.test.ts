import { expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import CodeGraph from '../src/index';

it('distinguishes annotated and spliced C macro headers when resolving C++ member addresses', async () => {
  const cases = [
    { name: 'f', directive: '#define /* annotation */ f(x) g(x)', functionLike: true },
    { name: 'multiline', directive: '#define /* first line\nsecond line */ multiline(x) g(x)', functionLike: true },
    { name: 'spliced', directive: '#define spliced\\\r\n(x) g(x)', functionLike: true },
    { name: 'commentGap', directive: '#define commentGap/**/(x) g(x)', functionLike: false },
    { name: 'spaceGap', directive: '#define spaceGap (x) g(x)', functionLike: false },
  ];
  const members = cases.map(({ name }) => 'int ' + name + '(int x) { return x; }');
  const callers = cases.map(({ name }) => 'int caller_' + name + '() { return run(&C::' + name + '); }');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-overload-macro-header-'));
  let graph: CodeGraph | undefined;
  try {
    fs.writeFileSync(path.join(root, 'caller.cpp'), [
      'struct C { ' + members.join(' ') + ' };',
      '#define MAKE() int run(int (C::*p)(int)){return 1;} int run(int (C::*p)(double)){return 2;}',
      'MAKE()', ...callers, '',
    ].join('\n'));
    const padding = Array.from({ length: 19 }, (_, i) => '#define A' + i + ' ' + i);
    fs.writeFileSync(path.join(root, 'tokens.c'),
      [...padding, ...cases.map(({ directive }) => directive), 'int keep;', ''].join('\n'));

    graph = CodeGraph.initSync(root);
    const result = await graph.indexAll();
    expect(result.complete).toBe(true);
    expect(result.errors).toEqual([]);
    expect(graph.getNodesByName('run')).toHaveLength(2);
    for (const { name, directive, functionLike } of cases) {
      const macro = graph.getNodesByName(name).find(node => node.kind === 'macro');
      expect(macro?.signature?.trimEnd()).toBe(directive);
      const [caller] = graph.getNodesByName('caller_' + name);
      const targets = graph.getCallees(caller!.id).map(({ node }) => node)
        .filter(node => node.name === 'run').map(node => node.signature);
      expect(targets, name).toEqual(functionLike ? ['int run(int (C::*p)(int))'] : []);
    }
  } finally {
    if (graph) {
      await graph.whenIdle();
      graph.close();
      await graph.whenIdle();
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
