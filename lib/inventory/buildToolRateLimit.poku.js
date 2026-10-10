import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it } from "poku";

import { getLedgerEvents, resetLedgerEvents } from "../core/buildLedger.js";
import { resetRunState } from "../core/runState.js";
import {
  detectBuildToolRateLimit,
  isBuildToolRateLimited,
  noteBuildToolRateLimit,
} from "./buildToolRateLimit.js";

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "test",
  "data",
  "jvm-rate-limits",
);

const recording = (name) => readFileSync(join(FIXTURES, name), "utf-8");

describe("detectBuildToolRateLimit()", () => {
  it("detects the recorded origin 429 of each tool", () => {
    assert.ok(detectBuildToolRateLimit(recording("maven-429.txt"), "maven"));
    assert.ok(detectBuildToolRateLimit(recording("gradle-429.txt"), "gradle"));
    assert.ok(
      detectBuildToolRateLimit(
        recording("gradle-429-dependencies.txt"),
        "gradle",
      ),
      "the dependencies task reports the rate limit only in its --info lines",
    );
    for (const [tool, fixture] of [
      ["sbt", "sbt-coursier-429.txt"],
      ["sbt", "sbt2-coursier-429.txt"],
      ["mill", "mill-429.txt"],
      ["scala-cli", "scala-cli-429.txt"],
    ]) {
      assert.ok(
        detectBuildToolRateLimit(recording(fixture), tool),
        `${tool} on ${fixture}`,
      );
    }
  });

  it("never reads a missing artifact as a rate limit", () => {
    for (const fixture of [
      "maven-404.txt",
      "gradle-404.txt",
      "sbt-coursier-404.txt",
      "sbt2-coursier-404.txt",
      "mill-404.txt",
      "scala-cli-404.txt",
    ]) {
      for (const tool of ["maven", "gradle", "sbt", "mill", "scala-cli"]) {
        assert.ok(
          !detectBuildToolRateLimit(recording(fixture), tool),
          `${fixture} matched ${tool}`,
        );
      }
    }
  });

  it("ignores absent output and unknown tools", () => {
    assert.ok(!detectBuildToolRateLimit(undefined, "maven"));
    assert.ok(!detectBuildToolRateLimit("", "gradle"));
    assert.ok(!detectBuildToolRateLimit("status code: 429", "cargo"));
  });
});

describe("noteBuildToolRateLimit()", () => {
  it("prints one hint per tool and scan and records the remediation once", async () => {
    const previousIntrospect = process.env.CDXGEN_INTROSPECT;
    const printed = [];
    const originalWarn = console.warn;
    process.env.CDXGEN_INTROSPECT = "true";
    console.warn = (...args) => printed.push(args.join(" "));
    try {
      resetRunState();
      resetLedgerEvents();
      const output = recording("maven-429.txt");
      assert.ok(
        noteBuildToolRateLimit("maven", output, {
          command: "mvn dependency:tree",
        }),
      );
      assert.ok(noteBuildToolRateLimit("maven", output));
      assert.ok(isBuildToolRateLimited("maven"));
      assert.ok(!isBuildToolRateLimited("gradle"));
      const events = getLedgerEvents().filter(
        (event) => event.remediationId === "build.rate-limited",
      );
      assert.equal(printed.length, 1, "the hint printed more than once");
      assert.match(printed[0], /<mirror>/);
      assert.match(printed[0], /MVNW_REPOURL/);
      assert.match(printed[0], /MAVEN_CENTRAL_URL/);
      assert.equal(events.length, 1, "the degradation recorded more than once");
      assert.equal(events[0].tool, "maven");
      assert.equal(events[0].ecosystem, "java");
      // A new scan starts with no remembered rate limit.
      resetRunState();
      assert.ok(!isBuildToolRateLimited("maven"));
    } finally {
      console.warn = originalWarn;
      resetRunState();
      resetLedgerEvents();
      if (previousIntrospect === undefined) {
        delete process.env.CDXGEN_INTROSPECT;
      } else {
        process.env.CDXGEN_INTROSPECT = previousIntrospect;
      }
    }
  });

  it("names each tool's own mirror setting", async () => {
    const previousIntrospect = process.env.CDXGEN_INTROSPECT;
    const printed = [];
    const originalWarn = console.warn;
    process.env.CDXGEN_INTROSPECT = "true";
    console.warn = (...args) => printed.push(args.join(" "));
    try {
      resetRunState();
      resetLedgerEvents();
      assert.ok(
        noteBuildToolRateLimit("sbt", recording("sbt-coursier-429.txt")),
      );
      assert.ok(noteBuildToolRateLimit("mill", recording("mill-429.txt")));
      assert.equal(printed.length, 2);
      // sbt reads its own repositories file, not Coursier's mirror file.
      assert.match(printed[0], /\.sbt\/repositories/);
      assert.match(printed[0], /sbt\.override\.build\.repos=true/);
      assert.match(printed[0], /no further sbt resolution/);
      assert.match(printed[1], /mirror\.properties/);
      assert.match(printed[1], /semicolons/);
      // Mill resolves in one run, so the hint promises no skipped runs.
      assert.doesNotMatch(printed[1], /no further/);
    } finally {
      console.warn = originalWarn;
      resetRunState();
      resetLedgerEvents();
      if (previousIntrospect === undefined) {
        delete process.env.CDXGEN_INTROSPECT;
      } else {
        process.env.CDXGEN_INTROSPECT = previousIntrospect;
      }
    }
  });
});
