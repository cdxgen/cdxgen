import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import { normalizeHbomOptions } from "../inventory/hbom.js";
import {
  applyAdvancedOptions,
  applyCommandNameDefaults,
  applyOperatorToolingChoice,
  applyPostConstructionOverrides,
  buildInitialOptions,
  buildOptionsFromArgs,
  configFileSelections,
  dropConfigAuditOverrides,
  findInTreeSlicesFiles,
  isUserProvided,
  markConfigFileTeaTargets,
  operatorOptionChoice,
  resolveMetadataProperties,
  validateSpecVersion,
} from "./cliOptions.js";

// ---------------------------------------------------------------------------
// isUserProvided
// ---------------------------------------------------------------------------

describe("isUserProvided", () => {
  it("returns false when value equals the yargs default", () => {
    assert.strictEqual(isUserProvided(1.7, 1.7), false);
    assert.strictEqual(isUserProvided("bom.json", "bom.json"), false);
    assert.strictEqual(isUserProvided(true, true), false);
  });

  it("returns true when value differs from the yargs default", () => {
    assert.strictEqual(isUserProvided(1.5, 1.7), true);
    assert.strictEqual(isUserProvided("custom.json", "bom.json"), true);
    assert.strictEqual(isUserProvided(false, true), true);
  });

  it("returns false for undefined", () => {
    assert.strictEqual(isUserProvided(undefined, 1.7), false);
  });
});

// ---------------------------------------------------------------------------
// validateSpecVersion
// ---------------------------------------------------------------------------

describe("validateSpecVersion", () => {
  it("accepts 1.6, 1.7, and 2.0 as generation targets", () => {
    assert.strictEqual(validateSpecVersion(1.6), null);
    assert.strictEqual(validateSpecVersion(1.7), null);
    assert.strictEqual(validateSpecVersion(2.0), null);
  });

  it("rejects 1.4 with an actionable message mentioning the downgrade path", () => {
    const msg = validateSpecVersion(1.4);
    assert.ok(msg !== null);
    assert.ok(msg.includes("--spec-version 1.4"));
    assert.ok(msg.includes("v13 spec floor"));
    assert.ok(msg.includes("1.6"));
    assert.ok(msg.includes("downgrade"));
    assert.ok(msg.includes("MIGRATING-TO-V13.md"));
  });

  it("rejects 1.5 with an actionable message mentioning the downgrade path", () => {
    const msg = validateSpecVersion(1.5);
    assert.ok(msg !== null);
    assert.ok(msg.includes("--spec-version 1.5"));
    assert.ok(msg.includes("v13 spec floor"));
    assert.ok(msg.includes("downgrade"));
  });

  it("does not claim that generating 1.6 emits a legacy document", () => {
    const msg = validateSpecVersion(1.5);
    // The downgrade logic is retained but is only reachable via the library
    // API. The CLI message must not promise a 1.5 document from a 1.6 run.
    assert.ok(msg.includes("it will not emit CycloneDX 1.5"));
    assert.ok(msg.includes("createBom()"));
  });

  it("reports non-numeric values readably rather than as NaN", () => {
    const msg = validateSpecVersion(Number("abc"));
    assert.ok(msg !== null);
    assert.ok(msg.includes("not a number"));
    assert.ok(!msg.includes("NaN is not supported"));
  });

  it("rejects unsupported versions with a concise message", () => {
    const msg = validateSpecVersion(3.0);
    assert.ok(msg !== null);
    assert.ok(msg.includes("not supported"));
    assert.ok(msg.includes("1.6, 1.7, 2.0"));
  });

  it("includes the invoked command name in the error", () => {
    const msg = validateSpecVersion(1.4, "obom");
    assert.ok(msg !== null);
    assert.ok(msg.startsWith("obom:"));
  });
});

// ---------------------------------------------------------------------------
// applyCommandNameDefaults
// ---------------------------------------------------------------------------

describe("applyCommandNameDefaults", () => {
  it("sets type to ['os'] for obom command when type is not set", () => {
    const result = applyCommandNameDefaults({}, "obom");
    assert.deepStrictEqual(result.type, ["os"]);
  });

  it("does not override type for obom when type is already set", () => {
    const result = applyCommandNameDefaults({ type: ["java"] }, "obom");
    assert.deepStrictEqual(result.type, ["java"]);
  });

  it("sets format to 'spdx' for spdxgen command", () => {
    const result = applyCommandNameDefaults({}, "spdxgen");
    assert.strictEqual(result.format, "spdx");
  });

  it("does not override format for spdxgen when format is already set", () => {
    const result = applyCommandNameDefaults({ format: "cyclonedx" }, "spdxgen");
    assert.strictEqual(result.format, "cyclonedx");
  });

  it("sets type and includeFormulation for aibom command", () => {
    const result = applyCommandNameDefaults({}, "aibom");
    assert.deepStrictEqual(result.type, ["ai"]);
    assert.strictEqual(result.includeFormulation, true);
    assert.strictEqual(result.bomAuditCategories, "ai-bom");
  });

  it("does not override type for aibom when type is already set", () => {
    const result = applyCommandNameDefaults({ type: ["python"] }, "aibom");
    assert.deepStrictEqual(result.type, ["python"]);
  });

  it("preserves existing bomAuditCategories for aibom", () => {
    const result = applyCommandNameDefaults(
      { bomAuditCategories: "custom" },
      "aibom",
    );
    assert.strictEqual(result.bomAuditCategories, "custom");
  });

  it("does nothing for standard cdxgen command", () => {
    const args = { type: ["java"], format: "cyclonedx" };
    const result = applyCommandNameDefaults(args, "cdxgen");
    assert.deepStrictEqual(result.type, ["java"]);
    assert.strictEqual(result.format, "cyclonedx");
  });

  it("does not mutate the original args object", () => {
    const args = {};
    applyCommandNameDefaults(args, "obom");
    assert.strictEqual(args.type, undefined);
  });
});

// ---------------------------------------------------------------------------
// buildInitialOptions
// ---------------------------------------------------------------------------

