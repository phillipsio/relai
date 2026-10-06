import { type ToolConfig } from "./tools.js";
import { detectOwnerScope } from "./owner-scope.js";
import type { ApiClient } from "./api-client.js";
export type ToolRegistrar = {
    tool: (name: string, description: string, shape: never, handler: never) => unknown;
};
export declare function registerTools(server: ToolRegistrar, client: ApiClient, config: ToolConfig, detect?: typeof detectOwnerScope): Promise<string[]>;
//# sourceMappingURL=register-tools.d.ts.map