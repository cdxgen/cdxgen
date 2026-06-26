import { assert, describe, it } from "poku";

import {
  applyAdvancedOptions,
  applyCommandNameDefaults,
  applyPostConstructionOverrides,
  buildInitialOptions,
  buildOptionsFromArgs,
  isUserProvided,
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
  it("profile 'ml-tiny' disables deep, evidence, crypto, installDeps, bomAudit", () => {
    const options = { profile: "ml-tiny", deep: true, evidence: true };
    applyAdvancedOptions(options);
    assert.strictEqual(options.deep, false);
    assert.strictEqual(options.evidence, false);
    assert.strictEqual(options.includeCrypto, false);
    assert.strictEqual(options.installDeps, false);
    assert.strictEqual(options.bomAudit, false);
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