describe("buildInitialOptions", () => {
  it("renames type → projectType", () => {
    const options = buildInitialOptions(
      { type: ["java", "js"] },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.deepStrictEqual(options.projectType, ["java", "js"]);
  });

  it("renames recurse → multiProject", () => {
    const options = buildInitialOptions(
      { recurse: true },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.multiProject, true);
  });

  it("renames projectId → project", () => {
    const options = buildInitialOptions(
      { projectId: "abc-123" },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.project, "abc-123");
  });

  it("computes noBabel from noBabel flag", () => {
    const options = buildInitialOptions(
      { noBabel: true },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.noBabel, true);
  });

  it("computes noBabel from babel === false (boolean negation)", () => {
    const options = buildInitialOptions(
      { babel: false },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.noBabel, true);
  });

  it("sets deep when evidence is true", () => {
    const options = buildInitialOptions(
      { deep: false, evidence: true },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.deep, true);
  });

  it("sets deep when deep is true", () => {
    const options = buildInitialOptions(
      { deep: true, evidence: false },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.deep, true);
  });

  it("deep is false when both deep and evidence are false", () => {
    const options = buildInitialOptions(
      { deep: false, evidence: false },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.deep, false);
  });

  it("passes through output unmodified in non-secure mode", () => {
    const options = buildInitialOptions(
      { output: "my-bom.json" },
      { filePath: "/some/path", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.output, "my-bom.json");
  });

  it("prefers exclude over excludeRegex", () => {
    const options = buildInitialOptions(
      { exclude: ["*.lock"], excludeRegex: ["*.txt"] },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.deepStrictEqual(options.exclude, ["*.lock"]);
  });

  it("falls back to excludeRegex when exclude is not set", () => {
    const options = buildInitialOptions(
      { excludeRegex: ["*.txt"] },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.deepStrictEqual(options.exclude, ["*.txt"]);
  });

  it("prefers include over includeRegex", () => {
    const options = buildInitialOptions(
      { include: "*.java", includeRegex: "*.py" },
      { filePath: ".", isRemoteOrPurl: false },
    );
    assert.strictEqual(options.include, "*.java");
  });
});

// ---------------------------------------------------------------------------
// applyPostConstructionOverrides
// ---------------------------------------------------------------------------

describe("applyPostConstructionOverrides", () => {
  const baseContext = {
    invokedCommandName: "cdxgen",
    userSetSpecVersion: false,
    isDryRun: false,
  };

  it("deduplicates projectType array", () => {
    const options = { projectType: ["java", "java", "js", "js"] };
    applyPostConstructionOverrides(options, baseContext);
    assert.deepStrictEqual(options.projectType, ["java", "js"]);
  });

  it("does not fail when projectType is undefined", () => {
    const options = {};
    const warnings = applyPostConstructionOverrides(options, baseContext);
    assert.ok(Array.isArray(warnings));
  });

  // --- cbom command overrides ---
  it("sets includeCrypto, evidence, deep for cbom command", () => {
    const options = { specVersion: 1.7 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
    });
    assert.strictEqual(options.includeCrypto, true);
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.deep, true);
  });

  it("sets specVersion to 1.7 for cbom when user did not set it", () => {
    const options = { specVersion: 1.5 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
      userSetSpecVersion: false,
    });
    assert.strictEqual(options.specVersion, 1.7);
  });

  it("preserves user-provided specVersion for cbom", () => {
    const options = { specVersion: 1.5 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
      userSetSpecVersion: options.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.5);
  });

  it("preserves user-provided specVersion for saasbom", () => {
    const options = { specVersion: 1.6 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "saasbom",
      userSetSpecVersion: options.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.6);
  });

  it("returns error warning when cbom is used with componentType", () => {
    const options = { componentType: ["library"] };
    const warnings = applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
    });
    assert.ok(warnings.some((w) => w.level === "error"));
  });

  it("returns error warning and disables crypto flows when cbom is used with -t os", () => {
    const options = { projectType: ["os"], specVersion: 1.6 };
    const warnings = applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
    });
    const errorWarning = warnings.find((w) => w.level === "error");
    assert.ok(errorWarning);
    assert.match(errorWarning.message, /obom/);
    assert.notStrictEqual(options.includeCrypto, true);
    assert.notStrictEqual(options.evidence, true);
    assert.notStrictEqual(options.deep, true);
    assert.strictEqual(options.specVersion, 1.6);
  });

  it("returns error warning when cbom is used with an os alias type", () => {
    for (const projectType of ["linux", "windows", "macos", "osquery"]) {
      const options = { projectType: [projectType] };
      const warnings = applyPostConstructionOverrides(options, {
        ...baseContext,
        invokedCommandName: "cbom",
      });
      assert.ok(
        warnings.some((w) => w.level === "error"),
        `expected an error warning for -t ${projectType}`,
      );
      assert.notStrictEqual(options.includeCrypto, true);
    }
  });

  it("returns error warning when cbom is used with os among multiple types", () => {
    const options = { projectType: ["js", "os"] };
    const warnings = applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cbom",
    });
    assert.ok(
      warnings.some((w) => w.level === "error" && w.message.includes("-t os")),
    );
    assert.notStrictEqual(options.includeCrypto, true);
    assert.notStrictEqual(options.evidence, true);
  });

  // --- saasbom command overrides ---
  it("sets evidence and deep for saasbom command", () => {
    const options = {};
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "saasbom",
    });
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.deep, true);
  });

  // --- cdxgen-secure overrides ---
  it("disables installDeps for cdxgen-secure command", () => {
    const options = { installDeps: true };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      invokedCommandName: "cdxgen-secure",
    });
    assert.strictEqual(options.installDeps, false);
  });

  // --- dry-run overrides ---
  it("disables installDeps in dry-run mode", () => {
    const options = { installDeps: true };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      isDryRun: true,
    });
    assert.strictEqual(options.installDeps, false);
  });

  // --- standard → specVersion ---
  it("sets specVersion correctly for standards", () => {
    let options = { standard: ["asvs-5.0"], specVersion: 1.5 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      userSetSpecVersion: options.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.6);
    options = { standard: ["asvs-5.0"], specVersion: 1.6 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      userSetSpecVersion: options.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.6);
    options = { standard: ["asvs-5.0"], specVersion: 1.7 };
    applyPostConstructionOverrides(options, {
      ...baseContext,
      userSetSpecVersion: options.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.7);
  });

  // --- HBOM formulation suppression ---
  it("suppresses formulation for HBOM-only project types", () => {
    const options = {
      includeFormulation: true,
      projectType: ["hbom"],
    };
    const warnings = applyPostConstructionOverrides(options, baseContext);
    assert.strictEqual(options.includeFormulation, false);
    assert.ok(warnings.some((w) => w.message.includes("HBOM")));
  });

  it("warns about formulation data when serverUrl is set", () => {
    const options = {
      includeFormulation: true,
      projectType: ["java"],
      serverUrl: "https://example.com",
    };
    const warnings = applyPostConstructionOverrides(options, baseContext);
    assert.ok(warnings.some((w) => w.level === "warn"));
    assert.strictEqual(options.includeFormulation, true);
  });

  it("emits info warning about formulation when no serverUrl", () => {
    const options = {
      includeFormulation: true,
      projectType: ["java"],
    };
    const warnings = applyPostConstructionOverrides(options, baseContext);
    assert.ok(warnings.some((w) => w.level === "info"));
  });
});

// ---------------------------------------------------------------------------
// applyAdvancedOptions
// ---------------------------------------------------------------------------

