import assert from "node:assert";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { test } from "poku";

import {
  collectPolicyViolations,
  enhanceBom,
  enhanceComponentLicenses,
  normalizeLicense,
  resolveLicenseId,
  upgradeDeprecated,
} from "./licenseEnhancer.js";

test("licenseEnhancer resolveLicenseId", () => {
  // Simple ID resolution
  assert.deepStrictEqual(resolveLicenseId("mit"), {
    id: "MIT",
    url: "https://opensource.org/licenses/MIT",
  });
  assert.deepStrictEqual(resolveLicenseId("apache-2.0"), {
    id: "Apache-2.0",
    url: "https://opensource.org/licenses/Apache-2.0",
  });

  // Deprecated ID resolution
  assert.deepStrictEqual(resolveLicenseId("GPL-3.0"), {
    id: "GPL-3.0-only",
    url: "https://opensource.org/licenses/GPL-3.0-only",
  });
  assert.deepStrictEqual(resolveLicenseId("GPL-3.0+"), {
    id: "GPL-3.0-or-later",
    url: "https://opensource.org/licenses/GPL-3.0-or-later",
  });

  // Custom LicenseRef resolution (if licenseRef is true).
  // LicenseRef ids are not valid SPDX ids, so they must be emitted as an
  // `expression`, never in the `id` field (would fail CycloneDX validation).
  assert.deepStrictEqual(
    resolveLicenseId("My custom non-existent license", { licenseRef: true }),
    {
      expression: "LicenseRef-cdxgen-my-custom-non-existent-license",
    },
  );
  assert.strictEqual(
    resolveLicenseId("My custom non-existent license", { licenseRef: false }),
    null,
  );

  // A non-SPDX license from the bundled database resolves to a LicenseRef-*
  // identifier. Without --license-ref it must be left unresolved (null) so the
  // original name is preserved; with it, emitted as an expression (not id).
  assert.strictEqual(resolveLicenseId("Commons Clause"), null);
  assert.deepStrictEqual(
    resolveLicenseId("Commons Clause", { licenseRef: true }),
    { expression: "LicenseRef-scancode-commons-clause" },
  );
});

test("licenseEnhancer upgradeDeprecated", () => {
  assert.strictEqual(upgradeDeprecated("GPL-3.0"), "GPL-3.0-only");
  assert.strictEqual(upgradeDeprecated("GPL-3.0+"), "GPL-3.0-or-later");
  // replaced_by deprecation rule from the bundled database
  assert.strictEqual(upgradeDeprecated("aladdin-md5"), "Zlib");
});

test("licenseEnhancer normalizeLicense", () => {
  // String input
  assert.deepStrictEqual(normalizeLicense("mit"), {
    id: "MIT",
    url: "https://opensource.org/licenses/MIT",
  });

  // Object input with id
  assert.deepStrictEqual(normalizeLicense({ id: "mit" }), {
    id: "MIT",
    url: "https://opensource.org/licenses/MIT",
  });

  // Object input with name
  assert.deepStrictEqual(normalizeLicense({ name: "mit" }), {
    id: "MIT",
    url: "https://opensource.org/licenses/MIT",
  });

  // Object input with expression
  assert.deepStrictEqual(
    normalizeLicense({ expression: "mit or apache-2.0" }),
    {
      expression: "MIT OR Apache-2.0",
    },
  );

  // A non-SPDX named license must be preserved as-is by default (never coerced
  // into an invalid {id:"LicenseRef-..."}).
  assert.deepStrictEqual(normalizeLicense({ name: "Commons Clause" }), {
    name: "Commons Clause",
  });

  // With licenseRef enabled it becomes a valid expression, not an id.
  assert.deepStrictEqual(
    normalizeLicense({ name: "Commons Clause" }, { licenseRef: true }),
    { expression: "LicenseRef-scancode-commons-clause" },
  );

  // Idempotency: enhancing an already-normalized license is stable.
  const once = normalizeLicense("Apache 2.0");
  assert.deepStrictEqual(normalizeLicense(once), once);

  // An expression nested inside a `license` wrapper must be hoisted to the
  // license-choice level ({ expression }), never left as { license: { expression } }
  // which is invalid per the CycloneDX schema.
  assert.deepStrictEqual(
    normalizeLicense({
      license: { name: "GPL-2.0-or-later OR Classpath-exception-2.0" },
    }),
    { expression: "GPL-2.0-or-later OR Classpath-exception-2.0" },
  );
  assert.deepStrictEqual(
    normalizeLicense({ license: { expression: "mit or apache-2.0" } }),
    { expression: "MIT OR Apache-2.0" },
  );
  // acknowledgement is preserved when hoisting.
  assert.deepStrictEqual(
    normalizeLicense({
      license: { expression: "MIT OR Apache-2.0" },
      acknowledgement: "declared",
    }),
    { expression: "MIT OR Apache-2.0", acknowledgement: "declared" },
  );
});

test("licenseEnhancer enhanceComponentLicenses", () => {
  const component = {
    name: "test-pkg",
    licenses: [
      { id: "mit" },
      { name: "Apache 2.0" },
      "MIT", // Duplicate
    ],
  };

  enhanceComponentLicenses(component);
  assert.deepStrictEqual(component.licenses, [
    { id: "MIT", url: "https://opensource.org/licenses/MIT" },
    { id: "Apache-2.0", url: "https://opensource.org/licenses/Apache-2.0" },
  ]);
});

