import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";

import { assert, describe, it } from "poku";

import {
  analyzeJsCapabilitiesFile,
  analyzeSuspiciousJsFile,
  detectExtensionCapabilities,
  detectMcpInventory,
  detectPythonMcpInventory,
  findJSImportsExports,
} from "./analyzer.js";

const baseTempDir = mkdtempSync(join(tmpdir(), "cdxgen-analyzer-poku-"));

process.on("exit", () => {
  rmSync(baseTempDir, { recursive: true, force: true });
});

const createProject = (subDirName, entryContent) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "index.js"), entryContent, {
    encoding: "utf-8",
  });
  return projectDir;
};

const createProjectFromFixture = (subDirName, fixtureFileName) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  const fixturePath = new URL(
    `../../test/data/${fixtureFileName}`,
    import.meta.url,
  );
  copyFileSync(fixturePath, join(projectDir, fixtureFileName));
  return projectDir;
};

const createProjectFiles = (subDirName, fileMap) => {
  const projectDir = join(baseTempDir, subDirName);
  mkdirSync(projectDir, { recursive: true });
  for (const [fileName, content] of Object.entries(fileMap)) {
    const fullPath = join(projectDir, fileName);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, { encoding: "utf-8" });
  }
  return projectDir;
};

function getProp(obj, name) {
  return obj?.properties?.find((property) => property.name === name)?.value;
}

function normalizePathForAssertion(filePath) {
  return String(filePath || "").replaceAll("\\", "/");
}

describe("findJSImportsExports() wasm and wasi detection", () => {
  it("captures wasm exports from WebAssembly.instantiate() flow", async () => {
    const projectDir = createProject(
      "instantiate-flow",
      `import fs from "node:fs/promises";
const wasmBuffer = await fs.readFile("./add.wasm");
const wasmModule = await WebAssembly.instantiate(wasmBuffer);
const { add } = wasmModule.instance.exports;
console.log(add(5, 6));
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["add.wasm"], "expected add.wasm to be discovered");
    const occurrences = Array.from(allImports["add.wasm"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("add")),
      "expected add export symbol to be tracked",
    );
    const addOccurrence = occurrences.find((occ) =>
      occ.importedModules?.includes("add"),
    );
    assert.ok(addOccurrence, "expected add symbol occurrence to exist");
    assert.ok(
      normalizePathForAssertion(addOccurrence.fileName).endsWith("index.js"),
      "expected source filename to be tracked",
    );
    assert.strictEqual(addOccurrence.lineNumber, 4);
    assert.strictEqual(typeof addOccurrence.columnNumber, "number");
    assert.ok(addOccurrence.columnNumber >= 0);
  });

  it("captures wasm exports from instantiateStreaming(fetch(new URL(...)))", async () => {
    const projectDir = createProject(
      "streaming-flow",
      `const { instance } = await WebAssembly.instantiateStreaming(
  fetch(new URL("./stream.wasm", import.meta.url)),
);
const { run } = instance.exports;
console.log(run());
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      allImports["stream.wasm"],
      "expected stream.wasm to be discovered",
    );
    const occurrences = Array.from(allImports["stream.wasm"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("run")),
      "expected run export symbol to be tracked",
    );
  });

  it("does not treat arbitrary function calls with .wasm literals as wasm imports", async () => {
    const projectDir = createProject(
      "non-wasm-callee",
      `doSomething("./ignored.wasm");
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(
      !allImports["./ignored.wasm"] && !allImports["ignored.wasm"],
      "expected non-wasm callee usage to be ignored",
    );
  });

  it("captures wasi constructor and lifecycle API usage", async () => {
    const projectDir = createProject(
      "wasi-flow",
      `import { WASI } from "node:wasi";
const wasi = new WASI({ version: "preview1" });
wasi.initialize(instance);
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["node:wasi"], "expected node:wasi to be discovered");
    const occurrences = Array.from(allImports["node:wasi"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("WASI")),
      "expected WASI usage to be tracked",
    );
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("initialize")),
      "expected initialize API usage to be tracked",
    );
  });

  it("captures wasi constructor alias invoked without new", async () => {
    const projectDir = createProject(
      "wasi-call-alias-flow",
      `import { WASI as WasiCtor } from "node:wasi";
const wasi = WasiCtor({ version: "preview1" });
wasi.start(instance);
`,
    );

    const { allImports } = await findJSImportsExports(projectDir, false);
    assert.ok(allImports["node:wasi"], "expected node:wasi to be discovered");
    const occurrences = Array.from(allImports["node:wasi"]);
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("WASI")),
      "expected WASI constructor alias usage to be tracked",
    );
    assert.ok(
      occurrences.some((occ) => occ.importedModules?.includes("start")),
      "expected start API usage to be tracked",
    );
  });

  it("detects wasm import/export functions from libmagic wrapper fixture", async () => {
    const projectDir = createProjectFromFixture(
      "libmagic-wrapper",
      "libmagic-wrapper.js",
    );

    const { allImports, allExports } = await findJSImportsExports(
      projectDir,
      false,
    );
    assert.ok(allImports.fs, "expected fs require import to be detected");
    assert.ok(
      allImports.crypto,
      "expected crypto require import to be detected",
    );
    assert.ok(
      allImports["libmagic-wrapper.wasm"],
      "expected libmagic-wrapper.wasm to be detected",
    );
    assert.ok(
      allExports["libmagic-wrapper.wasm"],
      "expected libmagic-wrapper.wasm exports to be detected",
    );

    const wasmImportOccurrences = Array.from(
      allImports["libmagic-wrapper.wasm"],
    );
    const wasmExportOccurrences = Array.from(
      allExports["libmagic-wrapper.wasm"],
    );

    assert.ok(
      wasmImportOccurrences.some(
        (occ) =>
          normalizePathForAssertion(occ.fileName).endsWith(
            "libmagic-wrapper.js",
          ) &&
          typeof occ.lineNumber === "number" &&
          typeof occ.columnNumber === "number",
      ),
      "expected wasm import occurrences to include source location metadata",
    );

    const importedModules = new Set(
      wasmImportOccurrences.flatMap((occ) => occ.importedModules || []),
    );
    for (const expectedImportedModule of [
      "free",
      "malloc",
      "magic_wrapper_load",
      "magic_wrapper_detect",
      "_emscripten_stack_restore",
      "_emscripten_stack_alloc",
      "emscripten_stack_get_current",
      "memory",
      "__indirect_function_table",
    ]) {
      assert.ok(
        importedModules.has(expectedImportedModule),
        `expected imported wasm symbol ${expectedImportedModule}`,
      );
    }

    const exportedModules = new Set(
      wasmExportOccurrences.flatMap((occ) => occ.exportedModules || []),
    );
    for (const expectedExportedModule of [
      "_free",
      "_malloc",
      "_magic_wrapper_load",
      "_magic_wrapper_detect",
    ]) {
      assert.ok(
        exportedModules.has(expectedExportedModule),
        `expected exported wasm symbol ${expectedExportedModule}`,
      );
    }
  });
});

