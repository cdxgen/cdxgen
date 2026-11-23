import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { assert, it } from "poku";

import { createNodejsBom } from "./jsBom.js";

// The fixture's virtual store holds one entry per way pnpm has of naming an
// installed copy: plain, peer-suffixed, cut and suffixed with a sha256 (pnpm
// 10 and later), cut and suffixed with a base32 md5 (pnpm 6 through 9), cut
// under a cap pnpm does not default to, and an uppercase name, which every
// pnpm cuts and hashes because two casings collide on a case-insensitive
// filesystem. The lock file keys name the peer resolutions, and the metadata
// pass must reach every manifest through them or through the cut names.

const fixtureDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "test",
  "data",
  "js-pnpm-peer-store-repotest",
);

const scanFixture = (options) =>
  createNodejsBom(fixtureDir, {
    installDeps: false,
    multiProject: false,
    specVersion: 1.7,
    ...options,
  });

const findComponent = (bomJson, name) =>
  (bomJson?.components || []).find((comp) => comp.name === name);

await it("describes pnpm packages stored under peer resolutions and cut names", async () => {
  const { bomJson } = await scanFixture();
  const expected = new Map([
    ["ajv", "Another JSON Schema Validator"],
    [
      "typescript",
      "TypeScript is a language for application scale JavaScript development",
    ],
    ["ajv-keywords", "Additional JSON-Schema keywords for Ajv"],
    ["parser", "An ESLint custom parser which leverages TypeScript ESTree"],
    [
      "typescript-estree",
      "A parser that converts TypeScript source into an ESTree-compatible form",
    ],
    ["schema-utils", "Schema validation helpers"],
    ["JSONSteam", "Streaming JSON parser"],
  ]);
  for (const [name, description] of expected) {
    const component = findComponent(bomJson, name);
    assert.ok(component, `expected the ${name} dependency`);
    assert.deepStrictEqual(
      component.description,
      description,
      `${name} must be described from its installed manifest`,
    );
  }
  const licenseId = (component) => component?.licenses?.[0]?.license?.id;
  assert.deepStrictEqual(
    licenseId(findComponent(bomJson, "parser")),
    "BSD-2-Clause",
  );
  assert.deepStrictEqual(
    licenseId(findComponent(bomJson, "typescript-estree")),
    "BSD-2-Clause",
  );
  assert.deepStrictEqual(licenseId(findComponent(bomJson, "JSONSteam")), "MIT");
  assert.deepStrictEqual(
    licenseId(findComponent(bomJson, "schema-utils")),
    "MIT",
  );
});