describe("applyAdvancedOptions", () => {
  // --- Profile: appsec ---
  it("profile 'appsec' enables deep and bomAudit", () => {
    const options = { profile: "appsec" };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.bomAudit, true);
  });

  // --- Profile: research ---
  it("profile 'research' enables deep, evidence, includeCrypto", () => {
    const options = { profile: "research" };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.includeCrypto, true);
  });

  // --- Profile: operational ---
  it("profile 'operational' adds 'os' to projectType", () => {
    const options = { profile: "operational", projectType: ["java"] };
    applyAdvancedOptions(options);
    assert.ok(options.projectType.includes("os"));
    assert.ok(options.projectType.includes("java"));
    assert.strictEqual(options.bomAudit, true);
  });

  it("profile 'operational' creates projectType if absent", () => {
    const options = { profile: "operational" };
    applyAdvancedOptions(options);
    assert.deepStrictEqual(options.projectType, ["os"]);
  });

  it("profile 'operational' does not duplicate 'os' if already present", () => {
    const options = { profile: "operational", projectType: ["os"] };
    applyAdvancedOptions(options);
    const osCount = options.projectType.filter((t) => t === "os").length;
    assert.strictEqual(osCount, 1);
  });

  // --- Profile: threat-modeling ---
  it("profile 'threat-modeling' enables deep, evidence, bomAudit", () => {
    const options = { profile: "threat-modeling" };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.bomAudit, true);
  });

  // --- Profile: ml-tiny ---
  it("profile 'ml-tiny' disables deep, evidence, crypto, installDeps", () => {
    const options = { profile: "ml-tiny", deep: true, evidence: true };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, false);
    assert.strictEqual(options.evidence, false);
    assert.strictEqual(options.includeCrypto, false);
    assert.strictEqual(options.installDeps, false);
    assert.strictEqual(options.bomAudit, undefined);
  });

  it("profile 'ml-tiny' keeps a BOM audit that was asked for", () => {
    // The profile may come from the scanned project's config file, which
    // must not cancel an operator's --bom-audit.
    const options = { profile: "ml-tiny", bomAudit: true };
    applyAdvancedOptions(options);
    assert.strictEqual(options.bomAudit, true);
    assert.strictEqual(options.installDeps, false);
  });

  // --- Profile: ml ---
  it("profile 'ml' enables deep but disables evidence and crypto", () => {
    const options = { profile: "ml" };
    applyAdvancedOptions(options, { isSecureMode: false });
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.evidence, false);
    assert.strictEqual(options.includeCrypto, false);
    assert.strictEqual(options.installDeps, true);
  });

  it("profile 'ml' disables installDeps in secure mode", () => {
    const options = { profile: "ml" };
    applyAdvancedOptions(options, { isSecureMode: true });
    assert.strictEqual(options.installDeps, false);
  });

  // --- Profile: ml-deep ---
  it("profile 'ml-deep' enables deep, evidence, crypto, bomAudit", () => {
    const options = { profile: "ml-deep" };
    applyAdvancedOptions(options, { isSecureMode: false });
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.includeCrypto, true);
    assert.strictEqual(options.installDeps, true);
    assert.strictEqual(options.bomAudit, true);
  });

  // --- Profile: generic (default) ---
  it("profile 'generic' makes no changes", () => {
    const options = { profile: "generic", deep: false, evidence: false };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, false);
    assert.strictEqual(options.evidence, false);
  });

  // --- Lifecycle: pre-build ---
  it("lifecycle 'pre-build' disables installDeps", () => {
    const options = { profile: "generic", lifecycle: "pre-build" };
    applyAdvancedOptions(options);
    assert.strictEqual(options.installDeps, false);
  });

  // --- Lifecycle: post-build ---
  it("lifecycle 'post-build' enables installDeps for supported types", () => {
    const options = {
      profile: "generic",
      lifecycle: "post-build",
      projectType: ["java"],
    };
    applyAdvancedOptions(options);
    assert.strictEqual(options.installDeps, true);
  });

  it("lifecycle 'post-build' returns error for unsupported types", () => {
    const options = {
      profile: "generic",
      lifecycle: "post-build",
      projectType: ["python"],
    };
    const warnings = applyAdvancedOptions(options);
    assert.ok(
      warnings.some(
        (w) => w.level === "error" && w.message.includes("post-build"),
      ),
    );
  });

  it("lifecycle 'post-build' returns error when projectType is missing", () => {
    const options = { profile: "generic", lifecycle: "post-build" };
    const warnings = applyAdvancedOptions(options);
    assert.ok(warnings.some((w) => w.level === "error"));
  });

  // --- Technique: source-code-analysis ---
  it("technique 'source-code-analysis' enables deep and evidence", () => {
    const options = {
      profile: "generic",
      technique: ["source-code-analysis"],
    };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.evidence, true);
  });

  it("technique without 'source-code-analysis' does not change deep", () => {
    const options = {
      profile: "generic",
      technique: ["manifest-analysis"],
      deep: false,
    };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, false);
  });

  // --- bomAudit auto-formulation ---
  it("bomAudit auto-enables formulation for non-HBOM projects", () => {
    const options = {
      profile: "generic",
      bomAudit: true,
      includeFormulation: false,
      projectType: ["java"],
    };
    const warnings = applyAdvancedOptions(options);
    assert.strictEqual(options.includeFormulation, true);
    assert.ok(warnings.some((w) => w.message.includes("formulation")));
  });

  it("bomAudit does not auto-enable formulation for HBOM-only", () => {
    const options = {
      profile: "generic",
      bomAudit: true,
      includeFormulation: false,
      projectType: ["hbom"],
    };
    applyAdvancedOptions(options);
    assert.strictEqual(options.includeFormulation, false);
  });

  it("bomAudit does not override existing formulation=true", () => {
    const options = {
      profile: "generic",
      bomAudit: true,
      includeFormulation: true,
      projectType: ["java"],
    };
    const warnings = applyAdvancedOptions(options);
    assert.strictEqual(options.includeFormulation, true);
    // Should not produce auto-formulation warning when already true
    assert.ok(
      !warnings.some((w) => w.message.includes("Automatically collecting")),
    );
  });

  // --- Auto-formulation: research profile, CI, obom and cbom (#859) ---
  it("profile 'research' auto-enables formulation with the privacy notice", () => {
    const originalCI = process.env.CI;
    delete process.env.CI;
    try {
      const options = {
        profile: "research",
        includeFormulation: false,
        projectType: ["java"],
      };
      const warnings = applyAdvancedOptions(options);
      assert.strictEqual(options.includeFormulation, true);
      assert.ok(warnings.some((w) => w.message.includes("formulation")));
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });

  const withCi = (value, fn) => {
    const originalCI = process.env.CI;
    if (value === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = value;
    }
    try {
      return fn();
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  };

  it("OS project types and their aliases auto-enable formulation", () => {
    withCi(undefined, () => {
      for (const projectType of [["os"], ["linux"], ["windows"], ["macos"]]) {
        const options = {
          profile: "generic",
          includeFormulation: false,
          projectType,
        };
        applyAdvancedOptions(options);
        assert.strictEqual(
          options.includeFormulation,
          true,
          `${projectType[0]} should include formulation by default`,
        );
      }
      // A plain software project stays unchanged outside CI, and crypto is
      // not a project type.
      for (const projectType of [["js"], ["java"], ["crypto"]]) {
        const plain = {
          profile: "generic",
          includeFormulation: false,
          projectType,
        };
        applyAdvancedOptions(plain);
        assert.strictEqual(
          plain.includeFormulation,
          false,
          `${projectType[0]} should not include formulation outside CI`,
        );
      }
    });
  });

  it("the cbom command auto-enables formulation", () => {
    withCi(undefined, () => {
      const options = {
        profile: "generic",
        includeFormulation: false,
        includeCrypto: true,
        projectType: ["java"],
      };
      const cbomWarnings = applyAdvancedOptions(options, {
        invokedCommandName: "cbom",
      });
      assert.strictEqual(options.includeFormulation, true);
      assert.ok(
        cbomWarnings.some((w) => w.message.includes("the cbom command")),
      );
      const viaArgs = buildOptionsFromArgs(
        { type: ["java"], profile: "generic", output: "bom.json" },
        {
          invokedCommandName: "cbom",
          filePath: "/tmp/project",
          isRemoteOrPurl: false,
          userSetSpecVersion: false,
          argv: [],
        },
      ).options;
      assert.strictEqual(viaArgs.includeCrypto, true);
      assert.strictEqual(viaArgs.includeFormulation, true);
    });
  });

  it("an explicit refusal keeps formulation off under CI and profiles", () => {
    const context = {
      invokedCommandName: "cdxgen",
      filePath: "/tmp/project",
      isRemoteOrPurl: false,
      userSetSpecVersion: false,
    };
    withCi("true", () => {
      const unset = buildOptionsFromArgs(
        { type: ["js"], profile: "generic", includeFormulation: false },
        { ...context, argv: [] },
      ).options;
      assert.strictEqual(unset.includeFormulation, true);
      for (const argv of [
        ["--no-include-formulation"],
        ["--include-formulation=false"],
        ["--include-formulation", "false"],
      ]) {
        const { options, warnings } = buildOptionsFromArgs(
          { type: ["js"], profile: "generic", includeFormulation: false },
          { ...context, argv },
        );
        assert.strictEqual(options.includeFormulation, false, argv.join(" "));
        assert.strictEqual(
          warnings.filter((w) =>
            w.message.includes(
              "Formulation stays off because it was refused explicitly",
            ),
          ).length,
          1,
        );
        // The CLI applies the advanced options a second time; the refusal
        // still holds and is not reported again.
        const again = applyAdvancedOptions(options, {
          invokedCommandName: "cdxgen",
        });
        assert.strictEqual(options.includeFormulation, false);
        assert.ok(!again.some((w) => w.message.includes("refused explicitly")));
      }
    });
    withCi("true", () => {
      const original = process.env.CDXGEN_INCLUDE_FORMULATION;
      try {
        process.env.CDXGEN_INCLUDE_FORMULATION = "false";
        const { options } = buildOptionsFromArgs(
          { type: ["js"], profile: "generic", includeFormulation: false },
          { ...context, argv: [] },
        );
        assert.strictEqual(options.includeFormulation, false);
        assert.strictEqual(options.includeFormulationRefused, true);
      } finally {
        if (original === undefined) {
          delete process.env.CDXGEN_INCLUDE_FORMULATION;
        } else {
          process.env.CDXGEN_INCLUDE_FORMULATION = original;
        }
      }
    });
    withCi(undefined, () => {
      for (const profile of ["research", "introspect"]) {
        const { options } = buildOptionsFromArgs(
          { type: ["js"], profile, includeFormulation: false },
          { ...context, argv: ["--no-include-formulation"] },
        );
        assert.strictEqual(options.includeFormulation, false, profile);
      }
      const obom = buildOptionsFromArgs(
        { profile: "generic", includeFormulation: false },
        {
          ...context,
          invokedCommandName: "obom",
          argv: ["--no-include-formulation"],
        },
      ).options;
      assert.strictEqual(obom.includeFormulation, false);
      const aibom = buildOptionsFromArgs(
        { profile: "generic", includeFormulation: false },
        {
          ...context,
          invokedCommandName: "aibom",
          argv: ["--no-include-formulation"],
        },
      ).options;
      assert.strictEqual(aibom.includeFormulation, false);
    });
  });

  it("names the server when formulation is enabled automatically", () => {
    withCi("true", () => {
      const options = {
        profile: "generic",
        includeFormulation: false,
        projectType: ["js"],
        serverUrl: "https://dtrack.example.com",
      };
      const warnings = applyAdvancedOptions(options, { isSecureMode: false });
      assert.strictEqual(options.includeFormulation, true);
      const serverWarnings = warnings.filter((w) =>
        w.message.includes("https://dtrack.example.com"),
      );
      assert.strictEqual(serverWarnings.length, 1);
      assert.strictEqual(serverWarnings[0].level, "warn");

      // Through buildOptionsFromArgs the warning appears exactly once.
      const built = buildOptionsFromArgs(
        {
          type: ["js"],
          profile: "generic",
          includeFormulation: false,
          serverUrl: "https://dtrack.example.com",
        },
        {
          invokedCommandName: "cdxgen",
          filePath: "/tmp/project",
          isRemoteOrPurl: false,
          userSetSpecVersion: false,
          isSecureMode: false,
          argv: [],
        },
      );
      assert.strictEqual(
        built.warnings.filter((w) =>
          w.message.includes("https://dtrack.example.com"),
        ).length,
        1,
      );

      // Secure mode does not submit formulation, so it is not turned on.
      const secure = {
        profile: "generic",
        includeFormulation: false,
        projectType: ["js"],
        serverUrl: "https://dtrack.example.com",
      };
      const secureWarnings = applyAdvancedOptions(secure, {
        isSecureMode: true,
      });
      assert.strictEqual(secure.includeFormulation, false);
      assert.ok(secureWarnings.every((w) => w.level === "info"));
      // The CLI applies the advanced options twice; the note prints once.
      const secureAgain = applyAdvancedOptions(secure, { isSecureMode: true });
      assert.strictEqual(secure.includeFormulation, false);
      assert.strictEqual(
        [...secureWarnings, ...secureAgain].filter((w) =>
          w.message.includes("secure mode does not submit formulation"),
        ).length,
        1,
      );
    });
  });

  it("CI=true auto-enables formulation and other CI values do not", () => {
    const originalCI = process.env.CI;
    try {
      process.env.CI = "true";
      const inCi = {
        profile: "generic",
        includeFormulation: false,
        projectType: ["java"],
      };
      const ciWarnings = applyAdvancedOptions(inCi);
      assert.strictEqual(inCi.includeFormulation, true);
      // Turned on by CI, not by a flag, so the host's crypto material stays
      // out; an explicit --include-formulation keeps it.
      assert.strictEqual(inCi.formulationAutomatic, true);
      const explicit = {
        profile: "generic",
        includeFormulation: true,
        projectType: ["java"],
      };
      applyAdvancedOptions(explicit);
      assert.strictEqual(explicit.formulationAutomatic, undefined);
      // The notice names what turned formulation on.
      assert.ok(
        ciWarnings.some(
          (w) =>
            w.message.includes("Automatically collecting formulation") &&
            w.message.includes("CI=true"),
        ),
      );

      process.env.CI = "false";
      const notCi = {
        profile: "generic",
        includeFormulation: false,
        projectType: ["java"],
      };
      applyAdvancedOptions(notCi);
      assert.strictEqual(notCi.includeFormulation, false);
    } finally {
      if (originalCI === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = originalCI;
      }
    }
  });
});

