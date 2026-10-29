import { assert, describe, it } from "poku";

import {
  getExecutedTools,
  recordExecutedTool,
  recordToolVersion,
  resetExecutedTools,
} from "./toolRegistry.js";

describe("toolRegistry", () => {
  it("records tools with their cheaply known version", () => {
    resetExecutedTools();
    recordExecutedTool("mvn");
    recordExecutedTool("/usr/local/bin/trivy", "0.67.2");
    const tools = getExecutedTools();
    assert.deepStrictEqual(tools, [
      { name: "mvn", version: undefined },
      { name: "trivy", version: "0.67.2" },
    ]);
    resetExecutedTools();
  });

  it("sorts deterministically by name regardless of recording order", () => {
    resetExecutedTools();
    recordExecutedTool("zip");
    recordExecutedTool("gradle", "9.8.2");
    recordExecutedTool("osqueryi");
    const tools = getExecutedTools();
    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      ["gradle", "osqueryi", "zip"],
    );
    resetExecutedTools();
  });

  it("fills a missing version but never overwrites a concrete one", () => {
    resetExecutedTools();
    recordExecutedTool("sbt", "1.13.0");
    recordExecutedTool("sbt");
    recordExecutedTool("sbt", "9.9.9-unused");
    assert.deepStrictEqual(getExecutedTools(), [
      { name: "sbt", version: "1.13.0" },
    ]);
    resetExecutedTools();
    recordExecutedTool("pnpm");
    recordExecutedTool("pnpm", "12.10.1");
    assert.deepStrictEqual(getExecutedTools(), [
      { name: "pnpm", version: "12.10.1" },
    ]);
    resetExecutedTools();
  });

  it("names path-invoked and Windows-suffixed binaries by their basename", () => {
    resetExecutedTools();
    recordExecutedTool("/opt/cdxgen-plugins/plugins/dosai/dosai");
    recordExecutedTool("C:\\tools\\sourcekitten.exe");
    recordExecutedTool("./gradle.bat");
    recordExecutedTool("/opt/plugins/trivy/trivy-cdxgen-linux-amd64");
    recordExecutedTool("C:\\plugins\\trivy-cdxgen-windows-amd64.exe");
    // a name that merely contains -cdxgen- is left alone
    recordExecutedTool("my-cdxgen-wrapper");
    const tools = getExecutedTools();
    assert.deepStrictEqual(
      tools.map((tool) => tool.name),
      ["dosai", "gradle", "my-cdxgen-wrapper", "sourcekitten", "trivy"],
    );
    resetExecutedTools();
  });

  it("ignores wrapper shells, the cdxgen runtime, and junk input", () => {
    resetExecutedTools();
    recordExecutedTool("bash");
    recordExecutedTool("/bin/sh");
    recordExecutedTool("node");
    recordExecutedTool("pwsh");
    recordExecutedTool("cmd.exe");
    recordExecutedTool("");
    recordExecutedTool(undefined);
    recordExecutedTool(42);
    assert.deepStrictEqual(getExecutedTools(), []);
    resetExecutedTools();
  });

  it("applies a resolved version only to a tool that ran", () => {
    resetExecutedTools();
    recordToolVersion("mvn", "3.9.16");
    recordToolVersion("sbt", "1.13.0");
    assert.deepStrictEqual(getExecutedTools(), []);
    recordExecutedTool("/opt/sdkman/candidates/maven/current/bin/mvn");
    recordToolVersion("mvn", "9.9.9-later");
    assert.deepStrictEqual(getExecutedTools(), [
      { name: "mvn", version: "3.9.16" },
    ]);
    resetExecutedTools();
    recordExecutedTool("mvn");
    assert.deepStrictEqual(getExecutedTools(), [
      { name: "mvn", version: undefined },
    ]);
    resetExecutedTools();
  });
});