describe("detectExtensionCapabilities()", () => {
  it("should detect extension capability signals from source usage", () => {
    const projectDir = createProject(
      "extension-capabilities",
      `chrome.scripting.executeScript({ target: { tabId: 1 }, files: ["inject.js"] });
chrome.bluetooth.getDevices(() => {});
chrome.downloads.download({ url: "https://example.invalid/a.txt" });
const canvas = document.createElement("canvas");
canvas.toDataURL();
fetch("https://example.invalid/api");
navigator.userAgentData?.getHighEntropyValues(["platformVersion"]);
`,
    );
    const detected = detectExtensionCapabilities(projectDir);
    assert.ok(detected.capabilities.includes("codeInjection"));
    assert.ok(detected.capabilities.includes("bluetooth"));
    assert.ok(detected.capabilities.includes("deviceAccess"));
    assert.ok(detected.capabilities.includes("fileAccess"));
    assert.ok(detected.capabilities.includes("network"));
    assert.ok(detected.capabilities.includes("fingerprinting"));
  });

  it("should detect fingerprinting from canvas member-chain APIs", () => {
    const projectDir = createProject(
      "extension-capabilities-canvas-only",
      `const canvas = document.createElement("canvas");
const ctx = canvas.getContext("2d");
ctx.getImageData(0, 0, 1, 1);
canvas.toDataURL();
ctx.measureText("a");
`,
    );
    const detected = detectExtensionCapabilities(projectDir);
    assert.ok(detected.capabilities.includes("fingerprinting"));
  });
});

describe("analyzeSuspiciousJsFile()", () => {
  it("detects encoded child-process loader patterns", () => {
    const projectDir = createProject(
      "suspicious-lifecycle-js",
      [
        "import cp from 'node:child_process';",
        "const payload = Buffer.from('ZXZhbCgnY29uc29sZS5sb2coMSknKQ==', 'base64');",
        "cp.execSync(payload.toString());",
      ].join("\n"),
    );

    const analysis = analyzeSuspiciousJsFile(join(projectDir, "index.js"));
    assert.match(analysis.obfuscationIndicators.join(","), /buffer-base64/);
    assert.match(analysis.executionIndicators.join(","), /child-process/);
  });

  it("detects network-capable script files referenced by lifecycle hooks", () => {
    const projectDir = createProject(
      "network-lifecycle-js",
      [
        "import https from 'node:https';",
        "https.request('https://example.invalid/payload');",
      ].join("\n"),
    );

    const analysis = analyzeSuspiciousJsFile(join(projectDir, "index.js"));
    assert.match(analysis.networkIndicators.join(","), /network-request/);
  });
});

