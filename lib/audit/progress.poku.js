import process from "node:process";

import { assert, describe, it } from "poku";

import {
  createProgressTracker,
  formatTargetLabel,
  shouldRenderProgress,
} from "./progress.js";

function createStream(isTTY = true) {
  return {
    isTTY,
    writes: [],
    write(chunk) {
      this.writes.push(chunk);
    },
  };
}

describe("formatTargetLabel()", () => {
  it("formats namespace and version when present", () => {
    assert.strictEqual(
      formatTargetLabel({
        name: "requests",
        namespace: "pallets",
        type: "pypi",
        version: "2.32.3",
      }),
      "pypi:pallets/requests@2.32.3",
    );
  });
});

describe("shouldRenderProgress()", () => {
  it("disables interactive progress for non-tty streams", () => {
    assert.strictEqual(
      shouldRenderProgress({
        stream: createStream(false),
      }),
      false,
    );
  });
});

describe("createProgressTracker()", () => {
  it("persists preflight info messages before target execution begins", () => {
    const originalCI = process.env.CI;
    delete process.env.CI;

    try {
      const stream = createStream(true);
      const tracker = createProgressTracker({ stream });

      tracker.onProgress({
        message:
          "Predictive audit selected 50 of 120 package(s) (12 required + 38 additional) using required-first prioritization. This may take several minutes depending on repository lookups and child SBOM generation.",
        total: 50,
        type: "run:info",
      });
      tracker.onProgress({
        total: 50,
        type: "run:start",
      });
      tracker.stop();

      const output = stream.writes.join("");
      assert.match(output, /selected 50 of 120 package\(s\)/);
      assert.match(
        output,
        /Preparing predictive audit for 50 package\(s\)\.\.\./,
      );
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });

  it("renders the current package name and stage to stderr-like streams in interactive mode", () => {
    const originalCI = process.env.CI;
    delete process.env.CI;

    try {
      const stream = createStream(true);
      const tracker = createProgressTracker({ stream });

      tracker.onProgress({
        total: 2,
        type: "run:start",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        total: 2,
        type: "target:start",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        stage: "generating child SBOM",
        total: 2,
        type: "target:stage",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        result: {
          assessment: {
            severity: "medium",
          },
          status: "audited",
        },
        total: 2,
        type: "target:finish",
      });
      tracker.stop();

      const output = stream.writes.join("");
      assert.match(output, /npm:left-pad@1.3.0/);
      assert.match(output, /generating child SBOM/);
      assert.match(output, /done npm:left-pad@1.3.0 — MEDIUM/);
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });

  it("persists only start and finish updates when CI disables interactive progress", () => {
    const originalCI = process.env.CI;
    process.env.CI = "true";

    try {
      const stream = createStream(true);
      const tracker = createProgressTracker({ stream });

      tracker.onProgress({
        total: 2,
        type: "run:start",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        total: 2,
        type: "target:start",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        stage: "generating child SBOM",
        total: 2,
        type: "target:stage",
      });
      tracker.onProgress({
        index: 1,
        label: "npm:left-pad@1.3.0",
        result: {
          assessment: {
            severity: "medium",
          },
          status: "audited",
        },
        total: 2,
        type: "target:finish",
      });
      tracker.stop();

      const output = stream.writes.join("");
      assert.match(
        output,
        /Preparing predictive audit for 2 package\(s\)\.\.\./,
      );
      assert.doesNotMatch(output, /generating child SBOM/);
      assert.match(output, /done npm:left-pad@1.3.0 — MEDIUM/);
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });
});
