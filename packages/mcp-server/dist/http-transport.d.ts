import type { IncomingMessage, ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
type HttpRequestListener = (req: IncomingMessage, res: ServerResponse) => Promise<void>;
export declare function createHttpRequestListener(server: McpServer, credential: string): HttpRequestListener;
export {};
//# sourceMappingURL=http-transport.d.ts.map