describe("analyzeJsCapabilitiesFile()", () => {
  it("detects file, network, hardware, child-process, and dynamic fetch signals", () => {
    const projectDir = createProject(
      "js-capabilities",
      [
        "import fs from 'node:fs/promises';",
        "import { execFile } from 'node:child_process';",
        "import usb from 'usb';",
        "const endpoint = process.env.API_URL;",
        "await fs.readFile('config.json');",
        "await fetch(endpoint);",
        "await import(process.env.PLUGIN_NAME);",
        "usb.getDeviceList();",
        "execFile('sh', ['-c', 'echo hi']);",
      ].join("\n"),
    );

    const analysis = analyzeJsCapabilitiesFile(join(projectDir, "index.js"));

    assert.ok(analysis.capabilities.includes("fileAccess"));
    assert.ok(analysis.capabilities.includes("network"));
    assert.ok(analysis.capabilities.includes("hardware"));
    assert.ok(analysis.capabilities.includes("childProcess"));
    assert.ok(analysis.capabilities.includes("dynamicFetch"));
    assert.ok(analysis.capabilities.includes("dynamicImport"));
    assert.strictEqual(analysis.hasDynamicFetch, true);
    assert.strictEqual(analysis.hasDynamicImport, true);
  });

  it("detects eval and vm-based code generation signals", () => {
    const projectDir = createProject(
      "js-capabilities-eval",
      [
        "import vm from 'node:vm';",
        "eval('console.log(1)');",
        "vm.runInNewContext('console.log(2)');",
      ].join("\n"),
    );

    const analysis = analyzeJsCapabilitiesFile(join(projectDir, "index.js"));

    assert.ok(analysis.capabilities.includes("codeGeneration"));
    assert.strictEqual(analysis.hasEval, true);
    assert.match(
      (analysis.indicatorMap.codeGeneration || []).join(","),
      /eval|vm\.runInNewContext/,
    );
  });
});