// ---------------------------------------------------------------------------
// buildOptionsFromArgs (integration)
// ---------------------------------------------------------------------------

describe("buildOptionsFromArgs", () => {
  const baseContext = {
    invokedCommandName: "cdxgen",
    filePath: "/tmp/project",
    isRemoteOrPurl: false,
    userSetSpecVersion: false,
    isDryRun: false,
    isSecureMode: false,
  };

  it("produces a complete options object with field renames", () => {
    const args = {
      type: ["java"],
      recurse: true,
      deep: false,
      evidence: false,
      output: "bom.json",
      profile: "generic",
      specVersion: 1.7,
    };
    const { options } = buildOptionsFromArgs(args, baseContext);
    assert.deepStrictEqual(options.projectType, ["java"]);
    assert.strictEqual(options.multiProject, true);
    assert.strictEqual(options.deep, false);
    assert.strictEqual(options.output, "bom.json");
  });

  it("preserves user specVersion through cbom command overrides", () => {
    const args = {
      specVersion: 1.5,
      output: "bom.json",
      profile: "generic",
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      invokedCommandName: "cbom",
      userSetSpecVersion: args.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.5);
    assert.strictEqual(options.evidence, true);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.includeCrypto, true);
  });

  it("defaults specVersion to 1.7 for cbom when not user-set", () => {
    const args = {
      specVersion: 1.5,
      output: "bom.json",
      profile: "generic",
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      invokedCommandName: "cbom",
      userSetSpecVersion: false,
    });
    assert.strictEqual(options.specVersion, 1.7);
  });

  it("applies profile and lifecycle together", () => {
    const args = {
      profile: "appsec",
      lifecycle: "pre-build",
      output: "bom.json",
      specVersion: 1.7,
    };
    const { options } = buildOptionsFromArgs(args, baseContext);
    assert.strictEqual(options.deep, true);
    assert.strictEqual(options.bomAudit, true);
    assert.strictEqual(options.installDeps, false);
  });

  it("obom command alias sets projectType to os", () => {
    const args = {
      output: "bom.json",
      profile: "generic",
      specVersion: 1.7,
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      invokedCommandName: "obom",
    });
    assert.deepStrictEqual(options.projectType, ["os"]);
  });

  it("standard sets specVersion to 1.7 when not user-provided", () => {
    const args = {
      standard: ["asvs-5.0"],
      specVersion: 1.5,
      output: "bom.json",
      profile: "generic",
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      userSetSpecVersion: false,
    });
    assert.strictEqual(options.specVersion, 1.7);
  });

  it("standard overrides user-provided specVersion correctly", () => {
    let args = {
      standard: ["asvs-5.0"],
      specVersion: 1.5,
      output: "bom.json",
      profile: "generic",
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      userSetSpecVersion: args.specVersion !== 1.7,
    });
    assert.strictEqual(options.specVersion, 1.6);
    args = {
      standard: ["asvs-5.0"],
      specVersion: 1.7,
      output: "bom.json",
      profile: "generic",
    };
    const optionsObj = buildOptionsFromArgs(args, {
      ...baseContext,
      userSetSpecVersion: args.specVersion !== 1.7,
    });
    assert.strictEqual(optionsObj.options.specVersion, 1.7);
  });

  it("collects warnings from multiple phases", () => {
    const args = {
      includeFormulation: true,
      output: "bom.json",
      profile: "generic",
      specVersion: 1.7,
      projectType: ["java"],
    };
    const { warnings } = buildOptionsFromArgs(args, baseContext);
    assert.ok(Array.isArray(warnings));
  });

  it("hands `cdxgen -t hbom --no-command-enrichment` to the HBOM collector", () => {
    // cdxgen never declares the flag, so yargs' boolean negation delivers it
    // as `commandEnrichment: false`; no `noCommandEnrichment` is ever set.
    const negated = buildOptionsFromArgs(
      {
        commandEnrichment: false,
        output: "bom.json",
        profile: "generic",
        specVersion: 1.7,
        type: ["hbom"],
      },
      baseContext,
    ).options;
    const plain = buildOptionsFromArgs(
      {
        output: "bom.json",
        profile: "generic",
        specVersion: 1.7,
        type: ["hbom"],
      },
      baseContext,
    ).options;
    assert.strictEqual(
      normalizeHbomOptions(negated).includeCommandEnrichment,
      false,
    );
    assert.strictEqual(
      normalizeHbomOptions(plain).includeCommandEnrichment,
      true,
    );
  });

  it("dry-run disables installDeps", () => {
    const args = {
      installDeps: true,
      output: "bom.json",
      profile: "generic",
      specVersion: 1.7,
    };
    const { options } = buildOptionsFromArgs(args, {
      ...baseContext,
      isDryRun: true,
    });
    assert.strictEqual(options.installDeps, false);
  });

  it("deduplicates project types", () => {
    const args = {
      type: ["java", "java", "js"],
      output: "bom.json",
      profile: "generic",
      specVersion: 1.7,
    };
    const { options } = buildOptionsFromArgs(args, baseContext);
    assert.deepStrictEqual(options.projectType, ["java", "js"]);
  });
});

