import { createServer } from "node:http";
import process from "node:process";

import { it } from "poku";

// Terraform registry enrichment against a local stand-in. The registry URLs,
// the GitHub API base and the batch transport are process-wide, so this file
// holds one sequential test, and every case uses its own coordinates so the
// agent's GET cache cannot leak a response between cases.

const prop = (pkg, name) =>
  (pkg.properties || []).find((entry) => entry.name === name)?.value;

const setProp = (pkg, name, value) => {
  (pkg.properties = pkg.properties || []).push({ name, value });
};

const modulePkg = (ns, name, system, version) => ({
  type: "library",
  group: `registry.terraform.io/${ns}`,
  name: `${name}/${system}`,
  version,
  "bom-ref": `pkg:generic/registry.terraform.io/${ns}/${name}/${system}@${version}`,
  properties: [
    { name: "cdx:tf:kind", value: "module" },
    {
      name: "cdx:tf:address",
      value: `registry.terraform.io/${ns}/${name}/${system}`,
    },
  ],
});

const providerPkg = (ns, type, version) => ({
  type: "library",
  group: `registry.terraform.io/${ns}`,
  name: type,
  version,
  "bom-ref": `pkg:generic/registry.terraform.io/${ns}/${type}@${version}`,
  properties: [
    { name: "cdx:tf:kind", value: "provider" },
    { name: "cdx:tf:address", value: `registry.terraform.io/${ns}/${type}` },
  ],
});

