import { assert, describe, it } from "poku";

import {
  engineMessages,
  executeAndTrace,
  headAndTailSink,
  isSaferExecAvailable,
  parseCommand,
  resolveSaferExecBinary,
} from "./traceRunner.js";

// A SaferExec stand-in whose fluent methods all chain, and whose runPipe()
// writes the given result's stdout and stderr to the streams it is passed and
// resolves to the rest of the result.
function fakeSaferExec({ stdout, stderr, ...result }, calls = []) {
  const runPipe = async (_cmd, _args, streams = {}) => {
    calls.push(streams);
    for (const [name, text] of [
      ["stdout", stdout],
      ["stderr", stderr],
    ]) {
      for (const chunk of [].concat(text ?? [])) {
        streams[name]?.write(chunk);
      }
    }
    return result;
  };
  const run = async () => {
    throw new Error("run() keeps all of the command's output in memory");
  };
  const chain = new Proxy(
    {},
    {
      get: (_target, prop) => ({ run, runPipe })[prop] ?? (() => chain),
    },
  );
  // `new SaferExec()` yields the object a constructor function returns.
  return function SaferExec() {
    return chain;
  };
}

describe("traceRunner", () => {
  it("parses simple command string", () => {
    const parsed = parseCommand("node app.js");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["app.js"]);
  });

  it("parses command string with double quotes", () => {
    const parsed = parseCommand('node "my app.js" --arg1');
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["my app.js", "--arg1"]);
  });

  it("parses command string with single quotes", () => {
    const parsed = parseCommand("node 'my app.js' --arg1");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["my app.js", "--arg1"]);
  });

  it("returns undefined cmd for empty string", () => {
    const parsed = parseCommand("");
    assert.strictEqual(parsed.cmd, undefined);
    assert.deepEqual(parsed.args, []);
  });

  it("handles multiple spaces between tokens", () => {
    const parsed = parseCommand("node    app.js   --verbose");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["app.js", "--verbose"]);
  });

  it("handles argument with = sign", () => {
    const parsed = parseCommand("node --flag=value app.js");
    assert.strictEqual(parsed.cmd, "node");
    assert.deepEqual(parsed.args, ["--flag=value", "app.js"]);
  });
});

describe("safer-exec availability", () => {
  it("reports the tracing runtime as available in a healthy install", () => {
    assert.strictEqual(typeof isSaferExecAvailable(), "boolean");
    // @cdxgen/safer-exec is an optional dependency; the test environments
    // install it, so the runtime must load.
    assert.strictEqual(isSaferExecAvailable(), true);
  });

  it("resolves the platform payload binary on supported platforms", () => {
    const binPath = resolveSaferExecBinary();
    assert.ok(binPath, "expected the safer-exec payload to resolve");
    const expected =
      process.platform === "win32" ? "safer-exec-rt.exe" : "safer-exec-rt";
    assert.ok(
      binPath.endsWith(expected),
      `unexpected payload path: ${binPath}`,
    );
  });

  it("resolves the Windows payload next to its MXC executor", async () => {
    const esmock = (await import("esmock")).default;
    const { join } = await import("node:path");
    const seen = [];
    const { resolveSaferExecBinary: resolveOnWindows } = await esmock(
      "./traceRunner.js",
      {
        "node:os": { platform: () => "win32", arch: () => "arm64" },
        "node:fs": {
          existsSync: (p) => {
            seen.push(p);
            return p.endsWith(
              join("safer-exec-windows-arm64", "bin", "safer-exec-rt.exe"),
            );
          },
          realpathSync: (p) => p,
          chmodSync: () => {
            throw new Error("chmod must not run on Windows");
          },
        },
      },
    );
    const binPath = resolveOnWindows();
    assert.ok(binPath, `nothing resolved; probed ${seen.join(", ")}`);
    assert.ok(
      binPath.endsWith(
        join("safer-exec-windows-arm64", "bin", "safer-exec-rt.exe"),
      ),
    );
  });

  it("rejects executeAndTrace instead of returning an empty result when the runtime is missing", async () => {
    const esmock = (await import("esmock")).default;
    const { executeAndTrace: executeAndTraceWithoutRuntime } = await esmock(
      "./traceRunner.js",
      {
        "@cdxgen/safer-exec": { SaferExec: undefined },
      },
    );
    await assert.rejects(
      () => executeAndTraceWithoutRuntime("echo hello"),
      /@cdxgen\/safer-exec/,
    );
  });

  it("returns an empty result without throwing for an empty command", async () => {
    assert.deepEqual(await executeAndTrace(""), {
      libPaths: [],
      httpAccessEntries: [],
    });
  });
});

