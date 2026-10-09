import { assert, describe, it } from "poku";

import { createBom } from "./index.js";

/**
 * End-to-end dispatch coverage for the newer ecosystem types. Each case hands
 * a fixture project to createBom with an explicit project type and checks
 * that the expected component and purl shape come back.
 */
describe("createBom() new ecosystem dispatch", () => {
  const cases = [
    {
      label: "julia",
      dir: "./test/data/julia-smoke",
      type: "julia",
      expectName: "JSON",
      expectPurlPrefix: "pkg:julia/JSON",
    },
    {
      label: "terraform",
      dir: "./test/data/terraform-smoke",
      type: "terraform",
      expectName: "aws",
      expectPurlPrefix: "pkg:generic/registry.terraform.io/hashicorp/aws",
    },
    {
      label: "r",
      dir: "./test/data/renv-smoke",
      type: "r",
      expectName: "dplyr",
      expectPurlPrefix: "pkg:cran/dplyr",
    },
    {
      label: "erlang",
      dir: "./test/data/rebar-smoke",
      type: "rebar3",
      expectName: "cowboy",
      expectPurlPrefix: "pkg:hex/cowboy",
    },
    {
      label: "ocaml",
      dir: "./test/data/opam-smoke",
      type: "ocaml",
      expectName: "dune",
      expectPurlPrefix: "pkg:opam/dune@3.16.0",
    },
    {
      label: "perl",
      dir: "./test/data/perl-smoke",
      type: "carton",
      expectName: "Plack",
      expectPurlPrefix: "pkg:cpan/MIYAGAWA/Plack",
    },
    {
      label: "elm",
      dir: "./test/data/elm-smoke",
      type: "elm",
      expectName: "http",
      expectPurlPrefix: "pkg:generic/elm/http@1.0.0",
    },
    {
      label: "crystal",
      dir: "./test/data/crystal-smoke",
      type: "crystal",
      expectName: "http-f",
      expectPurlPrefix: "pkg:generic/http-f@1.0.1",
    },
    {
      label: "nim",
      dir: "./test/data/nim-smoke",
      type: "nim",
      expectName: "semver",
      expectPurlPrefix: "pkg:generic/semver@1.0.0",
    },
    {
      label: "lua",
      dir: "./test/data/lua-smoke",
      type: "luarocks",
      expectName: "net-url",
      expectPurlPrefix: "pkg:luarocks/net-url@0.9-0",
    },
    {
      label: "spack",
      dir: "./test/data/spack-smoke",
      type: "spack",
      expectName: "zlib",
      expectPurlPrefix: "pkg:generic/spack/zlib@1.3.1",
    },
    {
      label: "haskell stack",
      dir: "./test/data/stack-smoke",
      type: "stack",
      expectName: "acme-missiles",
      expectPurlPrefix: "pkg:hackage/acme-missiles@0.3",
    },
  ];
  for (const testCase of cases) {
    it(`generates a BOM for ${testCase.label} projects`, async () => {
      const bomNSData = await createBom(testCase.dir, {
        projectType: [testCase.type],
        multiProject: true,
      });
      assert.ok(bomNSData?.bomJson, "bomJson should be present");
      const components = bomNSData.bomJson.components || [];
      const target = components.find((c) => c.name === testCase.expectName);
      assert.ok(target, `expected a component named ${testCase.expectName}`);
      assert.ok(
        target.purl?.startsWith(testCase.expectPurlPrefix),
        `unexpected purl ${target.purl}`,
      );
    });
  }
});

/**
 * Terraform dispatch across the entry points real commands hit: the
 * multi-type scan (`-t terraform -t js`), the default recurse scan
 * (`cdxgen <dir>`), and the exclude filter. Every resulting BOM must be a
 * connected graph anchored at the detected parent.
 */
describe("createBom() terraform dispatch", () => {
  const fixture = "./test/data/terraform-modules";

  const terraformModuleCount = (bom) =>
    (bom?.components || []).filter((c) =>
      (c.purl || "").startsWith(
        "pkg:generic/registry.terraform.io/terraform-aws-modules/",
      ),
    ).length;

  it("finds terraform components in a multi-type scan", async () => {
    const bomNSData = await createBom(fixture, {
      projectType: ["terraform", "js"],
      multiProject: true,
    });
    assert.ok(terraformModuleCount(bomNSData.bomJson) > 0);
    assertWellFormedGraph(bomNSData.bomJson);
  });

  it("finds terraform components in the default recurse scan", async () => {
    const bomNSData = await createBom(fixture, { multiProject: true });
    assert.ok(terraformModuleCount(bomNSData.bomJson) > 0);
    assertWellFormedGraph(bomNSData.bomJson);
  });

  it("honours excludeType for terraform", async () => {
    const bomNSData = await createBom(fixture, {
      multiProject: true,
      excludeType: ["terraform"],
    });
    const bom = bomNSData?.bomJson || {};
    assert.strictEqual(
      (bom.components || []).filter((c) =>
        (c.properties || []).some((p) => p.name === "cdx:tf:kind"),
      ).length,
      0,
    );
  });
});

/**
 * Assert the invariants every Terraform BOM must hold: no squatted
 * `pkg:terraform/` purls, every dependency ref defined, a parent component
 * present, and every Terraform-collected component reachable from it. (A
 * default recurse scan also runs other collectors whose components are not
 * the Terraform graph's concern.)
 *
 * @param {object} bom Generated BOM document
 */
function assertWellFormedGraph(bom) {
  assert.ok(bom, "bomJson should be present");
  const parentRef = bom.metadata?.component?.["bom-ref"];
  assert.ok(parentRef, "metadata.component should be present");
  const components = bom.components || [];
  const refSet = new Set(
    components.map((c) => c["bom-ref"]).concat([parentRef]),
  );
  for (const component of components) {
    assert.ok(
      !(component.purl || "").startsWith("pkg:terraform/"),
      `squatted purl ${component.purl}`,
    );
  }
  const edges = new Map();
  for (const dep of bom.dependencies || []) {
    assert.ok(refSet.has(dep.ref), `undefined dependency ref ${dep.ref}`);
    for (const target of dep.dependsOn || []) {
      assert.ok(refSet.has(target), `undefined dependsOn ${target}`);
      if (!edges.has(dep.ref)) {
        edges.set(dep.ref, new Set());
      }
      edges.get(dep.ref).add(target);
    }
  }
  const terraformRefs = components
    .filter((c) => (c.properties || []).some((p) => p.name === "cdx:tf:kind"))
    .map((c) => c["bom-ref"]);
  assert.ok(terraformRefs.length > 0, "terraform components present");
  const seen = new Set([parentRef]);
  const queue = [parentRef];
  while (queue.length) {
    const ref = queue.shift();
    for (const next of edges.get(ref) || []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  for (const ref of terraformRefs) {
    assert.ok(
      seen.has(ref),
      `component ${ref} is not reachable from the parent`,
    );
  }
}
