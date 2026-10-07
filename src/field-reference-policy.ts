import type { Node } from './types';

/** Explicit opt-in restores per-location ordinary C/C++ data-field references. */
export function fieldReferencesEnabled(): boolean {
  const value = process.env.CODEGRAPH_FIELD_REFERENCES?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

export function fieldReferencePolicyKey(): string {
  return fieldReferencesEnabled() ? 'all-v1' : 'ordinary-off-v1';
}

export function suppressFieldReference(kind: string, target: Node | null | undefined): boolean {
  return !fieldReferencesEnabled() && kind === 'references' && isOrdinaryFieldTarget(target);
}

export function isOrdinaryFieldTarget(target: Node | null | undefined): boolean {
  return target?.kind === 'field' && (target.language === 'c' || target.language === 'cpp') &&
    target.ordinaryField === true;
}
