export async function mcpCommand() {
  await import(new URL("mcp.js", import.meta.url).href);
}
