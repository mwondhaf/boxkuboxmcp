import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCartTools } from "./tools/cart";
import { registerOrderTools } from "./tools/orders";
import { registerSearchTools } from "./tools/search";

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "boxconv-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  registerSearchTools(server);
  registerCartTools(server);
  registerOrderTools(server);

  return server;
}