// ---------------------------------------------------------------------------
// Introspection flags, env equivalence, and the introspect profile
// ---------------------------------------------------------------------------

describe("build-introspection options", () => {
  const initialContext = { filePath: ".", isRemoteOrPurl: false };

  function withIntrospectEnv(value, fn) {
    const original = process.env.CDXGEN_INTROSPECT;
    if (value === undefined) {
      delete process.env.CDXGEN_INTROSPECT;
    } else {
      process.env.CDXGEN_INTROSPECT = value;
    }
    try {
      return fn();
    } finally {
      if (original === undefined) {
        delete process.env.CDXGEN_INTROSPECT;
      } else {
        process.env.CDXGEN_INTROSPECT = original;
      }
    }
  }

  it("parses --introspect into options.introspect", () => {
    const options = buildInitialOptions({ introspect: true }, initialContext);
    assert.strictEqual(options.introspect, true);
  });

  it("keeps an explicit --no-introspect off even with the environment opt-in", () => {
    withIntrospectEnv("true", () => {
      const options = buildInitialOptions(
        { introspect: false },
        { ...initialContext, argv: ["node", "cdxgen", "--no-introspect"] },
      );
      assert.strictEqual(options.introspect, false);
    });
  });

  it("treats CDXGEN_INTROSPECT=true as the flag equivalent", () => {
    withIntrospectEnv("true", () => {
      const options = buildInitialOptions({}, initialContext);
      assert.strictEqual(options.introspect, true);
    });
  });

  it("treats CDXGEN_INTROSPECT=1 as the flag equivalent", () => {
    withIntrospectEnv("1", () => {
      const options = buildInitialOptions({}, initialContext);
      assert.strictEqual(options.introspect, true);
    });
  });

  it("leaves introspection unset without the flag or the environment", () => {
    withIntrospectEnv(undefined, () => {
      const options = buildInitialOptions({}, initialContext);
      // Undefined rather than false: a profile must still be able to turn
      // introspection on, and only --no-introspect records a refusal.
      assert.strictEqual(options.introspect, undefined);
    });
  });

  it("records only an explicit --no-introspect as a refusal", () => {
    withIntrospectEnv("true", () => {
      const options = buildInitialOptions(
        { introspect: false },
        { ...initialContext, argv: ["node", "cdxgen", "--no-introspect"] },
      );
      assert.strictEqual(options.introspect, false);
    });
  });

  it("reads an empty CDXGEN_INTROSPECT as silence, not as a refusal", () => {
    // The parser maps the variable onto the flag, so an exported but empty
    // variable arrives as `false`; only the command line refuses.
    withIntrospectEnv("", () => {
      const options = buildInitialOptions(
        { introspect: false },
        {
          ...initialContext,
          argv: ["node", "cdxgen", "--profile", "introspect"],
        },
      );
      assert.strictEqual(options.introspect, undefined);
    });
  });

  it("carries the report and gate options through unchanged", () => {
    const options = buildInitialOptions(
      {
        introspect: true,
        introspectReport: "/tmp/report.md",
        introspectJson: "/tmp/report.json",
        introspectFailBelow: 70,
        introspectAnnotate: false,
      },
      initialContext,
    );
    assert.strictEqual(options.introspectReport, "/tmp/report.md");
    assert.strictEqual(options.introspectJson, "/tmp/report.json");
    assert.strictEqual(options.introspectFailBelow, 70);
    assert.strictEqual(options.introspectAnnotate, false);
  });

  it("accepts a 0-100 gate threshold and rejects anything else", () => {
    const valid = applyPostConstructionOverrides(
      { introspectFailBelow: 85 },
      { invokedCommandName: "cdxgen", userSetSpecVersion: false },
    );
    assert.strictEqual(valid.length, 0);
    for (const bad of [101, -1, Number.NaN, "high"]) {
      const warnings = applyPostConstructionOverrides(
        { introspectFailBelow: bad },
        { invokedCommandName: "cdxgen", userSetSpecVersion: false },
      );
      assert.ok(
        warnings.some((w) => w.level === "error"),
        `expected an error warning for ${bad}`,
      );
    }
  });

  it("profile 'introspect' sets exactly introspect, annotate, formulation and evidence", () => {
    const options = { profile: "introspect" };
    const warnings = applyAdvancedOptions(options);
    assert.strictEqual(options.introspect, true);
    assert.strictEqual(options.introspectAnnotate, true);
    assert.strictEqual(options.includeFormulation, true);
    assert.strictEqual(options.evidence, true);
    // The profile must not touch the environment-measuring flags: an
    // introspection run grades the toolchain the user actually has.
    assert.strictEqual(options.installDeps, undefined);
    assert.strictEqual(options.deep, undefined);
    assert.strictEqual(options.bomAudit, undefined);
    assert.ok(
      warnings.some((w) =>
        w.message.includes("may include sensitive data such as emails"),
      ),
      "the shared formulation privacy notice fires for the profile",
    );
  });

  it("profile 'introspect' enables introspection through the real option chain", () => {
    // The composition is the contract: buildInitialOptions runs first for
    // every CLI invocation, and a profile that cannot survive it is inert.
    withIntrospectEnv(undefined, () => {
      const options = buildInitialOptions({}, initialContext);
      options.profile = "introspect";
      const warnings = applyAdvancedOptions(options);
      assert.strictEqual(options.introspect, true);
      assert.strictEqual(
        warnings.some((w) => w.message.includes("--no-introspect")),
        false,
        "a profile-only run must not claim the user passed --no-introspect",
      );
    });
  });

  it("profile 'introspect' keeps --no-introspect off and warns", () => {
    const options = { profile: "introspect", introspect: false };
    const warnings = applyAdvancedOptions(options);
    assert.strictEqual(options.introspect, false);
    assert.strictEqual(options.evidence, true);
    assert.ok(
      warnings.some((w) => w.message.includes("--no-introspect")),
      "the explicit negation is honoured with a warning",
    );
  });

  it("profile 'introspect' keeps --no-introspect-annotate off", () => {
    const options = { profile: "introspect", introspectAnnotate: false };
    applyAdvancedOptions(options);
    assert.strictEqual(options.introspect, true);
    assert.strictEqual(options.introspectAnnotate, false);
  });

  const otherProfiles = [
    "appsec",
    "research",
    "operational",
    "threat-modeling",
    "license-compliance",
    "machine-learning",
    "ml",
    "deep-learning",
    "ml-deep",
    "ml-tiny",
  ];
  for (const profile of otherProfiles) {
    it(`profile '${profile}' leaves introspection falsy`, () => {
      const options = { profile };
      applyAdvancedOptions(options, { isSecureMode: false });
      assert.ok(!options.introspect, `${profile} must not set introspect`);
    });
  }

  it("--bom-audit and --introspect do not imply each other", () => {
    const auditOnly = { profile: "generic", bomAudit: true };
    applyAdvancedOptions(auditOnly);
    assert.strictEqual(auditOnly.bomAudit, true);
    assert.ok(!auditOnly.introspect, "bom-audit must not enable introspection");

    const introspectOnly = { profile: "introspect" };
    applyAdvancedOptions(introspectOnly);
    assert.strictEqual(introspectOnly.introspect, true);
    assert.strictEqual(
      introspectOnly.bomAudit,
      undefined,
      "introspection must not enable bom-audit",
    );
  });
});

