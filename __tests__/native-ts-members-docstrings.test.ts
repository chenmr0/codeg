
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('upstream native extraction parity: declaration wrappers and TS/JS members', () => {
  it('keeps documentation outside export/ambient wrappers on the emitted declaration', () => {
    const result = extractFromSource('wrapped.ts', [
      '/** Exported behavior. */',
      'export function execute() { return 1; }',
      '/** Exported service. */',
      'export default class Service { run() {} }',
      '/** Arrow binding. */',
      'export const submit = () => 2;',
      '/** Ambient declaration. */',
      'export declare class Remote { send(): void; }',
      'function unrelated() {}',
    ].join('\n'), 'typescript');
    const node = (name: string) => result.nodes.find(n => n.name === name)!;
    expect(node('execute').docstring).toBe('Exported behavior.');
    expect(node('Service').docstring).toBe('Exported service.');
    expect(node('submit').docstring).toBe('Arrow binding.');
    expect(node('Remote').docstring).toBe('Ambient declaration.');
    expect(node('unrelated').docstring).toBeUndefined();
  });

  it('anchors a decorated Python declaration to the preceding comment without changing comment cleaning', () => {
    const result = extractFromSource('wrapped.py', [
      '# Decorated behavior.',
      '@decorate',
      'def wrapped():',
      '    return 1',
      '',
      'def unwrapped():',
      '    return 2',
    ].join('\n'), 'python');
    expect(result.nodes.find(n => n.name === 'wrapped')?.docstring).toBe('# Decorated behavior.');
    expect(result.nodes.find(n => n.name === 'unwrapped')?.docstring).toBeUndefined();
  });

  it('TS fields retain kind, modifiers, declared type and callable-body relationships', () => {
    const result = extractFromSource('members.ts', [
      'class Fonts {}',
      'declare function throttle(fn: unknown): unknown;',
      'declare function createFonts(): Fonts;',
      'class App {',
      '  public fonts: Fonts;',
      '  private history: Fonts = createFonts();',
      '  static defaults = { count: 0 };',
      '  count = 0;',
      '  callbackType: () => void;',
      '  onClick = () => { this.run(); };',
      '  onScroll = throttle(() => { this.run(); });',
      '  handler = function namedHandler() { return 1; };',
      '  run(): void {}',
      '  get value(): number { return 1; }',
      '}',
    ].join('\n'), 'typescript');
    const node = (name: string) => result.nodes.find(n => n.name === name)!;
    for (const name of ['fonts', 'history', 'defaults', 'count', 'callbackType']) expect(node(name).kind).toBe('property');
    for (const name of ['onClick', 'onScroll', 'handler', 'run', 'value']) expect(node(name).kind).toBe('method');
    expect(node('fonts').signature).toBe('Fonts fonts');
    expect(node('fonts').visibility).toBe('public');
    expect(node('history').visibility).toBe('private');
    expect(node('defaults').isStatic).toBe(true);
    expect(result.unresolvedReferences.some(r => r.fromNodeId === node('fonts').id && r.referenceName === 'Fonts')).toBe(true);
    expect(result.unresolvedReferences.some(r => r.fromNodeId === node('history').id && r.referenceName === 'createFonts')).toBe(true);
    expect(result.unresolvedReferences.some(r => r.fromNodeId === node('onClick').id && r.referenceName === 'run')).toBe(true);
  });

  it('JS fields expose their property key and classify by callable value', () => {
    const result = extractFromSource('members.js', [
      'class App {',
      '  count = 0;',
      '  config = { retries: 3 };',
      '  onClick = () => { this.run(); };',
      '  callback = function namedCallback() {};',
      '  onScroll = throttle(() => { this.run(); });',
      '  run() {}',
      '}',
    ].join('\n'), 'javascript');
    const node = (name: string) => result.nodes.find(n => n.name === name)!;
    for (const name of ['count', 'config']) expect(node(name).kind).toBe('property');
    for (const name of ['onClick', 'callback', 'onScroll', 'run']) expect(node(name).kind).toBe('method');
  });

  it('indexes ordinary and function-typed interface properties, with real method signatures', () => {
    const result = extractFromSource('contracts.ts', [
      'class Payload {}',
      'export interface Transport {',
      '  /** Holds data. */',
      '  payload?: Payload;',
      '  counts: Record<string, number>;',
      '  callback: (value: Payload) => void;',
      '  send(value: Payload): void;',
      '}',
      'const input: { anonymous(value: Payload): void } = null as any;',
    ].join('\n'), 'typescript');
    const node = (name: string) => result.nodes.find(n => n.name === name)!;
    expect(node('payload').kind).toBe('property');
    expect(node('payload').signature).toBe('Payload payload');
    expect(node('payload').docstring).toBe('Holds data.');
    expect(node('counts').signature).toBe('Record<string, number> counts');
    expect(node('callback').kind).toBe('property');
    expect(node('send').kind).toBe('method');
    expect(result.edges.some(e => e.source === node('Transport').id && e.target === node('send').id && e.kind === 'contains')).toBe(true);
    expect(result.unresolvedReferences.some(r => r.fromNodeId === node('payload').id && r.referenceName === 'Payload')).toBe(true);
    expect(result.nodes.some(n => n.name === 'anonymous' && (n.kind === 'method' || n.kind === 'function'))).toBe(false);
  });

  it('keeps C++ fields, prototypes and macro identity on their existing extraction paths', () => {
    const result = extractFromSource('members.cpp', [
      '#define CAPACITY 4',
      '/** Stored record. */',
      'struct Record {',
      '  int count;',
      '  void (*callback)(int);',
      '  void run();',
      '};',
      'void Record::run() {}',
    ].join('\n'), 'cpp');
    expect(result.nodes.find(n => n.name === 'CAPACITY')?.kind).toBe('macro');
    expect(result.nodes.find(n => n.name === 'Record' && n.kind === 'struct')?.docstring).toBe('Stored record.');
    expect(result.nodes.find(n => n.name === 'count')?.kind).toBe('field');
    expect(result.nodes.find(n => n.name === 'callback')?.kind).toBe('field');
    expect(result.nodes.some(n => n.name === 'run' && n.isDeclaration)).toBe(true);
    expect(result.nodes.some(n => n.name === 'run' && !n.isDeclaration)).toBe(true);
  });

  it('preserves only a Go two-hop receiver chain instead of turning it into a bare self-call', () => {
    const result = extractFromSource('chain.go', [
      'package demo',
      'type Handler struct { svc Service }',
      'type Service struct {}',
      'func (h *Handler) RunCycle() { h.svc.RunCycle(); h.Direct(); Plain() }',
      'func (s *Service) RunCycle() {}',
      'func (h *Handler) Direct() {}',
      'func Plain() {}',
    ].join('\n'), 'go');
    const references = result.unresolvedReferences.filter(r => r.referenceKind === 'calls').map(r => r.referenceName);
    expect(references).toContain('h.svc.RunCycle');
    expect(references).toContain('h.Direct');
    expect(references).toContain('Plain');
    expect(references).not.toContain('RunCycle');
  });
});

