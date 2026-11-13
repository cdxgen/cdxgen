import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import { assert, describe, it, test } from "poku";

import { isGoModWhyNotNeeded, parseGosumHashes } from "./parsers-go.js";
import {
  parseGoListDep,
  parseGoModData,
  parseGoModGraph,
  parseGoModulesTxt,
  parseGoModWhy,
  parseGopkgData,
  parseGosumData,
  parseGoVersionData,
} from "./utils.js";

it("parseGoModData", async () => {
  let retMap = await parseGoModData(null);
  assert.deepStrictEqual(retMap, {});
  const gosumMap = {
    "google.golang.org/grpc@v1.21.0":
      "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
    "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
    "github.com/spf13/cobra@v1.0.0":
      "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
    "github.com/spf13/viper@v1.3.0":
      "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
    "github.com/stretchr/testify@v1.6.1":
      "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
  };
  retMap = await parseGoModData(
    readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
    gosumMap,
  );
  assert.deepStrictEqual(retMap.pkgList.length, 6);
  assert.ok(retMap.pkgList);

  retMap.pkgList.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
  retMap = await parseGoModData(
    readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
    name: "github.com/sqreen/go-dvwa",
    purl: "pkg:golang/github.com/sqreen/go-dvwa",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.rootList.length, 4);
  retMap = await parseGoModData(
    readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/anchore/syft",
    name: "github.com/anchore/syft",
    purl: "pkg:golang/github.com/anchore/syft",
    type: "application",
  });
  // The 235 requires and the one module replacement `go mod edit -json` reads
  // from this file; the `retract` block names no dependency.
  assert.deepStrictEqual(retMap.pkgList.length, 236);
  assert.deepStrictEqual(retMap.rootList.length, 81);
}, 120000);

it("parseGoModData reads only require and replace as dependencies", async () => {
  // The #4512 reproducer: an inline replace followed by an exclude block.
  let retMap = await parseGoModData(
    readFileSync("./test/data/go-replace-exclude.mod", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(
    retMap.pkgList.map((c) => c["bom-ref"]),
    [
      "pkg:golang/git.example.com/platform/go/kafka-metrics-converter@v0.2.3",
      "pkg:golang/github.com/pkg/errors@v0.9.1",
    ],
  );
  assert.deepStrictEqual(retMap.rootList.length, 2);

  // Every directive in its single-line and block form, as Go reads it.
  const gosumMap = {
    "github.com/anchore/archiver/v3@v3.5.2": "sha256-fake-archiver-hash=",
    "github.com/pkg/errors@v0.9.1": "sha256-fake-errors-hash=",
  };
  retMap = await parseGoModData(
    readFileSync("./test/data/go-mod-directives.mod", { encoding: "utf-8" }),
    gosumMap,
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/cdxgen/gomod-directives",
    name: "github.com/cdxgen/gomod-directives",
    purl: "pkg:golang/github.com/cdxgen/gomod-directives",
    type: "application",
    properties: [{ name: "cdx:go:toolchain", value: "go1.25.1" }],
  });
  // Excluded, retracted, ignored and tool entries stay out, as do the two
  // directory replacements, which name no module version.
  assert.deepStrictEqual(
    retMap.pkgList.map((c) => c["bom-ref"]),
    [
      "pkg:golang/github.com/anchore/archiver/v3@v3.5.2",
      "pkg:golang/github.com/google/uuid@v1.6.0",
      "pkg:golang/github.com/pkg/errors@v0.9.1",
      "pkg:golang/github.com/rcrowley/go-metrics@v0.0.0-20201227073835-cf1acfcdf475",
      // A module path ending in "tool" is still a requirement.
      "pkg:golang/github.com/uber/prototool@v1.10.0",
      // So is a require whose comment carries a parenthesis.
      "pkg:golang/golang.org/x/net@v0.33.0",
      "pkg:golang/golang.org/x/text@v0.21.0",
      "pkg:golang/golang.org/x/tools@v0.28.0",
      "pkg:golang/gopkg.in/yaml.v3@v3.0.1",
    ],
  );
  // `// indirect` and `// indirect; reason` both mark an indirect require.
  assert.deepStrictEqual(
    retMap.pkgList.filter((c) => c.scope === "optional").map((c) => c.name),
    ["golang.org/x/text", "golang.org/x/tools"],
  );
  assert.deepStrictEqual(
    retMap.rootList.map((c) => c["bom-ref"]).sort(),
    retMap.pkgList
      .filter((c) => c.scope !== "optional")
      .map((c) => c["bom-ref"]),
  );
  // The replacement module, not the module it replaces, carries the go.sum hash.
  assert.deepStrictEqual(
    retMap.pkgList.find((c) => c.name === "github.com/anchore/archiver/v3")
      ._integrity,
    "sha256-fake-archiver-hash=",
  );
  assert.deepStrictEqual(
    retMap.pkgList.find((c) => c.name === "github.com/pkg/errors")._integrity,
    "sha256-fake-errors-hash=",
  );
  assert.ok(retMap.pkgList.every((c) => c.name && c.version && c.purl));
}, 120000);

it("parseGoModData reads quoted paths and skips malformed lines", async () => {
  const retMap = await parseGoModData(
    [
      'module "example.com/quoted" // the module',
      "",
      "require ( )",
      "require(",
      '\t"github.com/pkg/errors" v0.9.1 // indirect',
      ") // end of block",
      'replace "github.com/pkg/errors" => github.com/pkg/errors v0.9.0',
      "exclude github.com/pkg/errors v0.8.0",
      // Go rejects each line below; none may become a component.
      "replace example.com/broken =>",
      "replace example.com/broken v1.0.0 example.com/fork v1.0.1",
      "require `example.com/backquoted` v1.0.0",
      "require example.com/versionless",
      "",
    ].join("\r\n"),
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent.name, "example.com/quoted");
  assert.deepStrictEqual(
    retMap.pkgList.map((c) => [c["bom-ref"], c.scope]),
    [
      ["pkg:golang/github.com/pkg/errors@v0.9.0", undefined],
      ["pkg:golang/github.com/pkg/errors@v0.9.1", "optional"],
    ],
  );
});

it("parseGoSumData", async () => {
  let dep_list = await parseGosumData(null);
  assert.deepStrictEqual(dep_list, []);
  dep_list = await parseGosumData(
    readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 4);
  // Each hash is the checksum of the module content, from the `h1:` line,
  // not the checksum of its go.mod file from the `/go.mod` line.
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "google.golang.org/grpc",
    license: undefined,
    version: "v1.21.0",
    _integrity: "sha256-G+97AoqBnmZIT91cLG/EkCoK9NSelj64P8bOHHNmGn0=",
    "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
    purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
  });
  assert.deepStrictEqual(dep_list[1], {
    group: "",
    name: "github.com/spf13/cobra",
    license: undefined,
    version: "v1.0.0",
    _integrity: "sha256-6m/oheQuQ13N9ks4hubMG6BnvwOeaJrqSPLahSnczz8=",
    "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
    purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
  });
  assert.deepStrictEqual(dep_list[2], {
    group: "",
    name: "github.com/spf13/viper",
    license: undefined,
    version: "v1.0.2",
    _integrity: "sha256-Ncr3ZIuJn322w2k1qmzXDnkLAdQMlJqBa9kfAH+irso=",
    "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
    purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
  });
  assert.deepStrictEqual(dep_list[3], {
    group: "",
    name: "github.com/stretchr/testify",
    license: undefined,
    version: "v1.6.1",
    _integrity: "sha256-hDPOHmpOpP40lSULcqw7IrRb/u7w6RpDC9399XyoNd0=",
    "bom-ref": "pkg:golang/github.com/stretchr/testify@v1.6.1",
    purl: "pkg:golang/github.com/stretchr/testify@v1.6.1",
  });
  dep_list.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
  it(() => {
    delete process.env.GO_FETCH_VCS;
  });
}, 120000);