it("getTerraformRegistryMetadata enriches licenses, repositories and flags", async () => {
  const routes = new Map();
  const json = (path, body, status = 200) => routes.set(path, { body, status });
  const invalidJson = (path) =>
    routes.set(path, { body: "not-json{", status: 200, raw: true });

  // Case 1: docs-API license; an entry below 0.8 confidence is ignored.
  json("/registry/docs/modules/one/label/null/v1.0.0/index.json", {
    licenses: [
      { spdx: "GPL-2.0-only", confidence: 0.5 },
      { spdx: "Apache-2.0", confidence: 0.9 },
    ],
  });
  // Case 1b: providers use the singular `license` key.
  json("/registry/docs/providers/one/hashicorp/v2.0.0/index.json", {
    license: [{ spdx: "MPL-2.0", confidence: 0.95 }],
  });
  // Case 1c: submodule calls of one version share a document; of equally
  // confident entries the first is used.
  json("/registry/docs/modules/one/shared/aws/v1.0.0/index.json", {
    licenses: [
      { spdx: "ISC", confidence: 0.85 },
      { spdx: "MIT", confidence: 0.9 },
      { spdx: "Apache-2.0", confidence: 0.9 },
    ],
  });
  json("/v1/modules/one/shared/aws/1.0.0", {
    source: "https://github.com/one/terraform-aws-shared?ref=v1.0.0",
  });
  // Case 3: registry metadata for modules and providers.
  json("/v1/modules/three/vpc/aws/3.0.0", {
    source: "https://github.com/terraform-aws-modules/terraform-aws-vpc",
    verified: true,
    deprecation: { message: "use v6" },
    description: "Terraform module which creates VPC resources on AWS.",
  });
  json("/registry/docs/modules/three/vpc/aws/v3.0.0/index.json", {
    licenses: [],
  });
  json("/v1/providers/three/hashicorp/3.0.0", {
    source: "https://github.com/hashicorp/terraform-provider-hashicorp",
    tier: "official",
  });
  json("/registry/docs/providers/three/hashicorp/v3.0.0/index.json", {
    licenses: [],
  });
  // Case 3b: unverified module, community tier, long description.
  json("/v1/modules/four/iam/aws/4.0.0", {
    source: "https://github.com/four/terraform-aws-iam",
    verified: false,
    description: `d${"e".repeat(2000)}`,
  });
  json("/registry/docs/modules/four/iam/aws/v4.0.0/index.json", {
    licenses: [],
  });
  // Case 4: git module whose license only the GitHub fallback can find.
  json("/repos/five/repo/license", {
    html_url: "https://github.com/five/repo/blob/main/LICENSE",
    license: { spdx_id: "MIT", name: "MIT License" },
  });
  // Case 6: nothing usable comes back.
  invalidJson("/registry/docs/modules/six/bad/aws/v6.0.0/index.json");
  json("/v1/modules/six/bad/aws/6.0.0", undefined, 500);

  const requests = [];
  const server = createServer((req, res) => {
    requests.push(req.url);
    const route = routes.get(req.url);
    if (!route) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    res.writeHead(route.status, { "content-type": "application/json" });
    if (route.raw) {
      res.end(route.body);
      return;
    }
    res.end(JSON.stringify(route.body || {}));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const saved = {
    CDXGEN_TF_REGISTRY_URL: process.env.CDXGEN_TF_REGISTRY_URL,
    CDXGEN_TOFU_DOCS_URL: process.env.CDXGEN_TOFU_DOCS_URL,
    GITHUB_API_URL: process.env.GITHUB_API_URL,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
    CDXGEN_RS_DISABLE: process.env.CDXGEN_RS_DISABLE,
    FETCH_LICENSE: process.env.FETCH_LICENSE,
    CDXGEN_FETCH_PKG_METADATA: process.env.CDXGEN_FETCH_PKG_METADATA,
  };
  process.env.CDXGEN_TF_REGISTRY_URL = base;
  process.env.CDXGEN_TOFU_DOCS_URL = base;
  process.env.GITHUB_API_URL = base;
  process.env.CDXGEN_RS_DISABLE = "fetch";
  delete process.env.GITHUB_TOKEN;
  delete process.env.FETCH_LICENSE;
  delete process.env.CDXGEN_FETCH_PKG_METADATA;
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { resetRepoLicensePrefetch } = await import("./ecosystems.js");
    resetRepoLicensePrefetch();
    const { getTerraformRegistryMetadata } = await import(
      "./terraformRegistry.js"
    );

    // 1. Docs-API licenses, ignoring the low-confidence entry.
    const label = modulePkg("one", "label", "null", "1.0.0");
    const hashicorp = providerPkg("one", "hashicorp", "2.0.0");
    await getTerraformRegistryMetadata([label, hashicorp]);
    if (label.license === undefined) {
      throw new Error(`docs license missing: ${JSON.stringify(label)}`);
    }
    if (
      label.license !== "Apache-2.0" ||
      prop(label, "cdx:tf:licenseSource") !== "opentofu-registry"
    ) {
      throw new Error(`unexpected docs license result: ${label.license}`);
    }
    if (hashicorp.license !== "MPL-2.0") {
      throw new Error(`provider docs license missing: ${hashicorp.license}`);
    }

    // 1c. Components that share a document each get its license, unless
    // they already have one, and its sanitized repository.
    const shared = ["a", "b", "c"].map((name) => ({
      ...modulePkg("one", "shared", "aws", "1.0.0"),
      "bom-ref": `pkg:generic/registry.terraform.io/one/shared/aws@1.0.0#modules/${name}`,
    }));
    shared[1].license = "BSD-3-Clause";
    await getTerraformRegistryMetadata(shared);
    if (
      shared[0].license !== "MIT" ||
      shared[1].license !== "BSD-3-Clause" ||
      shared[2].license !== "MIT" ||
      prop(shared[2], "cdx:tf:licenseSource") !== "opentofu-registry"
    ) {
      throw new Error(
        `unexpected shared docs licenses: ${shared.map((pkg) => pkg.license)}`,
      );
    }
    if (
      shared.some(
        (pkg) =>
          pkg.repository?.url !== "https://github.com/one/terraform-aws-shared",
      )
    ) {
      throw new Error(
        `unexpected shared repositories: ${shared.map((pkg) => pkg.repository?.url)}`,
      );
    }

    // 2. An offline license always wins.
    const offline = modulePkg("two", "label", "null", "2.0.0");
    offline.license = "BSD-3-Clause";
    setProp(offline, "cdx:tf:licenseSource", "file");
    await getTerraformRegistryMetadata([offline]);
    if (offline.license !== "BSD-3-Clause") {
      throw new Error(`offline license overwritten: ${offline.license}`);
    }
    if (prop(offline, "cdx:tf:licenseSource") !== "file") {
      throw new Error("offline license source overwritten");
    }

    // 3. Registry metadata: repository, verified, deprecation, description, tier.
    const vpc = modulePkg("three", "vpc", "aws", "3.0.0");
    const provider = providerPkg("three", "hashicorp", "3.0.0");
    await getTerraformRegistryMetadata([vpc, provider]);
    if (
      vpc.repository?.url !==
      "https://github.com/terraform-aws-modules/terraform-aws-vpc"
    ) {
      throw new Error(
        `module repository missing: ${JSON.stringify(vpc.repository)}`,
      );
    }
    if (prop(vpc, "cdx:tf:registry:verified") !== "true") {
      throw new Error("verified flag missing");
    }
    if (prop(vpc, "cdx:tf:deprecated") !== "true") {
      throw new Error("deprecation flag missing");
    }
    if (
      vpc.description !== "Terraform module which creates VPC resources on AWS."
    ) {
      throw new Error(`description missing: ${vpc.description}`);
    }
    if (
      provider.repository?.url !==
      "https://github.com/hashicorp/terraform-provider-hashicorp"
    ) {
      throw new Error(
        `provider repository missing: ${JSON.stringify(provider.repository)}`,
      );
    }
    if (prop(provider, "cdx:tf:registry:tier") !== "official") {
      throw new Error(
        `tier missing: ${prop(provider, "cdx:tf:registry:tier")}`,
      );
    }
    const iam = modulePkg("four", "iam", "aws", "4.0.0");
    await getTerraformRegistryMetadata([iam]);
    if (prop(iam, "cdx:tf:registry:verified") !== "false") {
      throw new Error("verified=false flag missing");
    }
    if (iam.description.length !== 1024) {
      throw new Error(`description not capped: ${iam.description.length}`);
    }

    // 4. GitHub fallback for a git module without a license.
    const gitModule = {
      type: "library",
      name: "repo",
      version: "v1.1.1",
      "bom-ref": "pkg:github/five/repo@v1.1.1",
      properties: [
        { name: "cdx:tf:kind", value: "module" },
        {
          name: "cdx:tf:module:source",
          value: "git::https://github.com/five/repo.git",
        },
      ],
    };
    await getTerraformRegistryMetadata([gitModule]);
    if (gitModule.license !== "MIT") {
      throw new Error(`github fallback license missing: ${gitModule.license}`);
    }
    if (prop(gitModule, "cdx:tf:licenseSource") !== "github") {
      throw new Error("github license source missing");
    }

    // 5. A private registry host is never contacted.
    const privateHost = {
      type: "library",
      group: "app.terraform.io/acme",
      name: "vault/vault",
      version: "1.2.3",
      "bom-ref": "pkg:generic/app.terraform.io/acme/vault/vault@1.2.3",
      properties: [
        { name: "cdx:tf:kind", value: "module" },
        { name: "cdx:tf:address", value: "app.terraform.io/acme/vault/vault" },
      ],
    };
    const requestsBefore = requests.length;
    await getTerraformRegistryMetadata([privateHost]);
    if (requests.length !== requestsBefore) {
      throw new Error("private registry host was contacted");
    }
    if (privateHost.license !== undefined) {
      throw new Error("private host component was modified");
    }

    // 6. 404/500/invalid JSON leave components unchanged.
    const doomed = modulePkg("six", "bad", "aws", "6.0.0");
    await getTerraformRegistryMetadata([doomed]);
    if (doomed.license !== undefined || doomed.repository !== undefined) {
      throw new Error(
        `component changed despite failures: ${JSON.stringify(doomed)}`,
      );
    }
    if (prop(doomed, "cdx:tf:registry:verified") !== undefined) {
      throw new Error("flag set despite failure");
    }

    // 6b. OpenTofu components are looked up in the docs API only; the
    // Terraform registry never learns about them. The docs `link` names the
    // repository.
    const tofu = {
      type: "library",
      group: "registry.opentofu.org/eight",
      name: "vpc/aws",
      version: "8.0.0",
      "bom-ref": "pkg:generic/registry.opentofu.org/eight/vpc/aws@8.0.0",
      properties: [
        { name: "cdx:tf:kind", value: "module" },
        {
          name: "cdx:tf:address",
          value: "registry.opentofu.org/eight/vpc/aws",
        },
      ],
    };
    json("/registry/docs/modules/eight/vpc/aws/v8.0.0/index.json", {
      licenses: [{ spdx: "Apache-2.0", confidence: 0.95 }],
      link: "https://github.com/eight/terraform-aws-vpc/tree/v8.0.0",
    });
    const tofuMark = requests.length;
    await getTerraformRegistryMetadata([tofu]);
    const tofuRequests = requests.slice(tofuMark);
    if (tofuRequests.some((url) => url.startsWith("/v1/"))) {
      throw new Error(
        `OpenTofu component reached the Terraform registry: ${tofuRequests.join(", ")}`,
      );
    }
    if (
      tofu.license !== "Apache-2.0" ||
      tofu.repository?.url !== "https://github.com/eight/terraform-aws-vpc"
    ) {
      throw new Error(`OpenTofu enrichment missing: ${JSON.stringify(tofu)}`);
    }

    // 6c. A registry document is copied to every component that shares it,
    // so a value that is not what its field holds is not copied at all: a
    // license expression or text where an SPDX id belongs, and a repository
    // URL of no plausible length.
    json("/registry/docs/modules/nine/vpc/aws/v9.0.0/index.json", {
      licenses: [
        { spdx: "MIT AND Apache-2.0", confidence: 1.0 },
        { spdx: `MIT${"-x".repeat(5000)}`, confidence: 0.99 },
        { spdx: ["MIT"], confidence: 0.98 },
        { spdx: "ISC", confidence: 0.9 },
      ],
    });
    json("/v1/modules/nine/vpc/aws/9.0.0", {
      source: `https://github.com/nine/${"a".repeat(5000)}`,
      verified: true,
    });
    json("/registry/docs/modules/nine/text/aws/v9.0.0/index.json", {
      licenses: [
        { spdx: `MIT AND ${"MIT AND ".repeat(5000)}MIT`, confidence: 1 },
      ],
    });
    json("/v1/modules/nine/text/aws/9.0.0", {
      source: "https://github.com/nine/text",
    });
    json("/repos/nine/text/license", {
      html_url: "https://github.com/nine/text/blob/main/LICENSE",
      license: {
        spdx_id: `MIT AND ${"MIT AND ".repeat(5000)}MIT`,
        name: "MIT License",
      },
    });
    json("/registry/docs/modules/nine/link/aws/v9.0.0/index.json", {
      licenses: [],
      link: `https://github.com/nine/${"a".repeat(5000)}/tree/v9.0.0`,
    });
    const shaped = modulePkg("nine", "vpc", "aws", "9.0.0");
    const unshaped = modulePkg("nine", "text", "aws", "9.0.0");
    const longLink = {
      type: "library",
      group: "registry.opentofu.org/nine",
      name: "link/aws",
      version: "9.0.0",
      "bom-ref": "pkg:generic/registry.opentofu.org/nine/link/aws@9.0.0",
      properties: [
        { name: "cdx:tf:kind", value: "module" },
        {
          name: "cdx:tf:address",
          value: "registry.opentofu.org/nine/link/aws",
        },
      ],
    };
    await getTerraformRegistryMetadata([shaped, unshaped, longLink]);
    if (shaped.license !== "ISC") {
      throw new Error(`docs license is not the SPDX id: ${shaped.license}`);
    }
    if (
      shaped.repository !== undefined ||
      prop(shaped, "cdx:tf:registry:verified") !== "true"
    ) {
      throw new Error(
        `overlong registry source kept: ${JSON.stringify(shaped).slice(0, 300)}`,
      );
    }
    if (
      unshaped.license !== undefined ||
      prop(unshaped, "cdx:tf:licenseSource") !== undefined ||
      unshaped.repository?.url !== "https://github.com/nine/text"
    ) {
      throw new Error(
        `license that is not an SPDX id kept: ${JSON.stringify(unshaped).slice(0, 300)}`,
      );
    }
    if (longLink.repository !== undefined) {
      throw new Error("overlong docs link kept");
    }

    // 6d. Many versions are enriched a round at a time, so their documents
    // are never all held at once.
    const versions = Array.from({ length: 120 }, (_, index) => {
      json(`/registry/docs/modules/nine/wide/aws/v9.0.${index}/index.json`, {
        licenses: [{ spdx: "MIT", confidence: 1 }],
      });
      json(`/v1/modules/nine/wide/aws/9.0.${index}`, { verified: false });
      return modulePkg("nine", "wide", "aws", `9.0.${index}`);
    });
    const { lastBatchStats } = await import("../inventory/fetchBatch.js");
    const versionsMark = requests.length;
    await getTerraformRegistryMetadata(versions);
    const unenriched = versions.filter(
      (pkg) =>
        pkg.license !== "MIT" ||
        prop(pkg, "cdx:tf:registry:verified") !== "false",
    );
    if (unenriched.length) {
      throw new Error(`${unenriched.length} of 120 versions were not enriched`);
    }
    if (requests.length - versionsMark !== 2 * versions.length) {
      throw new Error(
        `expected one request per document, got ${requests.length - versionsMark}`,
      );
    }
    if (lastBatchStats().requests >= 2 * versions.length) {
      throw new Error(
        `all ${lastBatchStats().requests} documents were fetched in one batch`,
      );
    }

    // 7. With the gate off, createTerraformBom makes zero requests.
    const { createTerraformBom } = await import("../cli/managedBom.js");
    const gateMark = requests.length;
    const bom = await createTerraformBom("./test/data/terraform-modules", {
      projectType: ["terraform"],
    });
    if (!bom?.bomJson?.components?.length) {
      throw new Error("gate-off scan produced no BOM");
    }
    if (requests.length !== gateMark) {
      throw new Error(
        `gate-off scan made requests: ${requests.slice(gateMark).join(", ")}`,
      );
    }
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await new Promise((resolve) => server.close(resolve));
  }
});