test("licenseEnhancer license-choice collapse is spec-version aware", () => {
  // A license object alongside an expression is invalid pre-1.7 (must be a
  // single SPDX-expression tuple) but valid in 1.7 (mixed list permitted).
  const mkComponent = () => ({
    name: "dep",
    purl: "pkg:maven/x/y@1",
    licenses: [
      { license: { id: "Apache-2.0" } },
      { license: { name: "mit or isc" } },
    ],
  });

  // Pre-1.7: collapse into a single combined expression.
  const pre = { components: [mkComponent()] };
  enhanceBom(pre, { specVersion: 1.6 });
  assert.deepStrictEqual(pre.components[0].licenses, [
    { expression: "Apache-2.0 AND (MIT OR ISC)" },
  ]);

  // 1.7: keep the mixed list (license object + hoisted expression).
  const v17 = { components: [mkComponent()] };
  enhanceBom(v17, { specVersion: 1.7 });
  assert.deepStrictEqual(v17.components[0].licenses, [
    {
      license: {
        id: "Apache-2.0",
        url: "https://opensource.org/licenses/Apache-2.0",
      },
    },
    { expression: "MIT OR ISC" },
  ]);
});

test("licenseEnhancer enrichLicenseMetadata and policy", () => {
  // Create a temporary policy file
  const policyFile = join(process.cwd(), "temp-policy.yaml");
  writeFileSync(
    policyFile,
    `
license_policies:
  - license_key: MIT
    label: Approved
  - category: Copyleft
    label: Prohibited
`,
  );

  try {
    const opts = {
      licenseEnrich: true,
      licensePolicy: policyFile,
    };

    // Test permissive license enrichment
    const lic1 = { id: "MIT" };
    const bom = {
      components: [
        {
          name: "pkg1",
          licenses: [lic1],
        },
      ],
    };

    enhanceBom(bom, opts);

    const enrichedLic1 =
      bom.components[0].licenses[0].license || bom.components[0].licenses[0];
    assert.ok(enrichedLic1.properties);

    const category = enrichedLic1.properties.find(
      (p) => p.name === "cdx:license:category",
    );
    assert.strictEqual(category.value, "Permissive");

    const alert = enrichedLic1.properties.find(
      (p) => p.name === "cdx:license:complianceAlert",
    );
    assert.strictEqual(alert.value, "pass");

    // Component level properties validation
    const comp1 = bom.components[0];
    const compAlert = comp1.properties.find(
      (p) => p.name === "cdx:license:complianceAlert",
    );
    assert.strictEqual(compAlert.value, "pass");
  } finally {
    try {
      unlinkSync(policyFile);
    } catch (_e) {
      // ignore
    }
  }
});

test("licenseEnhancer collectPolicyViolations", () => {
  const policy = {
    license_policies: [
      { license_key: "GPL-3.0-only", label: "prohibited" },
      { license_key: "BSD-2-Clause", label: "warning" },
      { category: "Copyleft", label: "prohibited" },
    ],
  };
  const bom = {
    metadata: {
      component: {
        name: "root",
        purl: "pkg:npm/root@1.0.0",
        version: "1.0.0",
        licenses: [{ license: { id: "MIT" } }],
      },
    },
    components: [
      {
        name: "gpllib",
        purl: "pkg:npm/gpllib@1.0.0",
        version: "1.0.0",
        licenses: [{ license: { id: "GPL-3.0-only" } }],
      },
      {
        name: "bsdlib",
        purl: "pkg:npm/bsdlib@2.0.0",
        version: "2.0.0",
        licenses: [{ license: { id: "BSD-2-Clause" } }],
      },
      {
        name: "exprlib",
        purl: "pkg:npm/exprlib@3.0.0",
        version: "3.0.0",
        // Operand match inside an expression should be detected.
        licenses: [{ expression: "MIT OR GPL-3.0-only" }],
      },
      {
        name: "permissive",
        purl: "pkg:npm/permissive@1.0.0",
        licenses: [{ license: { id: "MIT" } }],
      },
    ],
  };

  // Default: prohibited only (no warnings).
  const errorsOnly = collectPolicyViolations(bom, policy);
  assert.deepStrictEqual(errorsOnly.map((v) => v.ref).sort(), [
    "pkg:npm/exprlib@3.0.0",
    "pkg:npm/gpllib@1.0.0",
  ]);
  assert.ok(errorsOnly.every((v) => v.alert === "error"));

  // With warnings included.
  const withWarnings = collectPolicyViolations(bom, policy, {
    includeWarnings: true,
  });
  const bsd = withWarnings.find((v) => v.ref === "pkg:npm/bsdlib@2.0.0");
  assert.strictEqual(bsd.alert, "warning");
  assert.strictEqual(bsd.license, "BSD-2-Clause");
  // The permissive MIT component is never flagged.
  assert.ok(!withWarnings.some((v) => v.ref === "pkg:npm/permissive@1.0.0"));

  // No policy / no bom => no violations.
  assert.deepStrictEqual(collectPolicyViolations(bom, null), []);
  assert.deepStrictEqual(collectPolicyViolations(null, policy), []);
});
