/** These suites exercise the retained CURRENT/generation compatibility protocol.
 * New-default layout coverage deliberately does NOT import this fixture helper. */
import { beforeAll, afterAll } from 'vitest';

export function useLegacyStorageFixtures(): void {
  let previous: string | undefined;
  beforeAll(() => { previous = process.env.CODEGRAPH_FIXED_PATH; process.env.CODEGRAPH_FIXED_PATH = '0'; });
  afterAll(() => {
    if (previous === undefined) delete process.env.CODEGRAPH_FIXED_PATH;
    else process.env.CODEGRAPH_FIXED_PATH = previous;
  });
}
