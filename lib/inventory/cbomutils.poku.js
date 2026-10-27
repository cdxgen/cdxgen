import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import esmock from "esmock";
import { assert, describe, it } from "poku";

import {
  collectOSCryptoLibs,
  collectSourceCryptoComponents,
  findCryptoAlgos,
} from "./cbomutils.js";

describe("cbom utils", () => {
  it("collectOSCryptoLibs() returns a result set", () => {
    const noopOsQuery = () => undefined;
    const cryptoLibs = collectOSCryptoLibs({}, noopOsQuery);
    assert.ok(cryptoLibs);
  });

  it("collectOSCryptoLibs() degrades instead of throwing when no executor is injected", () => {
    // postgen receives `executeOsQuery` by injection from a layer above it. A
    // caller that omits it used to reach `executeOsQueryFn(...)` and abort
    // post-processing with a TypeError mid-SBOM.
    for (const missing of [undefined, null, {}]) {
      assert.deepStrictEqual(collectOSCryptoLibs({}, missing), []);
    }
  });

  it("collectOSCryptoLibs() lists the crypto libraries pacman, Linuxbrew and MacPorts installed", async () => {
    const { collectOSCryptoLibs: collect } = await esmock(
      "./cbomutils.js",
      {},
      {
        "./osinfo.js": {
          getDistroInfo: () => ({
            purlType: "alpm",
            namespace: "arch",
            distroId: "arch-20261018.0.612668",
            distroName: "",
          }),
        },
      },
    );
    // What osquery 5.24.0 returns for each crypto library query on a host
    // that has the three package managers.
    const rowsByTable = {
      pacman_packages: [
        {
          arch: "x86_64",
          licenses: "Apache-2.0",
          name: "openssl",
          source: "openssl",
          url: "https://www.openssl.org",
          version: "3.6.5-1",
        },
      ],
      homebrew_packages: [
        {
          name: "openssl@3",
          path: "/home/linuxbrew/.linuxbrew/Cellar/openssl@3",
          type: "formula",
          version: "3.6.0",
        },
      ],
      macports_packages: [
        { name: "openssl3", version: "3.6.0", revision: "0", arch: "arm64" },
      ],
    };
    const executor = (query) =>
      Object.entries(rowsByTable).find(([table]) =>
        query.toLowerCase().includes(`from ${table} `),
      )?.[1];
    const cryptoLibs = collect({}, executor);
    assert.deepStrictEqual(
      cryptoLibs.map((component) => [component.purl, component.type]),
      [
        ["pkg:alpm/arch/openssl@3.6.5-1?arch=x86_64", "library"],
        ["pkg:brew/openssl%403@3.6.0", "library"],
        ["pkg:macports/openssl3@3.6.0_0", "library"],
      ],
    );
  });

  it("collectSourceCryptoComponents() extracts algorithms from JS source", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-source-"));
    try {
      writeFileSync(
        join(projectDir, "index.js"),
        [
          "import { createHash, webcrypto } from 'node:crypto';",
          "import jwt from 'jsonwebtoken';",
          "const subtle = webcrypto.subtle;",
          "const digest = 'sha256';",
          "const signingAlgorithm = 'Ed25519';",
          "const profile = { name: 'AES-GCM', length: 256 };",
          "createHash(digest);",
          "subtle.generateKey(profile, true, ['encrypt']);",
          "jwt.sign({ sub: '123' }, 'secret', { algorithm: 'RS256' });",
        ].join("\n"),
        "utf-8",
      );
      const components = await collectSourceCryptoComponents(projectDir, {
        deep: false,
        evidence: true,
        specVersion: 1.7,
      });
      const names = components.map((component) => component.name);
      const sha256Component = components.find(
        (component) => component.name === "sha-256",
      );
      assert.ok(names.includes("sha-256"));
      assert.ok(names.includes("aes256-GCM"));
      assert.ok(names.includes("Ed25519"));
      assert.ok(names.includes("sha256WithRSAEncryption"));
      assert.ok(!names.includes("hmac"));
      assert.ok(sha256Component);
      assert.ok(Array.isArray(sha256Component.evidence.identity));
      assert.strictEqual(sha256Component.evidence.identity[0].field, "name");
      assert.strictEqual(
        sha256Component.evidence.identity[0].concludedValue,
        "sha-256",
      );
      assert.ok(
        sha256Component.evidence.identity[0].methods.some(
          (method) => method.technique === "source-code-analysis",
        ),
      );
      assert.ok(
        sha256Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "index.js" && occurrence.line === 7,
        ),
      );
      const sha256Occurrence = sha256Component.evidence.occurrences.find(
        (occurrence) =>
          occurrence.location === "index.js" && occurrence.line === 7,
      );
      assert.ok(sha256Occurrence);
      assert.strictEqual(sha256Occurrence.additionalContext, "hash");
      assert.strictEqual(sha256Occurrence.symbol, "node:crypto.createHash");
      assert.ok(!Object.hasOwn(sha256Occurrence, "offset"));
      assert.ok(
        components.every(
          (component) => component.cryptoProperties?.oid?.length,
        ),
      );
      assert.ok(
        components.some((component) =>
          component.properties.some(
            (property) =>
              property.name === "cdx:crypto:sourceType" &&
              property.value.startsWith("js-ast:"),
          ),
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("collectSourceCryptoComponents() keeps branch-derived evidence for dynamic crypto values", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "cdxgen-cbom-branches-"));
    try {
      writeFileSync(
        join(projectDir, "dynamic-branches.mjs"),
        [
          "import crypto, { createHash, webcrypto } from 'node:crypto';",
          "import jwt from 'jsonwebtoken';",
          "const subtle = webcrypto.subtle;",
          "const digestName = process.env.CDXGEN_TEST_DIGEST || 'sha384';",
          "const keyProfiles = globalThis.__legacyCipher",
          "  ? { active: { name: 'AES-CBC', length: 256 } }",
          "  : { active: { name: 'AES-GCM', length: 256 } };",
          "const signingAlgorithm = globalThis.__legacySignature ? 'RS256' : 'RS512';",
          "const jwtOptions = globalThis.__jwtOptions ?? { algorithm: signingAlgorithm };",
          "createHash(digestName);",
          "await subtle.generateKey(keyProfiles.active, true, ['encrypt', 'decrypt']);",
          "jwt.sign({ sub: '123' }, 'secret', jwtOptions);",
          "export function signPayload(payload, privateKey, alg) {",
          "  let hashAlg = null;",
          "  if (alg === 'RS256' || alg === 'RS512') {",
          "    hashAlg = alg.replace('RS', 'SHA');",
          "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "  if (alg !== 'RS384') {",
          "    return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  } else {",
          "    hashAlg = alg.replace('RS', 'SHA');",
          "    return crypto.sign(hashAlg, Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
          "export function signPayloadWithSwitch(payload, privateKey, alg) {",
          "  switch (alg) {",
          "    case 'RS256':",
          "    case 'RS512':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    case 'RS384':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    default:",
          "      return crypto.sign('SHA-224', Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
          "export function signPayloadWithSwitchDefault(payload, privateKey) {",
          "  const alg = globalThis.__preferLegacy ? 'RS256' : 'RS384';",
          "  switch (alg) {",
          "    case 'RS256':",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "    default:",
          "      return crypto.sign(alg.replace('RS', 'SHA'), Buffer.from(payload, 'utf8'), { key: privateKey });",
          "  }",
          "}",
        ].join("\n"),
        "utf-8",
      );
      const components = await collectSourceCryptoComponents(projectDir, {
        deep: false,
        evidence: true,
        specVersion: 1.7,
      });
      const names = components.map((component) => component.name);
      const sha384Component = components.find(
        (component) => component.name === "sha-384",
      );

      assert.ok(names.includes("sha-384"));
      assert.ok(names.includes("sha-224"));
      assert.ok(names.includes("sha-256"));
      assert.ok(names.includes("sha-512"));
      assert.ok(names.includes("aes256-CBC"));
      assert.ok(names.includes("aes256-GCM"));
      assert.ok(names.includes("sha256WithRSAEncryption"));
      assert.ok(names.includes("sha512WithRSAEncryption"));
      assert.ok(sha384Component);
      assert.ok(
        sha384Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "dynamic-branches.mjs" &&
            occurrence.line === 10 &&
            occurrence.symbol === "node:crypto.createHash" &&
            occurrence.additionalContext === "hash",
        ),
      );
      assert.ok(
        sha384Component.properties.some(
          (property) =>
            property.name === "cdx:crypto:sourceLocation" &&
            property.value === "dynamic-branches.mjs:10:0",
        ),
      );
      assert.ok(
        sha384Component.properties.some(
          (property) =>
            property.name === "cdx:crypto:sourceType" &&
            property.value === "js-ast:node:crypto.sign",
        ),
      );
      assert.ok(
        sha384Component.evidence.occurrences.some(
          (occurrence) =>
            occurrence.location === "dynamic-branches.mjs" &&
            occurrence.symbol === "node:crypto.sign" &&
            occurrence.additionalContext === "signature",
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-256" &&
            component.properties.some(
              (property) =>
                property.name === "cdx:crypto:sourceType" &&
                property.value === "js-ast:node:crypto.sign",
            ) &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature",
            ),
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-512" &&
            component.properties.some(
              (property) =>
                property.name === "cdx:crypto:sourceType" &&
                property.value === "js-ast:node:crypto.sign",
            ) &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.line === 30 &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature",
            ),
        ),
      );
      assert.ok(
        components.some(
          (component) =>
            component.name === "sha-384" &&
            component.evidence.occurrences.some(
              (occurrence) =>
                occurrence.location === "dynamic-branches.mjs" &&
                occurrence.symbol === "node:crypto.sign" &&
                occurrence.additionalContext === "signature" &&
                occurrence.line > 30,
            ),
        ),
      );
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("collectDosaiCryptoComponents() maps dosai algorithms to CBOM components with OIDs", async () => {
    const analyzeDosaiCrypto = () => ({
      Assets: [
        {
          Id: "cas1",
          AssetType: "algorithm",
          Name: "SHA-256",
          Family: "hash",
          Strength: "strong",
          Location: {
            Path: "Program.cs",
            FileName: "Program.cs",
            LineNumber: 12,
            ColumnNumber: 9,
          },
          ReachableFromEntryPoint: true,
          EntryPointIds: ["ep1"],
        },
        {
          Id: "cas2",
          AssetType: "algorithm",
          Name: "UnknownCipher",
          Location: {
            Path: "Program.cs",
            FileName: "Program.cs",
            LineNumber: 20,
            ColumnNumber: 9,
          },
        },
      ],
      Operations: [
        {
          Id: "cop1",
          OperationType: "hash",
          Algorithm: "SHA-256",
          Location: {
            Path: "Program.cs",
            FileName: "Program.cs",
            LineNumber: 12,
            ColumnNumber: 9,
          },
        },
        {
          Id: "cop2",
          OperationType: "use",
          Algorithm: "SHA-2",
          Symbol: "SHA256.HashData",
          Location: {
            Path: "Program.vb",
            FileName: "Program.vb",
            LineNumber: 42,
            ColumnNumber: 22,
          },
        },
      ],
    });
    const { collectDosaiCryptoComponents } = await esmock("./cbomutils.js", {
      "./dosai.js": { analyzeDosaiCrypto },
    });

    const components = await collectDosaiCryptoComponents("/tmp/project", {
      evidence: true,
      specVersion: 1.7,
    });

    assert.strictEqual(components.length, 1);
    assert.strictEqual(components[0].name, "sha-256");
    assert.strictEqual(components[0].type, "cryptographic-asset");
    assert.strictEqual(components[0].cryptoProperties.assetType, "algorithm");
    assert.ok(components[0].cryptoProperties.oid);
    assert.ok(
      components[0].properties.some(
        (property) =>
          property.name === "cdx:crypto:sourceType" &&
          property.value === "dosai:operation",
      ),
    );
    assert.ok(
      !components[0].properties.some(
        (property) =>
          property.name === "cdx:crypto:sourceType" &&
          ["dosai", "js-ast:dosai"].includes(property.value),
      ),
    );
    assert.ok(
      components[0].evidence.occurrences.some(
        (occurrence) =>
          occurrence.location === "Program.cs" && occurrence.line === 12,
      ),
    );
    assert.ok(
      components[0].evidence.occurrences.some(
        (occurrence) =>
          occurrence.location === "Program.vb" && occurrence.line === 42,
      ),
    );
  });

  it("collectDosaiCryptoComponents() maps dosai 5.0.0 .NET 11 crypto assets to CBOM components", async () => {
    const analyzeDosaiCrypto = () => ({
      Assets: [
        {
          Id: "cas-pq-sign",
          AssetType: "algorithm",
          Name: "ML-DSA",
          Family: "signature",
          Strength: "strong",
          Standard: "FIPS 204",
          Location: { Path: "Program.cs", LineNumber: 55, ColumnNumber: 23 },
        },
        {
          Id: "cas-x25519",
          AssetType: "algorithm",
          Name: "X25519",
          Family: "key-agreement",
          Strength: "strong",
          Standard: "RFC 7748",
          Location: { Path: "Program.cs", LineNumber: 62, ColumnNumber: 19 },
        },
        {
          Id: "cas-csprng",
          AssetType: "algorithm",
          Name: "CSPRNG",
          Family: "random",
          Strength: "strong",
          Location: { Path: "Program.cs", LineNumber: 60, ColumnNumber: 26 },
        },
      ],
      Operations: [
        {
          Id: "cop-pq-sign",
          OperationType: "sign",
          Algorithm: "ML-DSA",
          Symbol: "MLDsa",
          Code: "using var mldsa = MLDsa.GenerateKey(MLDsaAlgorithm.MLDsa65);",
          Location: { Path: "Program.cs", LineNumber: 55, ColumnNumber: 23 },
        },
        {
          Id: "cop-slh-dsa",
          OperationType: "sign",
          Algorithm: "SLH-DSA",
          Symbol: "SlhDsa",
          Code: "using var slh = SlhDsa.GenerateKey(SlhDsaAlgorithm.SlhDsaSha2_128s);",
          Location: { Path: "Program.cs", LineNumber: 63, ColumnNumber: 21 },
        },
        {
          Id: "cop-ml-kem",
          OperationType: "key-encapsulate",
          Algorithm: "ML-KEM",
          Symbol: "MLKem",
          Code: "using var kem = MLKem.GenerateKey(MLKemAlgorithm.MLKem768);",
          Location: { Path: "Program.cs", LineNumber: 64, ColumnNumber: 19 },
        },
      ],
    });
    const { collectDosaiCryptoComponents } = await esmock("./cbomutils.js", {
      "./dosai.js": { analyzeDosaiCrypto },
    });

    const components = await collectDosaiCryptoComponents("/tmp/project", {
      evidence: true,
      specVersion: 1.7,
    });

    const byName = new Map(components.map((c) => [c.name, c]));
    // CSPRNG and the generic AES Key Wrap family have no single OID and are
    // skipped; the generic ML-DSA asset has no parameter set of its own and
    // only the operation with a resolvable call-site context maps.
    assert.strictEqual(
      components.length,
      4,
      "unmapped families (CSPRNG, AES Key Wrap) must be skipped",
    );
    assert.ok(!byName.has("CSPRNG"));
    assert.ok(
      !byName.has("aes-key-wrap"),
      "AES Key Wrap must not reuse the 128-bit wrap OID",
    );
    const mlDsa = byName.get("ml-dsa-65");
    assert.ok(mlDsa, "ML-DSA-65 must be resolved from the call-site context");
    assert.strictEqual(mlDsa.cryptoProperties.assetType, "algorithm");
    assert.strictEqual(mlDsa.cryptoProperties.oid, "2.16.840.1.101.3.4.3.18");
    assert.strictEqual(
      mlDsa.cryptoProperties.algorithmProperties.algorithmFamily,
      "ML-DSA",
    );
    const slhDsa = byName.get("slh-dsa-sha2-128s");
    assert.ok(
      slhDsa,
      "SLH-DSA parameter set must be resolved from the context",
    );
    assert.strictEqual(slhDsa.cryptoProperties.oid, "2.16.840.1.101.3.4.3.20");
    const mlKem = byName.get("ml-kem-768");
    assert.ok(mlKem, "ML-KEM-768 must be resolved from the call-site context");
    assert.strictEqual(mlKem.cryptoProperties.oid, "2.16.840.1.101.3.4.4.2");
    const x25519 = byName.get("x25519");
    assert.ok(x25519, "X25519 asset must map to a component");
    assert.strictEqual(x25519.cryptoProperties.oid, "1.3.101.110");
    assert.ok(
      x25519.properties.some(
        (property) =>
          property.name === "cdx:crypto:primitive" &&
          property.value === "key-agreement",
      ),
    );
  });

  it("collectDosaiCryptoComponents() skips post-quantum families whose context names no single parameter set", async () => {
    const analyzeDosaiCrypto = () => ({
      Assets: [],
      Operations: [
        {
          Id: "cop-slh-dsa-bare",
          OperationType: "sign",
          Algorithm: "SLH-DSA",
          Symbol: "SlhDsa",
          // SHA2 and SHAKE have distinct OIDs, so the size alone resolves to none.
          Code: 'var alg = ResolveSignatureAlgorithm("SLH-DSA-192f");',
          Location: { Path: "Program.cs", LineNumber: 71, ColumnNumber: 15 },
        },
      ],
    });
    const { collectDosaiCryptoComponents } = await esmock("./cbomutils.js", {
      "./dosai.js": { analyzeDosaiCrypto },
    });

    const components = await collectDosaiCryptoComponents("/tmp/project", {
      evidence: true,
      specVersion: 1.7,
    });

    assert.deepStrictEqual(components, []);
  });

  it("collectDosaiCryptoComponents() includes related-crypto-material from dosai Materials", async () => {
    const analyzeDosaiCrypto = () => ({
      Assets: [],
      Operations: [
        {
          Id: "cop1",
          OperationType: "encrypt",
          Algorithm: "AES",
          DataFlowSliceIds: ["dfs1"],
          Location: {
            Path: "Crypto.cs",
            FileName: "Crypto.cs",
            LineNumber: 10,
            ColumnNumber: 9,
          },
          ReachableFromEntryPoint: true,
          EntryPointIds: ["ep1"],
        },
      ],
      Materials: [
        {
          Id: "mat1",
          Name: "StaticKey",
          MaterialType: "key-or-secret",
          Storage: "hardcoded",
          Fingerprint: "abc123",
          DataFlowSliceIds: ["dfs1"],
          Location: {
            Path: "Crypto.cs",
            FileName: "Crypto.cs",
            LineNumber: 5,
            ColumnNumber: 4,
          },
          ReachableFromEntryPoint: true,
          EntryPointIds: ["ep1"],
        },
        {
          Id: "mat2",
          Name: "StaticNonce",
          MaterialType: "iv-or-nonce",
          Storage: "hardcoded",
          DataFlowSliceIds: ["dfs1"],
          Location: {
            Path: "Crypto.cs",
            FileName: "Crypto.cs",
            LineNumber: 6,
            ColumnNumber: 4,
          },
          ReachableFromEntryPoint: false,
          EntryPointIds: [],
        },
      ],
    });
    const { collectDosaiCryptoComponents } = await esmock("./cbomutils.js", {
      "./dosai.js": { analyzeDosaiCrypto },
    });

    const components = await collectDosaiCryptoComponents("/tmp/project", {
      evidence: true,
      specVersion: 1.7,
    });

    const materialComponents = components.filter(
      (component) =>
        component.cryptoProperties?.assetType === "related-crypto-material",
    );
    assert.strictEqual(materialComponents.length, 2);

    const keyComponent = materialComponents.find(
      (component) => component.name === "StaticKey",
    );
    assert.ok(keyComponent);
    assert.strictEqual(keyComponent.type, "cryptographic-asset");
    assert.strictEqual(
      keyComponent.cryptoProperties.relatedCryptoMaterialProperties.type,
      "secret-key",
    );
    assert.strictEqual(
      keyComponent.cryptoProperties.relatedCryptoMaterialProperties.id,
      "abc123",
    );
    assert.strictEqual(
      keyComponent.cryptoProperties.relatedCryptoMaterialProperties.state,
      undefined,
    );
    assert.ok(
      keyComponent.properties.some(
        (property) =>
          property.name === "cdx:dosai:crypto:storage" &&
          property.value === "hardcoded",
      ),
    );
    assert.ok(
      keyComponent.properties.some(
        (property) =>
          property.name === "cdx:crypto:sourceType" &&
          property.value === "dosai:material",
      ),
    );
    assert.ok(
      keyComponent.properties.some(
        (property) =>
          property.name === "cdx:dosai:crypto:dataFlowSliceIds" &&
          property.value === "dfs1",
      ),
    );

    const nonceComponent = materialComponents.find(
      (component) => component.name === "StaticNonce",
    );
    assert.ok(nonceComponent);
    assert.strictEqual(
      nonceComponent.cryptoProperties.relatedCryptoMaterialProperties.type,
      "initialization-vector",
    );
    assert.ok(
      !nonceComponent.cryptoProperties.relatedCryptoMaterialProperties.id,
    );
  });

  it("collectDosaiCryptoComponents() adds DataFlowSliceIds property for algorithm operations", async () => {
    const analyzeDosaiCrypto = () => ({
      Assets: [],
      Operations: [
        {
          Id: "cop1",
          OperationType: "hash",
          Algorithm: "SHA-256",
          DataFlowSliceIds: ["dfs1", "dfs2"],
          Location: {
            Path: "Program.cs",
            FileName: "Program.cs",
            LineNumber: 12,
            ColumnNumber: 9,
          },
          ReachableFromEntryPoint: true,
          EntryPointIds: ["ep1"],
        },
      ],
    });
    const { collectDosaiCryptoComponents } = await esmock("./cbomutils.js", {
      "./dosai.js": { analyzeDosaiCrypto },
    });

    const components = await collectDosaiCryptoComponents("/tmp/project", {
      evidence: true,
      specVersion: 1.7,
    });

    assert.strictEqual(components.length, 1);
    assert.ok(
      components[0].properties.some(
        (property) =>
          property.name === "cdx:dosai:crypto:dataFlowSliceIds" &&
          property.value === "dfs1,dfs2",
      ),
    );
  });

  // findCryptoAlgos matches an algorithm name only where a cleanStr word
  // begins: at a run's start, after a character cleanStr strips, or at a
  // lowercase-to-uppercase change in the original text. cleanStr fuses
  // identifiers (`prepare_for_save(iv` becomes `prepareforsaveiv`), and the
  // fused string read the shortest names inside unrelated words: DefectDojo's
  // caller line `prepare_for_save(iv, ...)` yielded a false `rsa`
  // cryptographic asset (T15 evidence 3.1). The case-boundary start is what
  // the pure run-start rule of that fix missed: `SHA256withRSA` lost `rsa`,
  // `HmacSHA256` lost `sha-256`, `generateRsaKeyPair()` lost `rsa` (T15
  // Part 2 finding 1).
  it("findCryptoAlgos() does not match rsa inside a fused identifier", () => {
    const names = findCryptoAlgos("prepare_for_save(iv, value)").map(
      (algo) => algo.name,
    );
    assert.deepEqual(names, []);
    assert.deepEqual(
      findCryptoAlgos("prepareForSave(iv, value)").map((algo) => algo.name),
      [],
    );
  });

  it("findCryptoAlgos() matches names at lowercase-to-uppercase changes", () => {
    assert.deepEqual(
      findCryptoAlgos('Signature.getInstance("SHA256withRSA")')
        .map((algo) => algo.name)
        .sort(),
      ["rsa", "sha-256"],
    );
    assert.deepEqual(
      findCryptoAlgos('Mac.getInstance("HmacSHA256")')
        .map((algo) => algo.name)
        .sort(),
      ["hmacSHA", "sha-256"],
    );
    assert.deepEqual(
      findCryptoAlgos('SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")')
        .map((algo) => algo.name)
        .sort(),
      ["PBKDF2", "hmacSHA", "sha-256"],
    );
    assert.deepEqual(
      findCryptoAlgos("generateRsaKeyPair()").map((algo) => algo.name),
      ["rsa"],
    );
    assert.ok(
      findCryptoAlgos("Ed25519PrivateKey.generate()").some(
        (algo) => algo.name === "ed25519",
      ),
    );
  });

  it("findCryptoAlgos() matches real AES forms", () => {
    assert.ok(
      findCryptoAlgos("algorithms.AES(key)").some(
        (algo) => algo.name === "aes",
      ),
    );
    assert.ok(
      findCryptoAlgos("AESGCM(key)").some((algo) => algo.name === "aes"),
    );
    assert.ok(
      findCryptoAlgos("Cipher(algorithms.AES(key), OFB(iv))").some(
        (algo) => algo.name === "aes",
      ),
    );
    assert.ok(
      findCryptoAlgos("AESGCM(key).encrypt(data)").some(
        (algo) => algo.name === "aes",
      ),
    );
    const gcmNames = findCryptoAlgos(
      'createCipheriv("aes-256-gcm", key, iv)',
    ).map((algo) => algo.name);
    assert.ok(gcmNames.includes("aes"));
    assert.ok(gcmNames.includes("aes256-GCM"));
  });

  it("findCryptoAlgos() matches real RSA and SHA forms", () => {
    assert.ok(
      findCryptoAlgos(
        'crypto.generateKeyPairSync("rsa", { modulusLength: 2048 })',
      ).some((algo) => algo.name === "rsa"),
    );
    assert.ok(
      findCryptoAlgos('Cipher.getInstance("RSA/ECB/PKCS1Padding")').some(
        (algo) => algo.name === "rsa",
      ),
    );
    assert.ok(
      findCryptoAlgos('createHash("sha256").update(data)').some(
        (algo) => algo.name === "sha-256",
      ),
    );
    assert.ok(
      findCryptoAlgos('digest("SHA-512", message)').some(
        (algo) => algo.name === "sha-512",
      ),
    );
  });

  it("findCryptoAlgos() ignores non-string and empty input", () => {
    assert.deepEqual(findCryptoAlgos(""), []);
    assert.deepEqual(findCryptoAlgos(undefined), []);
    assert.deepEqual(findCryptoAlgos(null), []);
  });
});