// ---------------------------------------------------------------------------
// metadataProperties (discussion 4391)
// ---------------------------------------------------------------------------
/**
 * Run a callback with the metadata property environment variables set, and
 * restore them afterwards.
 */
function withMetadataEnv(env, callback) {
  const names = ["CDXGEN_METADATA_PROPERTY", "CDXGEN_METADATA_PROPERTIES"];
  const saved = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  );
  for (const name of names) {
    if (env[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = env[name];
    }
  }
  try {
    return callback();
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  }
}

describe("resolveMetadataProperties", () => {
  it("combines the command line, the environment, and the config file", () => {
    const properties = withMetadataEnv(
      { CDXGEN_METADATA_PROPERTIES: '{"env":"prod"}' },
      () =>
        resolveMetadataProperties(
          // yargs keeps only the command line's `metadata-property`, dropping
          // the config file's, which is why each source is read on its own
          {
            metadataProperty: ["team=cli"],
            metadataProperties: '{"env":"prod"}',
          },
          {
            argv: ["node", "cdxgen", "--metadata-property", "team=cli", "."],
            projectConfig: {
              "metadata-property": ["cost=42"],
              metadataProperties: [{ name: "owner", value: "alice" }],
            },
          },
        ),
    );
    assert.deepStrictEqual(properties, [
      { name: "team", value: "cli" },
      { name: "env", value: "prod" },
      { name: "cost", value: "42" },
      { name: "owner", value: "alice" },
    ]);
  });

  it("takes a name set by several sources from the one that wins", () => {
    const properties = withMetadataEnv(
      {
        CDXGEN_METADATA_PROPERTY: "owner=env",
        CDXGEN_METADATA_PROPERTIES: '{"tier":"2"}',
      },
      () =>
        resolveMetadataProperties(
          { metadataProperty: ["tier=1"] },
          {
            argv: ["node", "cdxgen", "--metadata-property=tier=1"],
            projectConfig: {
              metadataProperties: [
                { name: "owner", value: "config" },
                { name: "tier", value: "3" },
                { name: "team", value: "config" },
              ],
            },
          },
        ),
    );
    assert.deepStrictEqual(properties, [
      { name: "tier", value: "1" },
      { name: "owner", value: "env" },
      { name: "team", value: "config" },
    ]);
  });

  it("keeps a name a single source repeats", () => {
    const properties = withMetadataEnv({}, () =>
      resolveMetadataProperties(
        { metadataProperty: ["tag=pci", "tag=eu", "tag=pci"] },
        {
          argv: ["node", "cdxgen", "--metadata-property", "tag=pci"],
          projectConfig: { metadataProperties: [{ name: "tag", value: "us" }] },
        },
      ),
    );
    assert.deepStrictEqual(properties, [
      { name: "tag", value: "pci" },
      { name: "tag", value: "eu" },
    ]);
  });

  it("does not mistake a value yargs took from the config file for the flag", () => {
    const properties = withMetadataEnv({}, () =>
      resolveMetadataProperties(
        { metadataProperty: ["cost=42"] },
        {
          argv: ["node", "cdxgen", "."],
          projectConfig: { "metadata-property": ["cost=42"] },
        },
      ),
    );
    assert.deepStrictEqual(properties, [{ name: "cost", value: "42" }]);
  });

  it("reads the args of a programmatic caller that has no config file", () => {
    const properties = withMetadataEnv({}, () =>
      resolveMetadataProperties(
        { metadataProperty: ["a=1"], metadataProperties: { b: "2" } },
        { argv: [] },
      ),
    );
    assert.deepStrictEqual(properties, [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ]);
  });
});

describe("buildOptionsFromArgs metadata properties", () => {
  it("merges the config file handed over by the CLI", () => {
    const { options } = withMetadataEnv({}, () =>
      buildOptionsFromArgs(
        { type: ["ruby"], specVersion: 1.7, metadataProperty: ["team=cli"] },
        {
          invokedCommandName: "cdxgen",
          filePath: ".",
          isRemoteOrPurl: false,
          userSetSpecVersion: false,
          projectConfig: {
            metadataProperties: [{ name: "cost", value: "42" }],
          },
        },
      ),
    );
    // No --metadata-property on this process's command line, so the args
    // value is what yargs would have taken from the config file
    assert.deepStrictEqual(options.metadataProperties, [
      { name: "cost", value: "42" },
    ]);
  });

  it("stays unset when no source provides any", () => {
    const options = withMetadataEnv({}, () =>
      buildInitialOptions(
        { metadataProperty: [] },
        { filePath: ".", isRemoteOrPurl: false, argv: [] },
      ),
    );
    assert.strictEqual(options.metadataProperties, undefined);
  });
});

// ---------------------------------------------------------------------------
// Operator tooling choice (issue #4527)
// ---------------------------------------------------------------------------

/**
 * Run `body` with FETCH_LICENSE restored afterwards: the ml profiles set it.
 *
 * @param {Function} body Code to run
 * @returns {*} What body returns
 */
function withFetchLicenseRestored(body) {
  const saved = process.env.FETCH_LICENSE;
  try {
    return body();
  } finally {
    if (saved === undefined) {
      delete process.env.FETCH_LICENSE;
    } else {
      process.env.FETCH_LICENSE = saved;
    }
  }
}

