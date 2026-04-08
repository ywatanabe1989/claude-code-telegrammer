/**
 * Structured JSON logging to stderr (stdout is MCP stdio).
 */

export function log(
  component: string,
  msg: string,
  data?: Record<string, unknown>,
): void {
  const entry = {
    ts: new Date().toISOString(),
    component,
    msg,
    ...data,
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
