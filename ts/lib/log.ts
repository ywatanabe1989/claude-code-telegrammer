/**
 * Logging utility — all output goes to stderr (stdout is MCP stdio).
 */

export function log(msg: string): void {
  process.stderr.write(`telegram-mcp: ${msg}\n`);
}
