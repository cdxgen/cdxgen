import { McpServer } from "@modelcontextprotocol/server";
import {
  createMcpExpressApp,
  mcpAuthMetadataRouter,
  requireBearerAuth,
} from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import * as z from "zod/v4";

const app = createMcpExpressApp();
const oauthMetadata = {
  issuer: "https://auth.example.com",
  authorization_endpoint: "https://auth.example.com/authorize",
  token_endpoint: "https://auth.example.com/token",
};
const mcpServerUrl = new URL("http://localhost:3000/mcp");
const provider = "anthropic";
const model = "claude-3-5-sonnet";

const server = new McpServer(
  {
    name: "auth-http-server",
    version: "1.2.3",
  },
  {
    capabilities: {
      logging: {},
      resources: { subscribe: true },
      tools: { listChanged: true },
    },
  },
);

server.registerTool(
  "summarize",
  {
    description: "Summarize user text",
    inputSchema: z.object({
      text: z.string(),
    }),
    annotations: {
      readOnlyHint: true,
    },
  },
  async () => {
    return {
      content: [
        {
          type: "text",
          text: `${provider}:${model}`,
        },
      ],
    };
  },
);

server.registerPrompt(
  "ask-user",
  {
    description: "Prompt template",
  },
  async () => ({ messages: [] }),
);

server.registerResource(
  "workspace-docs",
  "file:///{path}",
  { description: "Workspace documents" },
  async () => ({ contents: [] }),
);

const auth = requireBearerAuth({ requiredScopes: ["mcp"] });

app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));
app.post("/mcp", auth, async () => {});

const transport = new NodeStreamableHTTPServerTransport();
await server.connect(transport);
