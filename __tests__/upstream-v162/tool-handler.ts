export * from '../../src/upstream-explore/mcp/tools';
import { ToolHandler as Upstream } from '../../src/upstream-explore/mcp/tools';
import { captureResult } from './capture';
export class ToolHandler extends Upstream {
  // The fixture owns and closes the native graph; the vendored handler owns no DB.
  closeAll(): void {}
  constructor(private readonly testGraph: any) { super(testGraph); }
  override async execute(...args: Parameters<Upstream['execute']>) {
    const result = await super.execute(...args);
    captureResult(this.testGraph, args[1], result);
    return result;
  }
}