describe("go data with vcs", () => {
  it(() => {
    process.env.GO_FETCH_VCS = "true";
  });
  it("parseGoSumData with vcs", async () => {
    let dep_list = await parseGosumData(null);
    assert.deepStrictEqual(dep_list, []);
    dep_list = await parseGosumData(
      readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
    );
    assert.deepStrictEqual(dep_list.length, 4);
    assert.ok(dep_list[0]);
  }, 120000);

  it("parseGoModData", async () => {
    process.env.GO_FETCH_VCS = "false";
    let retMap = await parseGoModData(null);
    assert.deepStrictEqual(retMap, {});
    const gosumMap = {
      "google.golang.org/grpc@v1.21.0":
        "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
      "github.com/spf13/cobra@v1.0.0":
        "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "github.com/spf13/viper@v1.3.0":
        "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "github.com/stretchr/testify@v1.6.1":
        "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
    };
    retMap = await parseGoModData(
      readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
      gosumMap,
    );
    assert.deepStrictEqual(retMap.pkgList.length, 6);
    // Doesn't reliably work in CI/CD due to rate limiting.
    /*
    assert.deepStrictEqual(retMap.pkgList, [
      {
        group: "",
        name: "github.com/aws/aws-sdk-go",
        version: "v1.38.47",
        _integrity: "sha256-fake-sha-for-aws-go-sdk=",
        purl: "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        "bom-ref": "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/aws/aws-sdk-go",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/cobra",
        version: "v1.0.0",
        _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
        purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
        "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/cobra",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.0.2",
        purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/viper",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.3.0",
        _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
        purl: "pkg:golang/github.com/spf13/viper@v1.3.0",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.3.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/spf13/viper",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.21.0",
        _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
        purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/grpc/grpc-go",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.32.0",
        purl: "pkg:golang/google.golang.org/grpc@v1.32.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.32.0",
        externalReferences: [
          {
            type: "vcs",
            url: "https://github.com/grpc/grpc-go",
          },
        ],
      },
    ]);
    */

    retMap.pkgList.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
    retMap = await parseGoModData(
      readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
      name: "github.com/sqreen/go-dvwa",
      purl: "pkg:golang/github.com/sqreen/go-dvwa",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 19);
    assert.deepStrictEqual(retMap.rootList.length, 4);
    retMap = await parseGoModData(
      readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/anchore/syft",
      name: "github.com/anchore/syft",
      purl: "pkg:golang/github.com/anchore/syft",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 236);
    assert.deepStrictEqual(retMap.rootList.length, 81);
  }, 120000);
});

describe("go vendor modules tests", () => {
  it("parseGoModulesTxt", async () => {
    const gosumMap = {
      "cel.dev/expr@v0.18.0":
        "sha256-CJ6drgk+Hf96lkLikr4rFf19WrU0BOWEihyZnI2TAzo=",
      "github.com/AdaLogics/go-fuzz-headers@v0.0.0-20230811130428-ced1acdcaa24":
        "sha256-bvDV9vkmnHYOMsOr4WLk+Vo07yKIzd94sVoIqshQ4bU=",
      "github.com/Azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161":
        "sha256-L/gRVlceqvL25UVaW/CKtUDjefjrs0SPonmDGUVOYP0=",
    };
    const pkgList = await parseGoModulesTxt(
      "./test/data/modules.txt",
      gosumMap,
    );
    // 211 vendored modules. The 212th module line is the record go mod
    // vendor writes for the wildcard replace of github.com/openshift/api,
    // which names no vendored module.
    assert.deepStrictEqual((await pkgList).length, 211);
    assert.ok(pkgList.every((c) => c.version && !c.purl.includes("%3D%3E")));
  });
});

