import { readFileSync } from "node:fs";
import process from "node:process";

import { assert, describe, it, test } from "poku";

import { isGoModWhyNotNeeded } from "./parsers-go.js";
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
  assert.deepStrictEqual(retMap.pkgList.length, 239);
  assert.deepStrictEqual(retMap.rootList.length, 84);
}, 120000);

it("parseGoSumData", async () => {
  let dep_list = await parseGosumData(null);
  assert.deepStrictEqual(dep_list, []);
  dep_list = await parseGosumData(
    readFileSync("./test/gomod/go.sum", { encoding: "utf-8" }),
  );
  assert.deepStrictEqual(dep_list.length, 4);
  assert.deepStrictEqual(dep_list[0], {
    group: "",
    name: "google.golang.org/grpc",
    license: undefined,
    version: "v1.21.0",
    _integrity: "sha256-oYelfM1adQP15Ek0mdvEgi9Df8B9CZIaU1084ijfRaM=",
    "bom-ref": "pkg:golang/google.golang.org/grpc@v1.21.0",
    purl: "pkg:golang/google.golang.org/grpc@v1.21.0",
  });
  assert.deepStrictEqual(dep_list[1], {
    group: "",
    name: "github.com/spf13/cobra",
    license: undefined,
    version: "v1.0.0",
    _integrity: "sha256-/6GTrnGXV9HjY+aR4k0oJ5tcvakLuG6EuKReYlHNrgE=",
    "bom-ref": "pkg:golang/github.com/spf13/cobra@v1.0.0",
    purl: "pkg:golang/github.com/spf13/cobra@v1.0.0",
  });
  assert.deepStrictEqual(dep_list[2], {
    group: "",
    name: "github.com/spf13/viper",
    license: undefined,
    version: "v1.0.2",
    _integrity: "sha256-A8kyI5cUJhb8N+3pkfONlcEcZbueH6nhAm0Fq7SrnBM=",
    "bom-ref": "pkg:golang/github.com/spf13/viper@v1.0.2",
    purl: "pkg:golang/github.com/spf13/viper@v1.0.2",
  });
  assert.deepStrictEqual(dep_list[3], {
    group: "",
    name: "github.com/stretchr/testify",
    license: undefined,
    version: "v1.6.1",
    _integrity: "sha256-6Fq8oRcR53rry900zMqJjRRixrwX3KX962/h/Wwjteg=",
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
    assert.deepStrictEqual(retMap.pkgList.length, 239);
    assert.deepStrictEqual(retMap.rootList.length, 84);
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
    assert.deepStrictEqual((await pkgList).length, 212);
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
    assert.deepStrictEqual(retMap.pkgList.length, 239);
    assert.deepStrictEqual(retMap.rootList.length, 84);
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
  assert.deepStrictEqual(retMap.rootList.length, 84);
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
