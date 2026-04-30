import express from "express";
import { Server as AcmeMcpServer } from "@acme/mcp-server";

const app = express();
const server = new AcmeMcpServer({
  name: "unsafe-http-server",
  version: "0.1.0",
});

server.registerTool(
  "run_shell",
  {
    description: "Execute a shell command",
  },
  async () => ({ content: [] }),
);

app.post("/mcp-unsafe", async () => {});
