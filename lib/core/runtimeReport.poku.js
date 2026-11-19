import { connect, createServer } from "node:net";
import process from "node:process";

import { assert, describe, it } from "poku";

import { readRuntimeReport } from "./runtimeReport.js";

const hasReport = typeof process.report?.getReport === "function";

describe("readRuntimeReport()", () => {
  it("returns the parts of the report cdxgen reads", () => {
    const report = readRuntimeReport();
    if (!hasReport) {
      assert.strictEqual(report, undefined);
      return;
    }
    const full = process.report.getReport();
    assert.deepStrictEqual(
      report.header?.componentVersions,
      full.header?.componentVersions,
    );
    assert.deepStrictEqual(report.header?.release, full.header?.release);
    assert.deepStrictEqual(report.sharedObjects, full.sharedObjects);
  });

  it("excludes the network for the call and puts the setting back", () => {
    if (!hasReport) {
      return;
    }
    const getReport = process.report.getReport;
    const before = process.report.excludeNetwork;
    const seen = [];
    process.report.getReport = function (...args) {
      seen.push(process.report.excludeNetwork);
      return getReport.apply(this, args);
    };
    try {
      for (const setting of [false, true]) {
        process.report.excludeNetwork = setting;
        readRuntimeReport();
        assert.strictEqual(process.report.excludeNetwork, setting);
      }
      assert.deepStrictEqual(seen, [true, true]);
      process.report.excludeNetwork = false;
      process.report.getReport = () => {
        throw new Error("no report");
      };
      assert.throws(() => readRuntimeReport(), /no report/);
      assert.strictEqual(process.report.excludeNetwork, false);
    } finally {
      process.report.getReport = getReport;
      process.report.excludeNetwork = before;
    }
  });

  it("does not resolve the addresses of open sockets to host names", async () => {
    const accepted = [];
    const server = createServer((socket) => accepted.push(socket));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = connect(server.address().port, "127.0.0.1");
    await new Promise((resolve) => client.once("connect", resolve));
    try {
      const endpoints = (readRuntimeReport()?.libuv || [])
        .filter((handle) => handle.type === "tcp")
        .flatMap((handle) => [handle.localEndpoint, handle.remoteEndpoint])
        .filter(Boolean);
      // An endpoint that was looked up names its host ("localhost"); one that
      // was left alone repeats the address.
      for (const endpoint of endpoints) {
        assert.strictEqual(endpoint.host, endpoint.ip4 ?? endpoint.ip6);
      }
    } finally {
      client.destroy();
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
