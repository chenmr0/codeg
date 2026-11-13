/** An incomplete inventory must never be reconciled as file deletions. */
export class ScanCoverageError extends Error {
  constructor(public readonly directory: string, cause: unknown) {
    super(`Source scan incomplete at ${directory}: ${String(cause)}`);
    this.name = 'ScanCoverageError';
  }
}