describe("engine messages", () => {
  it("keeps the first and the last part of what is written to the stderr sink", () => {
    const sink = headAndTailSink(64);
    sink.write("safer-exec: warning: w\n");
    for (let i = 0; i < 64; i++) {
      sink.write(Buffer.alloc(40, "x"));
    }
    sink.write("safer-exec: z\n");
    const text = sink.text();
    assert.match(text, /^safer-exec: warning: w\n/);
    assert.match(text, /safer-exec: z\n$/);
    assert.ok(text.length < 64 + 2 * 40, `kept ${text.length} bytes`);
    // Nothing dropped: the text is what was written.
    const small = headAndTailSink(1024);
    small.write("safer-exec: warning: w\n");
    assert.strictEqual(small.text(), "safer-exec: warning: w\n");
  });

  it("separates engine warnings from the error that stopped the run", () => {
    const { warnings, error } = engineMessages(
      [
        "npm warn deprecated left-pad",
        "safer-exec: warning: not enforced on Windows: privateTmp for C:\\T",
        "safer-exec: egress proxy listening on 127.0.0.1:1234",
        "safer-exec: warning: not enforced on Windows: privateTmp for C:\\T",
        "safer-exec: strict mode: not enforceable on Windows: blockJIT",
        "",
      ].join("\r\n"),
    );
    assert.deepEqual(warnings, [
      "safer-exec: warning: not enforced on Windows: privateTmp for C:\\T",
    ]);
    assert.strictEqual(
      error,
      "safer-exec: strict mode: not enforceable on Windows: blockJIT",
    );
    assert.deepEqual(engineMessages(undefined), {
      warnings: [],
      error: undefined,
    });
  });

  it("fails a --strict trace the sandbox refused instead of returning an empty result", async () => {
    const esmock = (await import("esmock")).default;
    const refusal = {
      exitCode: 1,
      stderr:
        "safer-exec: strict mode: not enforceable on Windows: privateTmp for C:\\T\n",
      auditLog: [],
    };
    const { executeAndTrace: trace } = await esmock("./traceRunner.js", {
      "@cdxgen/safer-exec": { SaferExec: fakeSaferExec(refusal) },
    });
    await assert.rejects(
      () => trace("cmd /c ver", undefined, { strict: true }),
      /Tracing refused under --strict: safer-exec: strict mode/,
    );
    // Without --strict the same failure is reported and the trace goes on.
    const result = await trace("cmd /c ver", undefined, {});
    assert.deepEqual(result.libPaths, []);
  });

  it("rejects instead of returning an empty result when the run itself fails", async () => {
    const esmock = (await import("esmock")).default;
    const { tmpdir } = await import("node:os");
    const { readdirSync } = await import("node:fs");
    const cboms = () =>
      readdirSync(tmpdir()).filter((f) => f.startsWith("cdxgen-cbom-"));
    const before = cboms();
    const chain = new Proxy(
      {},
      {
        get: (_target, prop) =>
          prop === "runPipe"
            ? async () => {
                throw new Error("spawn ENOENT");
              }
            : () => chain,
      },
    );
    const { executeAndTrace: trace } = await esmock("./traceRunner.js", {
      "@cdxgen/safer-exec": {
        SaferExec: function SaferExec() {
          return chain;
        },
      },
    });
    await assert.rejects(() => trace("cmd", undefined, {}), /spawn ENOENT/);
    // The temporary CBOM path is released even though the run failed.
    assert.deepEqual(cboms(), before);
  });

  it("keeps the trace and the engine's error when the command floods its output", async () => {
    const esmock = (await import("esmock")).default;
    const flood = Buffer.alloc(64 * 1024, "x");
    const calls = [];
    const noisy = {
      exitCode: 1,
      stdout: Array(64).fill(flood),
      stderr: [
        "safer-exec: warning: not enforced: privateTmp\n",
        ...Array(64).fill(flood),
        "\nsafer-exec: strict mode: not enforceable: blockJIT\n",
      ],
      auditLog: [{ type: "lib-load", target: "/usr/lib/libssl.so.3" }],
    };
    const { executeAndTrace: trace } = await esmock("./traceRunner.js", {
      "@cdxgen/safer-exec": { SaferExec: fakeSaferExec(noisy, calls) },
    });
    const result = await trace("cmd", undefined, { traceCrypto: false });
    assert.deepEqual(result.libPaths, ["/usr/lib/libssl.so.3"]);
    // The command's stdout is discarded, not held in this process.
    assert.strictEqual(calls[0].stdout, null);
    // Of the 4 MiB of stderr, only the start and the end are kept.
    assert.ok(calls[0].stderr.text().length < 2 * 1024 * 1024);
    assert.match(calls[0].stderr.text(), /^safer-exec: warning: not enforced/);
    await assert.rejects(
      () => trace("cmd", undefined, { strict: true, traceCrypto: false }),
      /Tracing refused under --strict: safer-exec: strict mode/,
    );
  });
});