describe("detectMcpInventory()", () => {
  it("detects an official authenticated streamable HTTP MCP server", () => {
    const projectDir = createProjectFiles("mcp-http-server", {
      "src/server.js": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { Client } from '@modelcontextprotocol/client';",
        "import { createMcpExpressApp, mcpAuthMetadataRouter, requireBearerAuth } from '@modelcontextprotocol/express';",
        "import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';",
        "import OpenAI from 'openai';",
        "const app = createMcpExpressApp();",
        "const oauthMetadata = { issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/authorize', token_endpoint: 'https://auth.example.com/token' };",
        "const mcpServerUrl = new URL('http://localhost:3000/mcp');",
        "const server = new McpServer({ name: 'demo-http-server', version: '1.2.3' }, { capabilities: { logging: {}, resources: { subscribe: true }, tools: { listChanged: true } } });",
        "const upstream = new Client({ name: 'relay-client', version: '0.0.1' });",
        "server.registerTool('summarize', { description: 'Summarize text', annotations: { readOnlyHint: true } }, async () => ({ content: [] }));",
        "server.registerPrompt('ask-user', { description: 'Prompt template' }, async () => ({ messages: [] }));",
        "server.registerResource('docs', 'file:///{path}', { description: 'Workspace docs' }, async () => ({ contents: [] }));",
        "const auth = requireBearerAuth({ requiredScopes: ['mcp'] });",
        "app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: mcpServerUrl }));",
        "app.post('/mcp', auth, async () => {});",
        "const transport = new NodeStreamableHTTPServerTransport();",
        "await server.connect(transport);",
        "const openai = new OpenAI({ apiKey: 'sk-test' });",
        "await fetch('https://api.openai.com/v1/responses');",
        "await upstream.callTool({ name: 'summarize' });",
        "const provider = 'anthropic';",
        "const model = 'claude-3-5-sonnet';",
        "void provider; void model;",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 3);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "demo-http-server");
    assert.strictEqual(service.version, "1.2.3");
    assert.strictEqual(service.authenticated, true);
    assert.ok(service.endpoints.includes("/mcp"));
    assert.ok(service.endpoints.includes("http://localhost:3000/mcp"));
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:capabilities:resources.subscribe" &&
          prop.value === "true",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:modelNames" &&
          prop.value.includes("claude-3-5-sonnet"),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:serviceType" && prop.value === "gateway",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:providerFamilies" &&
          prop.value.includes("anthropic") &&
          prop.value.includes("openai"),
      ),
    );
    assert.ok(
      new Set((getProp(service, "cdx:mcp:outboundHosts") || "").split(",")).has(
        "api.openai.com",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:usageConfidence" && prop.value === "high",
      ),
    );
    assert.ok(
      inventory.dependencies.some(
        (dependency) =>
          dependency.ref === service["bom-ref"] &&
          dependency.provides.length === 3,
      ),
    );
  });

  it("detects an unauthenticated non-official HTTP MCP server", () => {
    const projectDir = createProjectFiles("mcp-unsafe-server", {
      "index.js": [
        "import express from 'express';",
        "import { Server as AcmeMcpServer } from '@acme/mcp-server';",
        "const app = express();",
        "const server = new AcmeMcpServer({ name: 'unsafe-http-server', version: '0.1.0' });",
        "server.registerTool('run_shell', { description: 'Run a command' }, async () => ({ content: [] }));",
        "app.post('/mcp-unsafe', async () => {});",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "unsafe-http-server");
    assert.strictEqual(service.authenticated, false);
    assert.ok(service.endpoints.includes("/mcp-unsafe"));
    assert.ok(
      service.properties.some(
        (prop) => prop.name === "cdx:mcp:officialSdk" && prop.value === "false",
      ),
    );
  });

  it("detects MCP client-only usage and provider wiring", () => {
    const projectDir = createProjectFiles("mcp-client-only", {
      "index.js": [
        "import { Client } from '@modelcontextprotocol/client';",
        "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
        "import Anthropic from '@anthropic-ai/sdk';",
        "const client = new Client({ name: 'demo-client', version: '0.1.0' });",
        "const transport = new StreamableHTTPClientTransport(new URL('https://mcp.example.com/mcp'));",
        "await client.connect(transport);",
        "const anthropic = new Anthropic({ apiKey: 'test' });",
        "await client.listTools();",
        "await fetch('https://api.anthropic.com/v1/messages');",
        "const modelName = 'claude-3-7-sonnet';",
        "void anthropic; void modelName;",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    const service = inventory.services[0];
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:serviceType" && prop.value === "client",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:exposureType" &&
          prop.value === "networked-public",
      ),
    );
    assert.ok(
      ["mcp.example.com", "api.anthropic.com"].every((hostname) =>
        getProp(service, "cdx:mcp:outboundHosts")
          ?.split(",")
          .includes(hostname),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:providerFamilies" &&
          prop.value.includes("anthropic"),
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) =>
          prop.name === "cdx:mcp:inventorySource" &&
          prop.value === "source-code-analysis",
      ),
    );
    assert.ok(
      service.properties.some(
        (prop) => prop.name === "cdx:mcp:reviewNeeded" && prop.value === "true",
      ),
    );
  });

  it("detects a TypeScript stdio MCP server and emits source-code-analysis inventory", () => {
    const projectDir = createProjectFiles("mcp-ts-stdio-server", {
      "src/server.ts": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';",
        "const server = new McpServer({ name: 'ts-stdio-server', version: '0.2.0' }, { capabilities: { tools: {}, prompts: {}, resources: {} } });",
        "server.registerTool('lint', { description: 'Lint source files' }, async () => ({ content: [] }));",
        "server.registerPrompt('review', { description: 'Prompt review guidance' }, async () => ({ messages: [] }));",
        "server.registerResource('workspace-docs', 'file:///docs/{path}', { description: 'Workspace docs' }, async () => ({ contents: [] }));",
        "const transport = new StdioServerTransport();",
        "await server.connect(transport);",
      ].join("\n"),
    });
    const inventory = detectMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 3);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "ts-stdio-server");
    assert.strictEqual(service.version, "0.2.0");
    assert.strictEqual(getProp(service, "cdx:mcp:transport"), "stdio");
    assert.strictEqual(
      getProp(service, "cdx:mcp:inventorySource"),
      "source-code-analysis",
    );
    assert.strictEqual(getProp(service, "cdx:mcp:serviceType"), "gateway");
    assert.strictEqual(getProp(service, "cdx:mcp:toolCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:promptCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:resourceCount"), "1");
    assert.ok(
      inventory.dependencies.some(
        (dependency) =>
          dependency.ref === service["bom-ref"] &&
          dependency.provides.length === 3,
      ),
    );
  });

  it("sanitizes source-code-analysis MCP metadata before emission", () => {
    const projectDir = createProjectFiles("mcp-sanitized-source-analysis", {
      "src/server.ts": [
        "import { McpServer } from '@modelcontextprotocol/server';",
        "import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';",
        "const server = new McpServer({",
        "  name: 'sanitized-server',",
        "  version: '0.3.0',",
        "  description: 'Use https://user:pass@example.com/mcp?token=abc#frag and Bearer sk_test_super_secret_value',",
        "});",
        "server.registerTool(",
        "  'download',",
        "  {",
        "    description: 'Download from https://user:pass@example.com/tool?token=abc#frag',",
        "    annotations: {",
        "      Authorization: 'Bearer sk_test_super_secret_value',",
        "      nested: { __proto__: 'polluted', endpoint: 'https://user:pass@example.com/tool?token=abc#frag' },",
        "    },",
        "  },",
        "  async () => ({ content: [] }),",
        ");",
        "server.registerResource(",
        "  'private-docs',",
        "  'https://user:pass@example.com/docs?token=abc#frag',",
        "  { description: 'Private docs' },",
        "  async () => ({ contents: [] }),",
        ");",
        "const transport = new StreamableHTTPClientTransport(new URL('https://user:pass@example.com/mcp?access_token=secret#frag'));",
        "void transport;",
      ].join("\n"),
    });

    const inventory = detectMcpInventory(projectDir);
    const service = inventory.services[0];
    const toolComponent = inventory.components.find(
      (component) => component.name === "download",
    );
    const resourceComponent = inventory.components.find(
      (component) => component.name === "private-docs",
    );

    assert.strictEqual(
      service.description,
      "Use https://example.com/mcp and [redacted]",
    );
    const serviceEndpoint = new URL(service.endpoints[0]);
    assert.strictEqual(serviceEndpoint.hostname, "example.com");
    assert.strictEqual(serviceEndpoint.pathname, "/mcp");
    assert.strictEqual(
      getProp(resourceComponent, "cdx:mcp:resourceUri"),
      "https://example.com/docs",
    );
    assert.strictEqual(
      toolComponent.description,
      "Download from https://example.com/tool",
    );
    const toolAnnotations = JSON.parse(
      getProp(toolComponent, "cdx:mcp:toolAnnotations"),
    );
    assert.strictEqual(toolAnnotations.Authorization, "[redacted]");
    assert.ok(
      !JSON.stringify(toolAnnotations).includes("sk_test_super_secret_value"),
    );
    assert.ok(!JSON.stringify(toolAnnotations).includes("__proto__"));
  });
});