describe("operatorOptionChoice", () => {
  const installChoice = (argv, env = {}) =>
    operatorOptionChoice("install-deps", { argv, env, boolean: true });

  it("reads the boolean flag spellings", () => {
    assert.strictEqual(installChoice(["--install-deps"]), true);
    assert.strictEqual(installChoice(["--no-install-deps"]), false);
    assert.strictEqual(installChoice(["--install-deps=false"]), false);
    assert.strictEqual(installChoice(["--install-deps=true"]), true);
    assert.strictEqual(installChoice(["--install-deps", "false"]), false);
    assert.strictEqual(installChoice(["--install-deps", "true"]), true);
    assert.strictEqual(installChoice(["--installDeps"]), true);
    assert.strictEqual(installChoice(["--no-installDeps"]), false);
    assert.strictEqual(installChoice(["--installDeps=false"]), false);
  });

  it("does not take a following path as the flag's value", () => {
    assert.strictEqual(installChoice(["--install-deps", "src"]), true);
    assert.strictEqual(
      installChoice(["--no-install-deps", "--install-deps", "."]),
      true,
    );
  });

  it("lets the last spelling win", () => {
    assert.strictEqual(
      installChoice(["--no-install-deps", "--install-deps"]),
      true,
    );
    assert.strictEqual(
      installChoice(["--install-deps", "--no-install-deps"]),
      false,
    );
    assert.strictEqual(
      installChoice(["--install-deps", "--installDeps=false"]),
      false,
    );
  });

  it("stops reading at --", () => {
    assert.strictEqual(installChoice(["--", "--install-deps"]), undefined);
    assert.strictEqual(
      installChoice(["--no-install-deps", "--", "--install-deps"]),
      false,
    );
  });

  it("falls back to the CDXGEN_ environment variable", () => {
    assert.strictEqual(
      installChoice([], { CDXGEN_INSTALL_DEPS: "false" }),
      false,
    );
    assert.strictEqual(
      installChoice([], { CDXGEN_INSTALL_DEPS: "true" }),
      true,
    );
    assert.strictEqual(installChoice([], { CDXGEN_INSTALL_DEPS: "1" }), true);
    assert.strictEqual(
      installChoice([], { CDXGEN_INSTALL_DEPS: "  " }),
      undefined,
    );
    // The command line wins over the environment
    assert.strictEqual(
      installChoice(["--install-deps"], { CDXGEN_INSTALL_DEPS: "false" }),
      true,
    );
  });

  it("reads string options with or without =", () => {
    assert.strictEqual(
      operatorOptionChoice("profile", {
        argv: ["--profile", "introspect"],
        env: {},
      }),
      "introspect",
    );
    assert.strictEqual(
      operatorOptionChoice("profile", {
        argv: ["--profile=introspect"],
        env: {},
      }),
      "introspect",
    );
    assert.strictEqual(
      operatorOptionChoice("profile", {
        argv: ["--profile=appsec", "--profile", "introspect"],
        env: {},
      }),
      "introspect",
    );
    assert.strictEqual(
      operatorOptionChoice("profile", {
        argv: [],
        env: { CDXGEN_PROFILE: "introspect" },
      }),
      "introspect",
    );
  });

  it("returns undefined when the operator did not give the option", () => {
    assert.strictEqual(installChoice([], {}), undefined);
    assert.strictEqual(
      installChoice(["-t", "java", "--deep", "."], {}),
      undefined,
    );
    assert.strictEqual(
      operatorOptionChoice("profile", { argv: ["-t", "java"], env: {} }),
      undefined,
    );
    assert.strictEqual(
      operatorOptionChoice("introspect", {
        argv: ["--introspect-annotate"],
        env: {},
        boolean: true,
      }),
      undefined,
    );
  });
});

describe("applyOperatorToolingChoice", () => {
  it("turns installs off in secure mode unless the operator passed --install-deps", () => {
    // installDeps true here stands for a value taken from a config file
    const options = { installDeps: true };
    applyOperatorToolingChoice(options, {
      isSecureMode: true,
      argv: ["-t", "java"],
      env: {},
    });
    assert.strictEqual(options.installDeps, false);

    const fromEnv = { installDeps: true };
    applyOperatorToolingChoice(fromEnv, {
      isSecureMode: true,
      argv: [],
      env: { CDXGEN_INSTALL_DEPS: "true" },
    });
    assert.strictEqual(fromEnv.installDeps, true);
  });

  it("keeps installs on in secure mode for an explicit --install-deps", () => {
    const options = { installDeps: true };
    applyOperatorToolingChoice(options, {
      isSecureMode: true,
      argv: ["--install-deps"],
      env: {},
    });
    assert.strictEqual(options.installDeps, true);
  });

  it("leaves installs alone outside secure mode without an operator choice", () => {
    const options = { installDeps: true };
    applyOperatorToolingChoice(options, {
      isSecureMode: false,
      argv: [],
      env: {},
    });
    assert.strictEqual(options.installDeps, true);
  });

  it("makes an explicit --no-install-deps final after a profile turned installs on", () => {
    withFetchLicenseRestored(() => {
      const options = { profile: "ml" };
      applyAdvancedOptions(options, { isSecureMode: false });
      assert.strictEqual(options.installDeps, true);
      applyOperatorToolingChoice(options, {
        isSecureMode: false,
        argv: ["--profile", "ml", "--no-install-deps"],
        env: {},
      });
      assert.strictEqual(options.installDeps, false);
    });
    const fromEnv = { installDeps: true };
    applyOperatorToolingChoice(fromEnv, {
      isSecureMode: false,
      argv: [],
      env: { CDXGEN_INSTALL_DEPS: "false" },
    });
    assert.strictEqual(fromEnv.installDeps, false);
  });

  it("marks introspection that only the config file asked for", () => {
    const options = { introspect: true };
    applyOperatorToolingChoice(options, {
      isSecureMode: false,
      projectConfig: { introspect: true },
      argv: [],
      env: {},
    });
    assert.strictEqual(options.introspectFromConfigFile, true);

    const fromString = { introspect: true };
    applyOperatorToolingChoice(fromString, {
      isSecureMode: false,
      projectConfig: { introspect: "1" },
      argv: [],
      env: {},
    });
    assert.strictEqual(fromString.introspectFromConfigFile, true);
  });

  it("counts a config profile of introspect as config introspection", () => {
    const options = { introspect: true };
    applyOperatorToolingChoice(options, {
      isSecureMode: false,
      projectConfig: { profile: "introspect" },
      argv: [],
      env: {},
    });
    assert.strictEqual(options.introspectFromConfigFile, true);
  });

  it("does not mark introspection the operator asked for", () => {
    const operatorSources = [
      { argv: ["--introspect"], env: {} },
      { argv: ["--introspect=true"], env: {} },
      { argv: [], env: { CDXGEN_INTROSPECT: "true" } },
      { argv: ["--profile", "introspect"], env: {} },
      { argv: ["--profile=introspect"], env: {} },
      { argv: [], env: { CDXGEN_PROFILE: "introspect" } },
    ];
    for (const projectConfig of [
      { introspect: true },
      { profile: "introspect" },
    ]) {
      for (const { argv, env } of operatorSources) {
        const options = { introspect: true };
        applyOperatorToolingChoice(options, {
          isSecureMode: false,
          projectConfig,
          argv,
          env,
        });
        assert.strictEqual(
          options.introspectFromConfigFile,
          undefined,
          `config ${JSON.stringify(projectConfig)} with argv ${JSON.stringify(argv)} env ${JSON.stringify(env)}`,
        );
      }
    }
  });

  it("does not mark anything when introspection is off or the config does not ask for it", () => {
    const off = { introspect: false };
    applyOperatorToolingChoice(off, {
      isSecureMode: false,
      projectConfig: { introspect: true },
      argv: [],
      env: {},
    });
    assert.strictEqual(off.introspectFromConfigFile, undefined);

    const noConfig = { introspect: true };
    applyOperatorToolingChoice(noConfig, {
      isSecureMode: false,
      argv: [],
      env: {},
    });
    assert.strictEqual(noConfig.introspectFromConfigFile, undefined);

    const otherProfile = { introspect: true };
    applyOperatorToolingChoice(otherProfile, {
      isSecureMode: false,
      projectConfig: { profile: "appsec", introspect: false },
      argv: [],
      env: {},
    });
    assert.strictEqual(otherProfile.introspectFromConfigFile, undefined);
  });
});