describe("go data with licenses", () => {
  it(() => {
    process.env.FETCH_LICENSE = "true";
  });
  test.skip("parseGoSumData with licenses", async () => {
    let dep_list = await parseGosumData(null);
    assert.deepStrictEqual(dep_list, []);
    dep_list = await parseGosumData(
      readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
    );
    assert.deepStrictEqual(dep_list.length, 4);
    assert.deepStrictEqual(dep_list[0], {
      group: "",
      name: "google.golang.org/grpc",
      version: "v1.21.0",
      _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
      purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
      license: [
        {
          id: "Apache-2.0",
          url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[1], {
      group: "",
      name: "github.com/spf13/cobra",
      version: "v1.0.0",
      _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
      purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
      license: [
        {
          id: "Apache-2.0",
          url: "https://pkg.go.dev/github.com/spf13/cobra?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[2], {
      group: "",
      name: "github.com/spf13/viper",
      version: "v1.0.2",
      _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
      purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
      license: [
        {
          id: "MIT",
          url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
        },
      ],
    });
    assert.deepStrictEqual(dep_list[3], {
      group: "",
      name: "github.com/stretchr/testify",
      version: "v1.6.1",
      _integrity: "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
      "bom-ref": "pkg:golang/github.com/stretchr/testify@v1.6.1",
      purl: "pkg:golang/github.com/stretchr/testify@v1.6.1",
      license: [
        {
          id: "MIT",
          url: "https://pkg.go.dev/github.com/stretchr/testify?tab=licenses",
        },
      ],
    });
    dep_list.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
  }, 120000);

  test.skip("parseGoModData with licenses", async () => {
    let retMap = await parseGoModData(null);
    assert.deepStrictEqual(retMap, {});
    const gosumMap = {
      "google.golang.org/grpc@v1.21.0":
        "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
      "github.com/aws/aws-sdk-go@v1.38.47": "sha256-fake-sha-for-aws-go-sdk=",
      "github.com/spf13/cobra@v1.0.0":
        "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
      "github.com/spf13/viper@v1.3.0":
        "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
      "github.com/stretchr/testify@v1.6.1":
        "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
    };
    retMap = await parseGoModData(
      readFileSync("./test/gomod/go.mod", { encoding: "utf-8" }),
      gosumMap,
    );
    assert.deepStrictEqual(retMap.pkgList.length, 6);
    assert.deepStrictEqual(retMap.pkgList, [
      {
        group: "",
        name: "github.com/aws/aws-sdk-go",
        version: "v1.38.47",
        _integrity: "sha256-fake-sha-for-aws-go-sdk=",
        purl: "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        "bom-ref": "pkg:golang/github.com/aws/aws-sdk-go@v1.38.47",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/github.com/aws/aws-sdk-go?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/cobra",
        version: "v1.0.0",
        _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
        purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
        "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/github.com/spf13/cobra?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.0.2",
        purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
        license: [
          {
            id: "MIT",
            url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "github.com/spf13/viper",
        version: "v1.3.0",
        _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
        purl: "pkg:golang/github.com/spf13/viper@v1.3.0",
        "bom-ref": "pkg:golang/github.com/spf13/viper@v1.3.0",
        license: [
          {
            id: "MIT",
            url: "https://pkg.go.dev/github.com/spf13/viper?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.21.0",
        _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
        purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
          },
        ],
      },
      {
        group: "",
        name: "google.golang.org/grpc",
        version: "v1.32.0",
        purl: "pkg:golang/google.golang.org/grpc@v1.32.0",
        "bom-ref": "pkg:golang/google.golang.org/grpc@v1.32.0",
        license: [
          {
            id: "Apache-2.0",
            url: "https://pkg.go.dev/google.golang.org/grpc?tab=licenses",
          },
        ],
      },
    ]);

    retMap.pkgList.forEach((d) => {
      assert.deepStrictEqual(d.license);
    });
    retMap = await parseGoModData(
      readFileSync("./test/data/go-dvwa.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
      name: "github.com/sqreen/go-dvwa",
      purl: "pkg:golang/github.com/sqreen/go-dvwa",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 19);
    assert.deepStrictEqual(retMap.rootList.length, 4);
    retMap = await parseGoModData(
      readFileSync("./test/data/go-syft.mod", { encoding: "utf-8" }),
      {},
    );
    assert.deepStrictEqual(retMap.parentComponent, {
      "bom-ref": "pkg:golang/github.com/anchore/syft",
      name: "github.com/anchore/syft",
      purl: "pkg:golang/github.com/anchore/syft",
      type: "application",
    });
    assert.deepStrictEqual(retMap.pkgList.length, 236);
    assert.deepStrictEqual(retMap.rootList.length, 81);
  }, 120000);
  it(() => {
    delete process.env.FETCH_LICENSE;
  });
});

it("parse go list dependencies", async () => {
  let retMap = await parseGoListDep(
    readFileSync("./test/data/golist-dep.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.pkgList.length, 4);
  assert.deepStrictEqual(retMap.pkgList[0], {
    group: "",
    name: "github.com/gorilla/mux",
    "bom-ref": "pkg:golang/github.com/gorilla/mux@v1.7.4",
    purl: "pkg:golang/github.com/gorilla/mux@v1.7.4",
    version: "v1.7.4",
    _integrity: undefined,
    license: undefined,
    scope: "required",
    properties: [
      {
        name: "internal:SrcGoMod",
        value:
          "/home/almalinux/go/pkg/mod/cache/download/github.com/gorilla/mux/@v/v1.7.4.mod",
      },
      { name: "internal:ModuleGoVersion", value: "1.12" },
      {
        name: "cdx:go:indirect",
        value: "false",
      },
    ],
  });
  retMap = await parseGoListDep(
    readFileSync("./test/data/golist-dep3.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(retMap.pkgList.length, 291);
});

it("parse go mod graph", async () => {
  let retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-graph.txt", { encoding: "utf-8" }),
    undefined,
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.pkgList.length, 536);
  // No go.mod here, so every version in the graph is retained. Single-segment
  // module paths like this one are valid golang purls as of cdx-purl 0.0.4 (0.0.3
  // rejected them for lacking a namespace), so the bom-ref is purl-derived and
  // must stay unique across the eight versions of this module that the graph
  // names.
  // Looked up by identity rather than by index: components are sorted by bom-ref,
  // so an index assertion silently tracks sort order instead of the parse result.
  assert.deepStrictEqual(
    retMap.pkgList.find(
      (c) => c.name === "go.opencensus.io" && c.version === "v0.21.0",
    ),
    {
      _integrity: undefined,
      "bom-ref": "pkg:golang/go.opencensus.io@v0.21.0",
      group: "",
      license: undefined,
      name: "go.opencensus.io",
      purl: "pkg:golang/go.opencensus.io@v0.21.0",
      version: "v0.21.0",
    },
  );
  const graphRefs = retMap.pkgList.map((c) => c["bom-ref"]);
  assert.deepStrictEqual(
    new Set(graphRefs).size,
    graphRefs.length,
    "bom-refs must be unique even when several versions of one module appear",
  );
  retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-dvwa-graph.txt", { encoding: "utf-8" }),
    "./test/data/go-dvwa.mod",
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/sqreen/go-dvwa",
    name: "github.com/sqreen/go-dvwa",
    purl: "pkg:golang/github.com/sqreen/go-dvwa",
    type: "application",
  });
  assert.deepStrictEqual(retMap.pkgList.length, 19);
  assert.deepStrictEqual(retMap.rootList.length, 4);
  retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-syft-graph.txt", { encoding: "utf-8" }),
    "./test/data/go-syft.mod",
    {},
    [],
    {},
  );
  assert.deepStrictEqual(retMap.parentComponent, {
    "bom-ref": "pkg:golang/github.com/anchore/syft",
    name: "github.com/anchore/syft",
    purl: "pkg:golang/github.com/anchore/syft",
    type: "application",
  });
  // 235, not 242: the graph names eight versions of `go.opencensus.io`, but Go
  // minimal-version-selection builds exactly one (go.mod pins v0.24.0), and the
  // parser emits one component per module. An earlier revision emitted all
  // eight sharing the bom-ref `go.opencensus.io`, which both inflated this
  // count and broke bom-ref uniqueness. The count is unchanged by the cdx-purl
  // 0.0.4 upgrade — that only restored these modules' purls, it did not change
  // how many components exist.
  assert.deepStrictEqual(retMap.pkgList.length, 235);
  const goModuleNames = retMap.pkgList.map((c) =>
    c.group ? `${c.group}/${c.name}` : c.name,
  );
  assert.deepStrictEqual(
    new Set(goModuleNames).size,
    goModuleNames.length,
    "each go module must appear exactly once",
  );
  const goRefs = retMap.pkgList.map((c) => c["bom-ref"]);
  assert.deepStrictEqual(
    new Set(goRefs).size,
    goRefs.length,
    "bom-refs must be unique, including for modules with no valid purl",
  );
  assert.deepStrictEqual(retMap.rootList.length, 81);
});

// #4497 — the production driver resolves `go list` first and passes its
// package list and parent component to parseGoModGraph, which then filters
// `go mod graph` lines against them. The graph is the requirement graph, so
// an edge routinely names a version older than the one MVS selected
// (go-colorable@v0.1.13 while v0.1.14 was selected): such an edge must be
// rewritten to the selected version, not dropped.
it("parse go mod graph rewrites drifted target versions to the selected ones", async () => {
  const listMap = await parseGoListDep(
    readFileSync("./test/data/golist-drift.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(listMap.pkgList.length, 5);
  assert.deepStrictEqual(
    listMap.parentComponent?.purl,
    "pkg:golang/example.com/gotest",
  );
  const retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-drift-graph.txt", { encoding: "utf-8" }),
    "./test/data/go-drift.mod",
    {},
    listMap.pkgList,
    listMap.parentComponent,
  );
  const edges = {};
  for (const dep of retMap.dependenciesList) {
    edges[dep.ref] = dep.dependsOn;
  }
  // The main module depends on its direct requires only.
  assert.deepStrictEqual(
    (edges["pkg:golang/example.com/gotest"] || []).sort(),
    [
      "pkg:golang/github.com/fatih/color@v1.18.0",
      "pkg:golang/github.com/gorilla/mux@v1.8.1",
    ],
  );
  // The three drifted edges survive, pointing at the selected versions.
  assert.ok(
    (edges["pkg:golang/github.com/fatih/color@v1.18.0"] || []).includes(
      "pkg:golang/github.com/mattn/go-colorable@v0.1.14",
    ),
    "color -> go-colorable must be rewritten to the selected v0.1.14",
  );
  assert.ok(
    (edges["pkg:golang/github.com/fatih/color@v1.18.0"] || []).includes(
      "pkg:golang/golang.org/x/sys@v0.29.0",
    ),
    "color -> x/sys must be rewritten to the selected v0.29.0",
  );
  assert.ok(
    (edges["pkg:golang/github.com/mattn/go-isatty@v0.0.20"] || []).includes(
      "pkg:golang/golang.org/x/sys@v0.29.0",
    ),
    "go-isatty -> x/sys must be rewritten to the selected v0.29.0",
  );
  // Edges that already named the selected versions are untouched.
  assert.ok(
    (edges["pkg:golang/github.com/mattn/go-colorable@v0.1.14"] || []).includes(
      "pkg:golang/github.com/mattn/go-isatty@v0.0.20",
    ),
  );
  // The go@/toolchain@ pseudo-modules stay excluded, and every edge points
  // at a component the run actually emits.
  const knownRefs = new Set([
    ...retMap.pkgList.map((c) => c["bom-ref"]),
    "pkg:golang/example.com/gotest",
  ]);
  for (const dep of retMap.dependenciesList) {
    assert.ok(
      knownRefs.has(dep.ref),
      `dependency ref ${dep.ref} must name a known component`,
    );
    for (const target of dep.dependsOn) {
      assert.ok(
        knownRefs.has(target),
        `dependency target ${target} must name a known component`,
      );
    }
  }
  assert.ok(!knownRefs.has("pkg:golang/go@1.24"));
  assert.ok(!knownRefs.has("pkg:golang/toolchain@go1.24"));
});

// #4497, root variant — an untidy go.mod can name a direct require at an
// older version than the one MVS selected. The root edge is rewritten to the
// selected version and must still count as a direct dependency: the by-ref
// map only knows the stale bom-ref from the go.mod text.
it("parse go mod graph keeps a root edge whose direct require drifted", async () => {
  const listMap = await parseGoListDep(
    readFileSync("./test/data/golist-drift.txt", { encoding: "utf-8" }),
    {},
  );
  const retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-drift-root-graph.txt", {
      encoding: "utf-8",
    }),
    "./test/data/go-drift-untidy.mod",
    {},
    listMap.pkgList,
    listMap.parentComponent,
  );
  const rootEdges = retMap.dependenciesList.find(
    (dep) => dep.ref === "pkg:golang/example.com/gotest",
  );
  assert.ok(rootEdges, "the main module must have a dependencies entry");
  assert.deepStrictEqual([...rootEdges.dependsOn].sort(), [
    "pkg:golang/github.com/fatih/color@v1.18.0",
    "pkg:golang/github.com/gorilla/mux@v1.8.1",
  ]);
});

it("parse go mod why dependencies", () => {
  let pkg_name = parseGoModWhy(
    readFileSync("./test/data/gomodwhy.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(pkg_name, "github.com/mailgun/mailgun-go/v4");
  pkg_name = parseGoModWhy(
    readFileSync("./test/data/gomodwhynot.txt", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(pkg_name, undefined);
});

it("detects go mod why output for a module the main module does not need", () => {
  assert.strictEqual(
    isGoModWhyNotNeeded(
      readFileSync("./test/data/gomodwhynot.txt", { encoding: "utf-8" }),
    ),
    true,
  );
  assert.strictEqual(
    isGoModWhyNotNeeded(
      "# github.com/x/a\r\n(main module does not need module github.com/x/a)\r\n",
    ),
    true,
  );
  assert.strictEqual(
    isGoModWhyNotNeeded(
      readFileSync("./test/data/gomodwhy.txt", { encoding: "utf-8" }),
    ),
    false,
  );
  assert.strictEqual(isGoModWhyNotNeeded(undefined), false);
});

it("parseGoModData for multiple modules with root priority", async () => {
  // Test parsing multiple go.mod files to ensure proper component hierarchy
  const rootModData = readFileSync("./test/data/multimodule-root.mod", {
    encoding: "utf-8",
  });
  const subModData = readFileSync("./test/data/multimodule-sub.mod", {
    encoding: "utf-8",
  });
  const deepModData = readFileSync("./test/data/multimodule-deep.mod", {
    encoding: "utf-8",
  });

  const rootResult = await parseGoModData(rootModData, {});
  const subResult = await parseGoModData(subModData, {});
  const deepResult = await parseGoModData(deepModData, {});

  // Root module should be identified correctly
  assert.deepStrictEqual(
    rootResult.parentComponent.name,
    "github.com/example/root-project",
  );
  assert.deepStrictEqual(rootResult.parentComponent.type, "application");

  // Sub modules should also be parsed correctly
  assert.deepStrictEqual(
    subResult.parentComponent.name,
    "github.com/example/root-project/submodule",
  );
  assert.deepStrictEqual(
    deepResult.parentComponent.name,
    "github.com/example/root-project/deep/nested",
  );

  // In the fixed logic, the root should take priority over sub-modules
  // This test verifies the parsing works correctly for each individual module
}, 10000);

it("parseGopkgData", async () => {
  let dep_list = await parseGopkgData(null);
  assert.deepStrictEqual(dep_list, []);
  dep_list = await parseGopkgData(
    readFileSync("./test/gopkg/Gopkg.lock", { encoding: "utf-8" }),
  );
  // Every [[projects]] entry, the last one included.
  assert.deepStrictEqual(dep_list.length, 37);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "cloud.google.com/go",
    version: "v0.39.0",
    _integrity: "sha256-LKUyprxlVmM0QAS6ECQ20pAxAY6rI2JHZ42x2JeGJ78=",
  });
  assert.deepStrictEqual(dep_list[36], {
    group: "",
    name: "pack.ag/amqp",
    version: "v0.11.0",
    _integrity: "sha256-Imd95Nt5Ae7e/Fd7hOqMBhwvVTFVEyKgkq1+Gt7k0xw=",
  });
  dep_list.forEach((d) => {
    assert.deepStrictEqual(d.license);
  });
}, 120000);

it("parse go version data", async () => {
  let dep_list = await parseGoVersionData(
    readFileSync("./test/data/goversion.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(dep_list.length, 125);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "github.com/ShiftLeftSecurity/atlassian-connect-go",
    "bom-ref":
      "pkg:golang/github.com/shiftleftsecurity/atlassian-connect-go@v0.0.2",
    purl: "pkg:golang/github.com/shiftleftsecurity/atlassian-connect-go@v0.0.2",
    version: "v0.0.2",
    _integrity: "",
    license: undefined,
  });
  dep_list = await parseGoVersionData(
    readFileSync("./test/data/goversion2.txt", { encoding: "utf-8" }),
    {},
  );
  assert.deepStrictEqual(dep_list.length, 149);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "cloud.google.com/go",
    "bom-ref": "pkg:golang/cloud.google.com/go@v0.79.0",
    purl: "pkg:golang/cloud.google.com/go@v0.79.0",
    version: "v0.79.0",
    _integrity: "sha256-oqqswrt4x6b9OGBnNqdssxBl1xf0rSUNjU2BR4BZar0=",
    license: undefined,
  });
});

it("the go.mod parser resolves every module in one batched round", async () => {
  const esmock = (await import("esmock")).default;
  const seen = [];
  // ecosystems.js is a dependency of parsers-go.js, not of utils.js, so the
  // mock belongs in the global slot; passing it as a direct mock silently does
  // nothing.
  const { parseGoModData: mockedParseGoModData } = await esmock(
    "./utils.js",
    {},
    {
      "./ecosystems.js": {
        prefetchGoPkgMetadata: async (modules) => {
          seen.push(modules.map((m) => m.name));
        },
      },
    },
  );
  const goMod = `module github.com/example/app

go 1.23

require (
	github.com/spf13/cobra v1.0.0
	google.golang.org/grpc v1.21.0 // indirect
)

replace github.com/spf13/viper => github.com/spf13/viper v1.3.0
`;
  const retMap = await mockedParseGoModData(goMod, {});
  // One call, before any component is built, carrying every module the loop
  // goes on to resolve — required, indirect and replacement alike.
  assert.strictEqual(seen.length, 1);
  assert.deepStrictEqual(seen[0], [
    "github.com/spf13/cobra",
    "google.golang.org/grpc",
    "github.com/spf13/viper",
  ]);
  // The two-pass split must not disturb the component list or the scopes.
  assert.strictEqual(retMap.pkgList.length, 3);
  assert.strictEqual(
    retMap.pkgList.find((p) => p.name === "google.golang.org/grpc").scope,
    "optional",
  );
  assert.deepStrictEqual(
    retMap.rootList.map((p) => p.name).sort(),
    ["github.com/spf13/cobra", "github.com/spf13/viper"].sort(),
  );
  assert.strictEqual(retMap.parentComponent.name, "github.com/example/app");
});

it("parse go mod graph keeps +incompatible edges of mixed-case module paths", async () => {
  // `go mod graph` prints versions unescaped. The components carry the
  // canonical, lower-cased golang purl, so the graph tokens must be read the
  // same way or the edge to github.com/Knetic/govaluate is silently dropped.
  const knetic =
    "pkg:golang/github.com/knetic/govaluate@v3.0.1-0.20171022003610-9aa49832a739+incompatible";
  const jwt = "pkg:golang/github.com/dgrijalva/jwt-go@v3.2.0+incompatible";
  const retMap = await parseGoModGraph(
    readFileSync("./test/data/gomod-incompatible/graph.txt", {
      encoding: "utf-8",
    }),
    "./test/data/gomod-incompatible/go.mod",
    {},
    [{ "bom-ref": knetic }, { "bom-ref": jwt }],
    { "bom-ref": "pkg:golang/example.com/goupper" },
  );
  const rootDeps = retMap.dependenciesList.find(
    (d) => d.ref === "pkg:golang/example.com/goupper",
  );
  assert.deepStrictEqual(rootDeps?.dependsOn?.sort(), [jwt, knetic].sort());
  const govaluate = retMap.pkgList.find((c) => c["bom-ref"] === knetic);
  assert.ok(govaluate, "the module must be a component");
  assert.strictEqual(
    govaluate.purl,
    "pkg:golang/github.com/knetic/govaluate@v3.0.1-0.20171022003610-9aa49832a739%2Bincompatible",
  );
  assert.strictEqual(
    govaluate.version,
    "v3.0.1-0.20171022003610-9aa49832a739+incompatible",
  );
});

// Real Go 1.27 output for one project, test/data/go-replace: a module replace
// (github.com/mholt/archiver/v3 v3.5.1 => github.com/anchore/archiver/v3
// v3.5.2), a directory replace (example.com/local => ./local), three replaces
// that change nothing (example.com/unused, a wildcard github.com/kr/pretty and
// a versioned github.com/pkg/errors v0.8.0), mixed-case module paths, and a
// requirement graph in which github.com/moby/term@v0.5.0 asks for an older
// github.com/Azure/go-ansiterm than the one selected.
describe("go replace directives and mixed-case module paths", () => {
  const GO_REPLACE = "./test/data/go-replace";
  const fixture = (file) => readFileSync(join(GO_REPLACE, file), "utf-8");
  const gosumMap = () => parseGosumHashes(fixture("go.sum"));
  const listOutput = (file = "go-list-deps.txt") =>
    fixture(file)
      .replaceAll("<PROJECT>", "/project")
      .replaceAll("<GOMODCACHE>", "/gomodcache");
  const propertyOf = (component, name) =>
    component?.properties?.find((p) => p.name === name)?.value;
  // The modules the binary holds, as `go version -m` lists them.
  const BUILT = [
    "pkg:golang/example.com/local",
    "pkg:golang/github.com/anchore/archiver/v3@v3.5.2",
    "pkg:golang/github.com/andybalholm/brotli@v1.0.1",
    "pkg:golang/github.com/azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161",
    "pkg:golang/github.com/burntsushi/toml@v1.3.2",
    "pkg:golang/github.com/dsnet/compress@v0.0.2-0.20210315054119-f66993602bf5",
    "pkg:golang/github.com/golang/snappy@v0.0.2",
    "pkg:golang/github.com/klauspost/compress@v1.11.4",
    "pkg:golang/github.com/klauspost/pgzip@v1.2.5",
    "pkg:golang/github.com/moby/term@v0.5.0",
    "pkg:golang/github.com/nwaples/rardecode@v1.1.0",
    "pkg:golang/github.com/pierrec/lz4/v4@v4.1.2",
    "pkg:golang/github.com/ulikunitz/xz@v0.5.9",
    "pkg:golang/github.com/xi2/xz@v0.0.0-20171230120015-48954b6210f8",
    "pkg:golang/golang.org/x/sys@v0.1.0",
  ];
  const ARCHIVER_SUM = "sha256-Bjemm2NzuRhmHy3m0lRe5tNoClB9A4zYyDV58PaB6aA=";
  // A module replacement is reported as the module Go builds, with its
  // checksum, and names the module it replaces. A directory replacement keeps
  // the module path, has no version, and names its directory.
  const assertReplacements = (pkgList) => {
    const archiver = pkgList.find(
      (c) => c.name === "github.com/anchore/archiver/v3",
    );
    assert.strictEqual(archiver.version, "v3.5.2");
    assert.strictEqual(archiver._integrity, ARCHIVER_SUM);
    assert.strictEqual(
      propertyOf(archiver, "cdx:go:replaces"),
      "github.com/mholt/archiver/v3@v3.5.1",
    );
    assert.ok(!pkgList.some((c) => c.name === "github.com/mholt/archiver/v3"));
    const local = pkgList.find((c) => c.name === "example.com/local");
    assert.strictEqual(local.version, undefined);
    assert.strictEqual(local.purl, "pkg:golang/example.com/local");
    assert.strictEqual(propertyOf(local, "cdx:go:local_dir"), "./local");
    assert.strictEqual(
      propertyOf(local, "cdx:go:replaces"),
      "example.com/local@v0.0.0",
    );
  };

  it("parseGoModulesTxt reads only the vendored modules, as Go builds them", async () => {
    const pkgList = await parseGoModulesTxt(
      join(GO_REPLACE, "vendor/modules.txt"),
      gosumMap(),
    );
    // The `# path => replacement` records go mod vendor writes for every
    // replace directive name no vendored module.
    assert.deepStrictEqual(pkgList.map((c) => c["bom-ref"]).sort(), BUILT);
    assertReplacements(pkgList);
  });

  it("parseGoModulesTxt reads a CRLF checkout like the file go mod vendor wrote", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cdxgen-go-crlf-"));
    try {
      mkdirSync(join(scratch, "vendor"));
      writeFileSync(
        join(scratch, "vendor", "modules.txt"),
        fixture("vendor/modules.txt")
          .replaceAll("\r\n", "\n")
          .replaceAll("\n", "\r\n"),
      );
      const pkgList = await parseGoModulesTxt(
        join(scratch, "vendor", "modules.txt"),
        gosumMap(),
      );
      assert.deepStrictEqual(pkgList.map((c) => c["bom-ref"]).sort(), BUILT);
      const toml = pkgList.find((c) => c.name === "github.com/BurntSushi/toml");
      assert.strictEqual(toml.version, "v1.3.2");
      assert.strictEqual(
        toml._integrity,
        "sha256-o7IhLm0Msx3BaB+n3Ag7L8EVlByGnpq14C4YWiu/gL8=",
      );
      assert.strictEqual(toml.scope, "required");
    } finally {
      rmSync(scratch, { force: true, recursive: true });
    }
  });

  it("parseGoListDep reports the replacement and the module content checksum", async () => {
    const { parentComponent, pkgList } = await parseGoListDep(
      listOutput(),
      {},
      { mainModuleDir: "/project" },
    );
    assert.strictEqual(parentComponent.name, "example.com/app");
    assert.deepStrictEqual(pkgList.map((c) => c["bom-ref"]).sort(), BUILT);
    assertReplacements(pkgList);
    // The hash is Module.Sum, the checksum of the module content, not
    // GoModSum, the checksum of its go.mod file.
    const toml = pkgList.find((c) => c.name === "github.com/BurntSushi/toml");
    assert.strictEqual(
      toml._integrity,
      "sha256-o7IhLm0Msx3BaB+n3Ag7L8EVlByGnpq14C4YWiu/gL8=",
    );
    // Only the directory replacement is local; the module cache directory
    // go list reports for every other module is not a replacement.
    assert.deepStrictEqual(
      pkgList
        .filter((c) => propertyOf(c, "cdx:go:local_dir"))
        .map((c) => c.name),
      ["example.com/local"],
    );
    assert.strictEqual(
      propertyOf(parentComponent, "cdx:go:local_dir"),
      undefined,
    );
    // With a vendor directory go list prints no checksums; go.sum has them.
    const vendored = await parseGoListDep(
      listOutput("go-list-deps-vendor.txt"),
      gosumMap(),
      { mainModuleDir: "/project" },
    );
    assert.deepStrictEqual(
      vendored.pkgList.map((c) => c["bom-ref"]).sort(),
      BUILT,
    );
    assertReplacements(vendored.pkgList);
  });

  it("parseGoVersionData reports what a replace directive put in the binary", async () => {
    const pkgList = await parseGoVersionData(fixture("go-version-m.txt"));
    assert.deepStrictEqual(pkgList.map((c) => c["bom-ref"]).sort(), BUILT);
    assertReplacements(pkgList);
  });

  it("parseGosumData hashes the module content and leaves graph-only versions unhashed", async () => {
    const pkgList = await parseGosumData(fixture("go.sum"));
    const sys = (version) =>
      pkgList.find(
        (c) => c.name === "golang.org/x/sys" && c.version === version,
      );
    assert.strictEqual(
      sys("v0.1.0")._integrity,
      "sha256-kunALQeHf1/185U1i0GOB/fy1IPRDDpuoOOqRReG57U=",
    );
    // Only the go.mod of this version was needed to select versions.
    assert.strictEqual(
      sys("v0.0.0-20210616094352-59db8d763f22")._integrity,
      undefined,
    );
  });

  it("parseGoModGraph keeps the edges of mixed-case and replaced modules", async () => {
    const listMap = await parseGoListDep(listOutput(), gosumMap(), {
      mainModuleDir: "/project",
    });
    const retMap = await parseGoModGraph(
      fixture("go-mod-graph.txt"),
      join(GO_REPLACE, "go.mod"),
      gosumMap(),
      listMap.pkgList,
      listMap.parentComponent,
    );
    const edges = Object.fromEntries(
      retMap.dependenciesList.map((d) => [d.ref, d.dependsOn]),
    );
    // The main module depends on what Go builds for each direct requirement.
    assert.deepStrictEqual(edges["pkg:golang/example.com/app"], [
      "pkg:golang/example.com/local",
      "pkg:golang/github.com/anchore/archiver/v3@v3.5.2",
      "pkg:golang/github.com/azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161",
      "pkg:golang/github.com/burntsushi/toml@v1.3.2",
      "pkg:golang/github.com/moby/term@v0.5.0",
    ]);
    // moby/term asks for go-ansiterm v0.0.0-20210617225240-d185dfc1b5a1; the
    // edge points at the version selected for the mixed-case module path.
    assert.ok(
      edges["pkg:golang/github.com/moby/term@v0.5.0"].includes(
        "pkg:golang/github.com/azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161",
      ),
    );
    // The graph names the replaced module; its requirements hang off the
    // replacement.
    assert.ok(
      edges["pkg:golang/github.com/anchore/archiver/v3@v3.5.2"].includes(
        "pkg:golang/github.com/ulikunitz/xz@v0.5.9",
      ),
    );
    const knownRefs = new Set([
      ...listMap.pkgList.map((c) => c["bom-ref"]),
      listMap.parentComponent["bom-ref"],
    ]);
    for (const dep of retMap.dependenciesList) {
      assert.ok(knownRefs.has(dep.ref), dep.ref);
      for (const target of dep.dependsOn) {
        assert.ok(knownRefs.has(target), target);
      }
    }
    // A component the graph builds keeps the module path as Go prints it,
    // which the module cache and pkg.go.dev are addressed by.
    assert.strictEqual(
      retMap.pkgList.find(
        (c) => c["bom-ref"] === "pkg:golang/github.com/burntsushi/toml@v1.3.2",
      ).name,
      "github.com/BurntSushi/toml",
    );
  });

  it("parseGoModGraph maps replaced modules from go.mod when go list gave nothing", async () => {
    const retMap = await parseGoModGraph(
      fixture("go-mod-graph.txt"),
      join(GO_REPLACE, "go.mod"),
      gosumMap(),
      [],
      {},
    );
    const root = retMap.dependenciesList.find(
      (d) => d.ref === "pkg:golang/example.com/app",
    );
    assert.deepStrictEqual(root.dependsOn, [
      "pkg:golang/example.com/local",
      "pkg:golang/github.com/anchore/archiver/v3@v3.5.2",
      "pkg:golang/github.com/azure/go-ansiterm@v0.0.0-20230124172434-306776ec8161",
      "pkg:golang/github.com/burntsushi/toml@v1.3.2",
      "pkg:golang/github.com/moby/term@v0.5.0",
    ]);
    assertReplacements(retMap.pkgList);
  });

  it("parseGoModGraph keeps a mixed-case root edge whose go.mod require drifted", async () => {
    // go list refuses this untidy go.mod ("updates to go.mod needed"), so
    // createGoBom reads go mod graph alone, which names the root's
    // requirement at the version MVS selected rather than the one go.mod
    // names.
    const retMap = await parseGoModGraph(
      fixture("untidy/go-mod-graph.txt"),
      join(GO_REPLACE, "untidy", "go.mod"),
      {},
      [],
      {},
    );
    const root = retMap.dependenciesList.find(
      (d) => d.ref === "pkg:golang/example.com/untidy",
    );
    assert.deepStrictEqual(root.dependsOn, [
      "pkg:golang/github.com/azure/go-ansiterm@v0.0.0-20250102033503-faa5f7b0171c",
      "pkg:golang/github.com/moby/term@v0.5.2",
    ]);
    assert.strictEqual(
      retMap.pkgList.find((c) => c.purl?.includes("go-ansiterm")).name,
      "github.com/Azure/go-ansiterm",
    );
  });

  it("parseGoListDep takes the parent from the go.work member go list ran in", async () => {
    // go list -deps ./... run in member a prints a, then member b, which a
    // imports, then a again. Both are main modules.
    const output = fixture("workspace/a-go-list-deps.txt")
      .replaceAll("<WORKSPACE>", "/ws")
      .replaceAll("<GOMODCACHE>", "/gomodcache");
    const fromA = await parseGoListDep(output, {}, { mainModuleDir: "/ws/a" });
    assert.strictEqual(fromA.parentComponent.name, "example.com/a");
    assert.deepStrictEqual(
      fromA.pkgList.map((c) => c.name),
      ["github.com/BurntSushi/toml"],
    );
    assert.deepStrictEqual(
      fromA.workspaceModules.map((c) => c.name),
      ["example.com/b"],
    );
    const fromB = await parseGoListDep(output, {}, { mainModuleDir: "/ws/b" });
    assert.strictEqual(fromB.parentComponent.name, "example.com/b");
    assert.deepStrictEqual(
      fromB.workspaceModules.map((c) => c.name),
      ["example.com/a"],
    );
    // go mod graph in a workspace prints the edges of every member. When
    // another member is the parent, it is not listed as a component too.
    const graph = await parseGoModGraph(
      fixture("workspace/a-go-mod-graph.txt"),
      join(GO_REPLACE, "workspace", "a", "go.mod"),
      {},
      fromA.pkgList,
      fromB.parentComponent,
    );
    assert.deepStrictEqual(
      graph.pkgList.map((c) => c["bom-ref"]),
      ["pkg:golang/github.com/burntsushi/toml@v1.3.2"],
    );
    assert.deepStrictEqual(graph.dependenciesList, [
      {
        ref: "pkg:golang/example.com/b",
        dependsOn: ["pkg:golang/github.com/burntsushi/toml@v1.3.2"],
      },
      { ref: "pkg:golang/github.com/burntsushi/toml@v1.3.2", dependsOn: [] },
    ]);
  });
});

describe("parseGoModGraph() replace directives", () => {
  it("keeps the precedence of replace directives", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "cdxgen-go-replace-order-"));
    try {
      const goModFile = join(tmpDir, "go.mod");
      writeFileSync(
        goModFile,
        `module example.com/app

go 1.21

require example.com/a v1.0.0

replace example.com/a v1.0.0 => example.com/first v2.0.0

replace example.com/a v1.0.0 => example.com/second v3.0.0

replace example.com/a => example.com/any v4.0.0

replace example.com/a => example.com/last v5.0.0
`,
      );
      const retMap = await parseGoModGraph(
        [
          "example.com/app example.com/a@v1.0.0",
          "example.com/app example.com/a@v1.1.0",
        ].join("\n"),
        goModFile,
        {},
        [],
        {},
      );
      // The first directive for a version wins, and otherwise the last one
      // for every version.
      assert.deepStrictEqual(
        retMap.dependenciesList.find(
          (dep) => dep.ref === "pkg:golang/example.com/app",
        ).dependsOn,
        [
          "pkg:golang/example.com/first@v2.0.0",
          "pkg:golang/example.com/last@v5.0.0",
        ],
      );
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