describe("detectPythonMcpInventory()", () => {
  it("detects a Python stdio MCP server and exported primitives", () => {
    const projectDir = createProjectFiles("mcp-python-server", {
      "src/server.py": [
        "import mcp.server.stdio",
        "import mcp.types as mtypes",
        "from mcp.server import NotificationOptions, Server",
        "",
        'server = Server("appthreat-vulnerability-db", version="1.0.1")',
        "",
        "@server.list_resources()",
        "async def handle_list_resources():",
        '    return [mtypes.Resource(uri=mtypes.AnyUrl("cve://"), name="CVE Information", description="Get detailed information about a CVE")]',
        "",
        "@server.list_tools()",
        "async def handle_list_tools():",
        '    return [mtypes.Tool(name="search_by_purl_like", description="Search by purl", inputSchema={"type": "object"})]',
        "",
        "async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):",
        "    await server.run(",
        "        read_stream,",
        "        write_stream,",
        '        InitializationOptions(server_name="appthreat-vulnerability-db", server_version="1.0.1", capabilities=server.get_capabilities(notification_options=NotificationOptions(), experimental_capabilities={}))',
        "    )",
      ].join("\n"),
    });
    const inventory = detectPythonMcpInventory(projectDir);
    assert.strictEqual(inventory.services.length, 1);
    assert.strictEqual(inventory.components.length, 2);
    const service = inventory.services[0];
    assert.strictEqual(service.name, "appthreat-vulnerability-db");
    assert.strictEqual(service.version, "1.0.1");
    assert.strictEqual(getProp(service, "cdx:mcp:transport"), "stdio");
    assert.strictEqual(getProp(service, "cdx:mcp:officialSdk"), "true");
    assert.strictEqual(getProp(service, "cdx:mcp:toolCount"), "1");
    assert.strictEqual(getProp(service, "cdx:mcp:resourceCount"), "1");
    assert.ok(
      inventory.components.some(
        (component) => component.name === "search_by_purl_like",
      ),
    );
    assert.ok(
      inventory.components.some(
        (component) => component.name === "CVE Information",
      ),
    );
  });
});