describe("applyAdvancedOptions keeps disabled installs disabled", () => {
  it("ml profiles do not turn installs back on", () => {
    for (const profile of [
      "ml",
      "machine-learning",
      "ml-deep",
      "deep-learning",
    ]) {
      withFetchLicenseRestored(() => {
        const options = { profile, installDeps: false };
        applyAdvancedOptions(options, { isSecureMode: false });
        assert.strictEqual(options.installDeps, false, profile);
        assert.strictEqual(options.deep, true, profile);
      });
    }
  });

  it("ml profiles still turn installs on when they were not disabled", () => {
    for (const profile of [
      "ml",
      "machine-learning",
      "ml-deep",
      "deep-learning",
    ]) {
      withFetchLicenseRestored(() => {
        const options = { profile, installDeps: true };
        applyAdvancedOptions(options, { isSecureMode: false });
        assert.strictEqual(options.installDeps, true, profile);
        const secure = { profile, installDeps: true };
        applyAdvancedOptions(secure, { isSecureMode: true });
        assert.strictEqual(secure.installDeps, false, `${profile} secure`);
      });
    }
  });

  it("lifecycle 'post-build' keeps a disabled install disabled", () => {
    const options = {
      profile: "generic",
      lifecycle: "post-build",
      projectType: ["java"],
      installDeps: false,
    };
    applyAdvancedOptions(options, { isSecureMode: false });
    assert.strictEqual(options.installDeps, false);
  });
});

describe("dropConfigAuditOverrides", () => {
  const makeConfig = () => ({
    profile: "ml-tiny",
    "bom-audit-categories": "license",
    bomAuditMinSeverity: "high",
    "project-name": "demo",
  });

  it("keeps the config file away from an audit the operator asked for", () => {
    for (const context of [
      { argv: ["--bom-audit"], env: {} },
      { argv: [], env: { CDXGEN_BOM_AUDIT: "true" } },
    ]) {
      const config = makeConfig();
      assert.deepStrictEqual(dropConfigAuditOverrides(config, context).sort(), [
        "bom-audit-categories",
        "bomAuditMinSeverity",
        "profile",
      ]);
      assert.deepStrictEqual(config, { "project-name": "demo" });
    }
  });

  it("leaves the config file alone when the operator did not ask for the audit", () => {
    for (const context of [
      { argv: [], env: {} },
      { argv: ["--no-bom-audit"], env: {} },
    ]) {
      const config = makeConfig();
      assert.deepStrictEqual(dropConfigAuditOverrides(config, context), []);
      assert.deepStrictEqual(config, makeConfig());
    }
  });
});

describe("profiles and techniques from a config file", () => {
  it("tells a config file selection from the operator's", () => {
    const config = {
      profile: "operational",
      technique: ["source-code-analysis"],
    };
    assert.deepStrictEqual(
      configFileSelections(config, { argv: [], env: {} }),
      {
        profileFromConfigFile: true,
        techniqueFromConfigFile: true,
      },
    );
    assert.deepStrictEqual(
      configFileSelections(config, {
        argv: ["--profile", "operational"],
        env: { CDXGEN_TECHNIQUE: "source-code-analysis" },
      }),
      { profileFromConfigFile: false, techniqueFromConfigFile: false },
    );
    assert.deepStrictEqual(configFileSelections({}, { argv: [], env: {} }), {
      profileFromConfigFile: false,
      techniqueFromConfigFile: false,
    });
  });

  it("does not let a config file profile add the os project type", () => {
    const absent = { profile: "operational" };
    const warnings = applyAdvancedOptions(absent, {
      isSecureMode: false,
      profileFromConfigFile: true,
    });
    assert.strictEqual(absent.projectType, undefined);
    assert.strictEqual(absent.bomAudit, true);
    assert.ok(warnings.some((w) => w.message.includes("operational profile")));
    const mixed = { profile: "operational", projectType: ["js"] };
    applyAdvancedOptions(mixed, {
      isSecureMode: false,
      profileFromConfigFile: true,
    });
    assert.deepStrictEqual(mixed.projectType, ["js"]);
  });

  it("does not let a config file profile or technique turn on evidence", () => {
    for (const profile of [
      "research",
      "threat-modeling",
      "introspect",
      "ml-deep",
      "deep-learning",
    ]) {
      const options = { profile };
      applyAdvancedOptions(options, {
        isSecureMode: false,
        profileFromConfigFile: true,
      });
      assert.strictEqual(options.evidence, false, profile);
      const operator = { profile };
      applyAdvancedOptions(operator, { isSecureMode: false });
      assert.strictEqual(operator.evidence, true, profile);
    }
    const technique = { technique: ["source-code-analysis"] };
    applyAdvancedOptions(technique, {
      isSecureMode: false,
      techniqueFromConfigFile: true,
    });
    assert.strictEqual(technique.deep, true);
    assert.strictEqual(technique.evidence, false);
  });

  it("keeps evidence the operator asked for under a config file profile", () => {
    const options = { profile: "research", evidence: true };
    applyAdvancedOptions(options, {
      isSecureMode: false,
      profileFromConfigFile: true,
    });
    assert.strictEqual(options.evidence, true);
  });

  it("applies the rule through buildOptionsFromArgs", () => {
    const { options } = buildOptionsFromArgs(
      { type: undefined, profile: "operational", specVersion: 1.7 },
      {
        invokedCommandName: "cdxgen",
        filePath: "/tmp/project",
        isRemoteOrPurl: false,
        userSetSpecVersion: false,
        isSecureMode: false,
        projectConfig: { profile: "operational" },
        argv: [],
        env: {},
      },
    );
    assert.ok(!options.projectType?.includes("os"));
  });
});

describe("markConfigFileTeaTargets", () => {
  const tei = "urn:tei:uuid:example.com:d4d9f54a-abcf-11ee-ac79-1a52914d44b1";

  it("marks TEA targets that only the config file names", () => {
    const options = { teaFetch: tei, teaPublish: "https://tea.example.com" };
    assert.deepStrictEqual(
      markConfigFileTeaTargets(options, {
        projectConfig: { "tea-fetch": tei, teaPublish: options.teaPublish },
        argv: [],
        env: {},
      }),
      ["tea-fetch", "tea-publish"],
    );
    assert.strictEqual(options.teaFetchFromConfigFile, true);
    assert.strictEqual(options.teaPublishFromConfigFile, true);
  });

  it("leaves TEA targets the operator passed alone", () => {
    const options = { teaFetch: tei, teaPublish: "https://tea.example.com" };
    assert.deepStrictEqual(
      markConfigFileTeaTargets(options, {
        projectConfig: { "tea-fetch": "urn:other", "tea-publish": "x" },
        argv: ["--tea-fetch", tei],
        env: { CDXGEN_TEA_PUBLISH: "https://tea.example.com" },
      }),
      [],
    );
    assert.strictEqual(options.teaFetchFromConfigFile, undefined);
    assert.strictEqual(options.teaPublishFromConfigFile, undefined);
    assert.deepStrictEqual(
      markConfigFileTeaTargets({ teaFetch: tei }, { argv: [], env: {} }),
      [],
    );
  });
});

describe("findInTreeSlicesFiles", () => {
  it("finds slices files the scanned tree already holds in secure mode", () => {
    const root = mkdtempSync(join(tmpdir(), "cdxgen-slices-test-"));
    try {
      const project = join(root, "project");
      const elsewhere = join(root, "cache");
      mkdirSync(project);
      mkdirSync(elsewhere);
      writeFileSync(join(project, "deps.slices.json"), "{}");
      writeFileSync(join(project, "usages.json"), "{}");
      writeFileSync(join(elsewhere, "reachables.json"), "{}");
      const options = {
        depsSlicesFile: "deps.slices.json",
        usagesSlicesFile: join(project, "usages.json"),
        reachablesSlicesFile: join(elsewhere, "reachables.json"),
        semanticsSlicesFile: "semantics.slices.json",
      };
      const found = findInTreeSlicesFiles(options, {
        scanPath: project,
        cwd: root,
        isSecureMode: true,
      });
      assert.deepStrictEqual(
        found.map((entry) => entry.option),
        ["depsSlicesFile", "usagesSlicesFile"],
      );
      assert.strictEqual(found[0].path, join(project, "deps.slices.json"));
      assert.deepStrictEqual(
        findInTreeSlicesFiles(options, {
          scanPath: project,
          cwd: root,
          isSecureMode: false,
        }),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
