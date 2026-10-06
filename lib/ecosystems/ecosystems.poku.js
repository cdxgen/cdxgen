import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

import {
  getCratesMetadata,
  getDartMetadata,
  getMvnMetadata,
  getPyMetadata,
  guessPypiMatchingVersion,
  parseBdistMetadata,
  parsePom,
  readZipEntry,
} from "./utils.js";

/*
it("get maven metadata", async () => {
  let data = await utils.getMvnMetadata([
    {
      group: "com.squareup.okhttp3",
      name: "okhttp",
      version: "3.8.1",
    },
  ]);
  assert.deepStrictEqual(data, [
    {
      description: "",
      group: "com.squareup.okhttp3",
      name: "okhttp",
      version: "3.8.1",
    },
  ]);

  data = await utils.getMvnMetadata([
    {
      group: "com.fasterxml.jackson.core",
      name: "jackson-databind",
      version: "2.8.5",
    },
    {
      group: "com.github.jnr",
      name: "jnr-posix",
      version: "3.0.47",
    },
  ]);
  assert.deepStrictEqual(data, [
    {
      group: "com.fasterxml.jackson.core",
      name: "jackson-databind",
      version: "2.8.5",
      description:
        "General data-binding functionality for Jackson: works on core streaming API",
      repository: { url: "http://github.com/FasterXML/jackson-databind" },
    },
    {
      group: "com.github.jnr",
      name: "jnr-posix",
      version: "3.0.47",
      license: ["EPL-2.0", "GPL-2.0-only", "LGPL-2.1-only"],
      description: "\n    Common cross-project/cross-platform POSIX APIs\n  ",
      repository: { url: "git@github.com:jnr/jnr-posix.git" },
    },
  ]);
});
*/

it("get py metadata", async () => {
  const data = await getPyMetadata(
    [
      {
        group: "",
        name: "Flask",
        version: "1.1.0",
      },
    ],
    false,
  );
  assert.deepStrictEqual(data, [
    {
      group: "",
      name: "Flask",
      version: "1.1.0",
    },
  ]);
}, 240000);

it("get py metadata adds distribution external references", async () => {
  const agentGetStub = sinon.stub().resolves({
    body: {
      info: {
        author: "",
        author_email: "",
        classifiers: [],
        license: "",
        license_expression: "",
        name: "requests",
        summary: "HTTP client",
        version: "2.31.0",
      },
      releases: {
        "2.31.0": [
          {
            digests: { sha256: "abc123" },
            filename: "requests-2.31.0-py3-none-any.whl",
            packagetype: "bdist_wheel",
            url: "https://files.pythonhosted.org/packages/example/requests-2.31.0-py3-none-any.whl",
          },
          {
            digests: { sha256: "def456" },
            filename: "requests-2.31.0.tar.gz",
            packagetype: "sdist",
            url: "https://files.pythonhosted.org/packages/example/requests-2.31.0.tar.gz",
          },
        ],
      },
    },
  });
  // getPyMetadata prefetches, and the prefetch dispatches to the cdxrs
  // subprocess when the binary is present, bypassing this mock and reaching
  // the real PyPI. Pin the JS batch pool so every request goes through the
  // mocked cdxgenAgent and the assertions below describe the stub rather than
  // whatever PyPI is serving today.
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  process.env.CDXGEN_RS_DISABLE = "fetch";
  resetBatchFetchAvailability();
  let data;
  try {
    const { getPyMetadata: mockedGetPyMetadata } = await esmock(
      "./utils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGetStub }),
        },
      },
    );
    data = await mockedGetPyMetadata(
      [
        {
          externalReferences: [
            {
              type: "website",
              url: "https://example.com/requests",
            },
          ],
          group: "",
          name: "requests",
          version: "2.31.0",
        },
      ],
      true,
    );
  } finally {
    resetBatchFetchAvailability();
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
  }
  assert.strictEqual(data.length, 1);
  assert.ok(
    data[0].externalReferences?.some(
      (reference) => reference.type === "website",
    ),
  );
  assert.ok(
    data[0].externalReferences?.some(
      (reference) =>
        reference.type === "distribution" &&
        reference.url.endsWith(".whl") &&
        reference.comment === "requests-2.31.0-py3-none-any.whl",
    ),
  );
  assert.ok(
    data[0].externalReferences?.some(
      (reference) =>
        reference.type === "distribution" &&
        reference.url.endsWith(".tar.gz") &&
        reference.comment === "requests-2.31.0.tar.gz",
    ),
  );
});

it("get crates metadata", async () => {
  const dep_list = await getCratesMetadata([
    {
      group: "",
      name: "abscissa_core",
      version: "0.5.2",
      _integrity:
        "sha256-6a07677093120a02583717b6dd1ef81d8de1e8d01bd226c83f0f9bdf3e56bb3a",
    },
  ]);
  assert.deepStrictEqual(dep_list.length, 1);
  assert.strictEqual(dep_list[0].group, "");
  assert.strictEqual(dep_list[0].name, "abscissa_core");
  assert.strictEqual(dep_list[0].version, "0.5.2");
  assert.strictEqual(dep_list[0].license, "Apache-2.0");
  assert.strictEqual(
    dep_list[0].distribution?.url,
    "https://crates.io/api/v1/crates/abscissa_core/0.5.2/download",
  );
  assert.ok(
    dep_list[0].properties.find(
      (property) => property.name === "cdx:cargo:crate_id",
    ),
  );
  assert.ok(
    dep_list[0].properties.find(
      (property) => property.name === "cdx:cargo:latest_version",
    ),
  );
  assert.ok(
    dep_list[0].properties.find(
      (property) => property.name === "cdx:cargo:versionCount",
    ),
  );
  assert.ok(
    dep_list[0].properties.find(
      (property) => property.name === "cdx:cargo:publishTime",
    ),
  );
}, 20000);

// This test is flaky
it("get dart metadata", async () => {
  const dep_list = await getDartMetadata([
    {
      group: "",
      name: "async",
      version: "2.11.0",
    },
  ]);
  assert.deepStrictEqual(dep_list.length, 1);
  assert.ok(dep_list[0]);
}, 120000);

it("get nget metadata", async () => {
  const dep_list = [
    {
      dependsOn: [
        "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
        "pkg:nuget/Microsoft.NETCore.App@2.1.0",
        "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
        "pkg:nuget/NLog@4.5.0",
        "pkg:nuget/NUnit.Console@3.11.1",
        "pkg:nuget/NUnit3TestAdapter@3.16.1",
        "pkg:nuget/NUnitLite@3.13.3",
        "pkg:nuget/PublicApiGenerator@10.1.2",
        "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
        "pkg:nuget/Serilog@3.0.1",
        "pkg:nuget/System.Net.NameResolution@4.3.0",
        "pkg:nuget/System.Net.Primitives@4.3.0",
        "pkg:nuget/System.Security.Permissions@4.7.0",
        "pkg:nuget/System.Security.Permissions@6.0.0",
        "pkg:nuget/log4net@2.0.13",
      ],
      ref: "pkg:nuget/Castle.Core@4.4.0",
    },
    {
      dependsOn: [
        "pkg:nuget/Microsoft.CSharp@4.0.1",
        "pkg:nuget/System.Collections@4.0.11",
        "pkg:nuget/System.Dynamic.Runtime@4.0.11",
        "pkg:nuget/System.Globalization@4.0.11",
        "pkg:nuget/System.Linq@4.1.0",
        "pkg:nuget/System.Reflection.Extensions@4.0.1",
        "pkg:nuget/System.Reflection@4.1.0",
        "pkg:nuget/System.Runtime.Extensions@4.1.0",
        "pkg:nuget/System.Runtime@4.1.0",
        "pkg:nuget/System.Text.RegularExpressions@4.1.0",
        "pkg:nuget/System.Threading@4.0.11",
      ],
      ref: "pkg:nuget/Serilog@3.0.1",
    },
    {
      dependsOn: ["pkg:nuget/Serilog@3.0.1"],
      ref: "pkg:nuget/Sample@latest",
    },
  ];
  const pkg_list = [
    {
      group: "",
      name: "Castle.Core",
      version: "4.4.0",
      "bom-ref": "pkg:nuget/Castle.Core@4.4.0",
    },
    {
      group: "",
      name: "Serilog",
      version: "3.0.1",
      "bom-ref": "pkg:nuget/Serilog@3.0.1",
    },
    {
      group: "",
      name: "Sample",
      version: "latest",
      "bom-ref": "pkg:nuget/Sample@latest",
    },
  ];
  const responses = new Map([
    [
      "https://api.nuget.org/v3/index.json",
      {
        body: {
          resources: [
            {
              "@type": "RegistrationsBaseUrl/3.6.0",
              "@id": "https://api.nuget.org/v3/registration3/",
            },
          ],
        },
      },
    ],
    [
      "https://api.nuget.org/v3/registration3/castle.core/index.json",
      {
        body: {
          items: [
            {
              lower: "4.0.0",
              upper: "4.4.0",
              items: [
                {
                  catalogEntry: {
                    version: "4.4.0",
                    description:
                      "Castle Core, including DynamicProxy, Logging Abstractions and DictionaryAdapter",
                    authors: "Castle Project Contributors",
                    licenseExpression: "Apache-2.0",
                    tags: [
                      "Castle",
                      "DynamicProxy",
                      "dynamic",
                      "proxy",
                      "dynamicproxy2",
                      "dictionaryadapter",
                      "emailsender",
                    ],
                    projectUrl: "http://www.castleproject.org/",
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "https://api.nuget.org/v3/registration3/serilog/index.json",
      {
        body: {
          items: [
            {
              lower: "3.0.0",
              upper: "3.0.1",
              items: [
                {
                  catalogEntry: {
                    version: "3.0.1",
                    description:
                      "Simple .NET logging with fully-structured events",
                    authors: "Serilog Contributors",
                    licenseExpression: "Apache-2.0",
                    tags: ["serilog", "logging", "semantic", "structured"],
                    projectUrl: "https://serilog.net/",
                  },
                },
              ],
            },
          ],
        },
      },
    ],
    [
      "https://api.nuget.org/v3/registration3/sample/index.json",
      {
        body: {
          items: [
            {
              lower: "1.0.0",
              upper: "1.2.3",
              items: [
                {
                  catalogEntry: {
                    version: "1.2.3",
                    description: "Sample package for metadata tests",
                    authors: "Sample Maintainers",
                    licenseExpression: "MIT",
                    tags: ["Sample", "Demo"],
                    projectUrl: "https://example.invalid/sample",
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ]);
  const agentGet = sinon.stub().callsFake(async (url, options) => {
    assert.strictEqual(options?.responseType, "json");
    const response = responses.get(String(url));
    assert.ok(response, `unexpected NuGet request: ${url}`);
    return response;
  });
  // The prefetch round added by D27 dispatches to the cdxrs subprocess when
  // the binary is present, bypassing this mock. Disable the Rust fetch path so
  // the JS batch pool runs every request through the mocked cdxgenAgent.
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  process.env.CDXGEN_RS_DISABLE = "fetch";
  resetBatchFetchAvailability();
  try {
    const { getNugetMetadata: mockedGetNugetMetadata } = await esmock(
      "./utils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const { pkgList, dependencies } = await mockedGetNugetMetadata(
      pkg_list,
      dep_list,
    );
    assert.deepStrictEqual(pkgList, [
      {
        author: "Castle Project Contributors",
        "bom-ref": "pkg:nuget/Castle.Core@4.4.0",
        description:
          "Castle Core, including DynamicProxy, Logging Abstractions and DictionaryAdapter",
        group: "",
        homepage: {
          url: "https://www.nuget.org/packages/Castle.Core/4.4.0/",
        },
        license: "Apache-2.0",
        name: "Castle.Core",
        repository: {
          url: "http://www.castleproject.org/",
        },
        tags: [
          "castle",
          "dynamicproxy",
          "dynamic",
          "proxy",
          "dynamicproxy2",
          "dictionaryadapter",
          "emailsender",
        ],
        version: "4.4.0",
      },
      {
        author: "Serilog Contributors",
        "bom-ref": "pkg:nuget/Serilog@3.0.1",
        description: "Simple .NET logging with fully-structured events",
        group: "",
        homepage: {
          url: "https://www.nuget.org/packages/Serilog/3.0.1/",
        },
        license: "Apache-2.0",
        name: "Serilog",
        repository: {
          url: "https://serilog.net/",
        },
        tags: ["serilog", "logging", "semantic", "structured"],
        version: "3.0.1",
      },
      {
        author: "Sample Maintainers",
        "bom-ref": "pkg:nuget/Sample@1.2.3",
        description: "Sample package for metadata tests",
        group: "",
        homepage: {
          url: "https://www.nuget.org/packages/Sample/1.2.3/",
        },
        license: "MIT",
        name: "Sample",
        // Resolving the `latest` placeholder rewrites the purl alongside the
        // bom-ref, so the two cannot disagree about the version - #4359
        purl: "pkg:nuget/Sample@1.2.3",
        repository: {
          url: "https://example.invalid/sample",
        },
        tags: ["sample", "demo"],
        version: "1.2.3",
      },
    ]);
    assert.deepStrictEqual(pkgList.length, 3);
    assert.deepStrictEqual(dependencies, [
      {
        dependsOn: [
          "pkg:nuget/Microsoft.NET.Test.Sdk@17.1.0",
          "pkg:nuget/Microsoft.NETCore.App@2.1.0",
          "pkg:nuget/Microsoft.NETFramework.ReferenceAssemblies@1.0.0",
          "pkg:nuget/NLog@4.5.0",
          "pkg:nuget/NUnit.Console@3.11.1",
          "pkg:nuget/NUnit3TestAdapter@3.16.1",
          "pkg:nuget/NUnitLite@3.13.3",
          "pkg:nuget/PublicApiGenerator@10.1.2",
          "pkg:nuget/Serilog.Sinks.TextWriter@2.0.0",
          "pkg:nuget/Serilog@3.0.1",
          "pkg:nuget/System.Net.NameResolution@4.3.0",
          "pkg:nuget/System.Net.Primitives@4.3.0",
          "pkg:nuget/System.Security.Permissions@4.7.0",
          "pkg:nuget/System.Security.Permissions@6.0.0",
          "pkg:nuget/log4net@2.0.13",
        ],
        ref: "pkg:nuget/Castle.Core@4.4.0",
      },
      {
        dependsOn: [
          "pkg:nuget/Microsoft.CSharp@4.0.1",
          "pkg:nuget/System.Collections@4.0.11",
          "pkg:nuget/System.Dynamic.Runtime@4.0.11",
          "pkg:nuget/System.Globalization@4.0.11",
          "pkg:nuget/System.Linq@4.1.0",
          "pkg:nuget/System.Reflection.Extensions@4.0.1",
          "pkg:nuget/System.Reflection@4.1.0",
          "pkg:nuget/System.Runtime.Extensions@4.1.0",
          "pkg:nuget/System.Runtime@4.1.0",
          "pkg:nuget/System.Text.RegularExpressions@4.1.0",
          "pkg:nuget/System.Threading@4.0.11",
        ],
        ref: "pkg:nuget/Serilog@3.0.1",
      },
      {
        dependsOn: ["pkg:nuget/Serilog@3.0.1"],
        ref: "pkg:nuget/Sample@1.2.3",
      },
    ]);
  } finally {
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
    resetBatchFetchAvailability();
  }
}, 240000);

it("nuget metadata survives an unreachable service index", async () => {
  const agentGet = sinon.stub().callsFake(async (url) => {
    if (String(url) === "https://api.nuget.org/v3/index.json") {
      const err = new Error("Connect Timeout Error");
      err.code = "UND_ERR_CONNECT_TIMEOUT";
      throw err;
    }
    if (
      String(url) ===
      "https://api.nuget.org/v3/registration3/serilog/index.json"
    ) {
      return {
        body: {
          items: [
            {
              lower: "3.0.1",
              upper: "3.0.1",
              items: [
                {
                  catalogEntry: {
                    version: "3.0.1",
                    description: "Simple .NET logging",
                    licenseExpression: "Apache-2.0",
                  },
                },
              ],
            },
          ],
        },
      };
    }
    throw new Error(`unexpected NuGet request: ${url}`);
  });
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  process.env.CDXGEN_RS_DISABLE = "fetch";
  resetBatchFetchAvailability();
  try {
    const { getNugetMetadata: mockedGetNugetMetadata } = await esmock(
      "./utils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    const { pkgList } = await mockedGetNugetMetadata(
      [
        {
          group: "",
          name: "Serilog",
          version: "3.0.1",
          "bom-ref": "pkg:nuget/Serilog@3.0.1",
        },
      ],
      [],
    );
    assert.strictEqual(pkgList.length, 1);
    assert.strictEqual(pkgList[0].description, "Simple .NET logging");
    assert.strictEqual(pkgList[0].license, "Apache-2.0");
  } finally {
    if (previousRsDisable === undefined) {
      delete process.env.CDXGEN_RS_DISABLE;
    } else {
      process.env.CDXGEN_RS_DISABLE = previousRsDisable;
    }
    resetBatchFetchAvailability();
  }
}, 240000);

it("parsePomMetadata", async () => {
  const deps = parsePom("./test/pom.xml");
  const data = await getMvnMetadata(deps.dependencies);
  assert.deepStrictEqual(data.length, deps.dependencies.length);
});

it("parse wheel metadata", () => {
  let deps = parseBdistMetadata("./test/data/METADATA");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    name: "yamllint",
    version: "1.26.1",
    description: "A linter for YAML files.",
    author: "Adrien Vergé",
    licenses: [
      {
        license: {
          name: "GPLv3",
        },
      },
    ],
    externalReferences: [
      {
        type: "website",
        url: "https://github.com/adrienverge/yamllint",
      },
      {
        type: "documentation",
        url: "https://yamllint.readthedocs.io",
        comment: "Documentation",
      },
      {
        type: "website",
        url: "https://pypi.org/project/yamllint/#files",
        comment: "Download",
      },
      {
        type: "issue-tracker",
        url: "https://github.com/adrienverge/yamllint/issues",
        comment: "Bug Tracker",
      },
      {
        type: "vcs",
        url: "https://github.com/adrienverge/yamllint",
        comment: "Source Code",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/METADATA",
      },
      {
        name: "cdx:python:requires_python",
        value: ">=3.5.*",
      },
    ],
    homepage: {
      url: "https://github.com/adrienverge/yamllint",
    },
    publisher: "Adrien Vergé",
    repository: {
      url: "https://github.com/adrienverge/yamllint",
    },
    keywords: ["yaml", "lint", "linter", "syntax", "checker"],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/METADATA",
          },
        ],
      },
    },
    purl: "pkg:pypi/yamllint@1.26.1",
    "bom-ref": "pkg:pypi/yamllint@1.26.1",
  });
  deps = parseBdistMetadata("./test/data/dist-info/METADATA1");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    name: "pytest",
    version: "9.0.2",
    description: "pytest: simple powerful testing with Python",
    author:
      "Holger Krekel, Bruno Oliveira, Ronny Pfannschmidt, Floris Bruynooghe, Brianna Laugher, Florian Bruhin, Others (See AUTHORS)",
    licenses: [
      {
        expression: "MIT",
      },
    ],
    externalReferences: [
      {
        type: "release-notes",
        url: "https://docs.pytest.org/en/stable/changelog.html",
        comment: "Changelog",
      },
      {
        type: "website",
        url: "https://docs.pytest.org/en/stable/contact.html",
        comment: "Contact",
      },
      {
        type: "other",
        url: "https://docs.pytest.org/en/stable/sponsor.html",
        comment: "Funding",
      },
      {
        type: "website",
        url: "https://docs.pytest.org/en/latest/",
        comment: "Homepage",
      },
      {
        type: "vcs",
        url: "https://github.com/pytest-dev/pytest",
        comment: "Source",
      },
      {
        type: "issue-tracker",
        url: "https://github.com/pytest-dev/pytest/issues",
        comment: "Tracker",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/dist-info/METADATA1",
      },
      {
        name: "cdx:python:requires_python",
        value: ">=3.10",
      },
    ],
    publisher:
      "Holger Krekel, Bruno Oliveira, Ronny Pfannschmidt, Floris Bruynooghe, Brianna Laugher, Florian Bruhin, Others (See AUTHORS)",
    repository: {
      url: "https://github.com/pytest-dev/pytest",
    },
    keywords: ["test", "unittest"],
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/dist-info/METADATA1",
          },
        ],
      },
    },
    purl: "pkg:pypi/pytest@9.0.2",
    "bom-ref": "pkg:pypi/pytest@9.0.2",
  });
  deps = parseBdistMetadata("./test/data/dist-info/METADATA2");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    name: "orjson",
    version: "3.11.7",
    description:
      "Fast, correct Python JSON library supporting dataclasses, datetimes, and numpy",
    author: "",
    licenses: [
      {
        expression: "MPL-2.0 AND (Apache-2.0 OR MIT)",
      },
    ],
    externalReferences: [
      {
        type: "release-notes",
        url: "https://github.com/ijl/orjson/blob/master/CHANGELOG.md",
        comment: "changelog",
      },
      {
        type: "documentation",
        url: "https://github.com/ijl/orjson",
        comment: "documentation",
      },
      {
        type: "vcs",
        url: "https://github.com/ijl/orjson",
        comment: "source",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/dist-info/METADATA2",
      },
      {
        name: "cdx:python:requires_python",
        value: ">=3.10",
      },
    ],
    repository: {
      url: "https://github.com/ijl/orjson",
    },
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/dist-info/METADATA2",
          },
        ],
      },
    },
    purl: "pkg:pypi/orjson@3.11.7",
    "bom-ref": "pkg:pypi/orjson@3.11.7",
  });
  deps = parseBdistMetadata("./test/data/dist-info/METADATA3");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    name: "dnspython",
    version: "2.8.0",
    description: "DNS toolkit",
    author: "",
    licenses: [
      {
        license: {
          name: "ISC",
        },
      },
    ],
    externalReferences: [
      {
        type: "website",
        url: "https://www.dnspython.org",
        comment: "homepage",
      },
      {
        type: "vcs",
        url: "https://github.com/rthalley/dnspython.git",
        comment: "repository",
      },
      {
        type: "documentation",
        url: "https://dnspython.readthedocs.io/en/stable/",
        comment: "documentation",
      },
      {
        type: "issue-tracker",
        url: "https://github.com/rthalley/dnspython/issues",
        comment: "issues",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/dist-info/METADATA3",
      },
      {
        name: "cdx:python:requires_python",
        value: ">=3.10",
      },
    ],
    repository: {
      url: "https://github.com/rthalley/dnspython.git",
    },
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/dist-info/METADATA3",
          },
        ],
      },
    },
    purl: "pkg:pypi/dnspython@2.8.0",
    "bom-ref": "pkg:pypi/dnspython@2.8.0",
  });
  deps = parseBdistMetadata("./test/data/mercurial-5.5.2-py3.8.egg-info");
  assert.deepStrictEqual(deps.length, 1);
  assert.deepStrictEqual(deps[0], {
    name: "mercurial",
    version: "5.5.2",
    description:
      "Fast scalable distributed SCM (revision control, version control) system",
    author: "Matt Mackall and many others",
    licenses: [
      {
        license: {
          name: "GNU GPLv2 or any later version",
        },
      },
    ],
    externalReferences: [
      {
        type: "website",
        url: "https://mercurial-scm.org/",
      },
    ],
    properties: [
      {
        name: "internal:SrcFile",
        value: "./test/data/mercurial-5.5.2-py3.8.egg-info",
      },
    ],
    homepage: {
      url: "https://mercurial-scm.org/",
    },
    publisher: "Matt Mackall and many others",
    evidence: {
      identity: {
        field: "purl",
        confidence: 0.5,
        methods: [
          {
            technique: "manifest-analysis",
            confidence: 0.5,
            value: "./test/data/mercurial-5.5.2-py3.8.egg-info",
          },
        ],
      },
    },
    purl: "pkg:pypi/mercurial@5.5.2",
    "bom-ref": "pkg:pypi/mercurial@5.5.2",
  });
});

it("parse wheel", async () => {
  const metadata = await readZipEntry(
    "./test/data/appthreat_depscan-2.0.2-py3-none-any.whl",
    "METADATA",
  );
  assert.ok(metadata);
  const parsed = parseBdistMetadata(undefined, metadata);
  assert.deepStrictEqual(parsed[0], {
    name: "appthreat-depscan",
    version: "2.0.2",
    description:
      "Fully open-source security audit for project dependencies based on known vulnerabilities and advisories.",
    author: "Team AppThreat",
    licenses: [],
    externalReferences: [
      {
        type: "website",
        url: "https://github.com/appthreat/dep-scan",
      },
    ],
    properties: [
      {
        name: "cdx:python:requires_python",
        value: ">=3.8",
      },
    ],
    homepage: {
      url: "https://github.com/appthreat/dep-scan",
    },
    publisher: "Team AppThreat",
    purl: "pkg:pypi/appthreat-depscan@2.0.2",
    "bom-ref": "pkg:pypi/appthreat-depscan@2.0.2",
  });
});

it("pypi version solver tests", () => {
  const versionsList = [
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "1.2.0.dev1+hg.5.b11e5e6f0b0b",
    "2.0.3",
    "2.0b1",
    "3.0.12-alpha.13",
    "3.0.12-alpha.12",
    "3.0.12-alpha.14",
    "4.0.0",
  ];
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "<4"),
    "3.0.12-alpha.14",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">1.0.0 <3.0.0"),
    "2.0.3",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "== 1.0.1"),
    "1.0.1",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "~= 1.0.1"),
    "1.0.1",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">= 2.0.1, == 2.8.*"),
    null,
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(
      ["2.0.0", "2.0.1", "2.4.0", "2.8.4", "2.9.0", "3.0.1"],
      ">= 2.0.1, == 2.8.*",
    ),
    "2.8.4",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "== 1.1.0; python_version < '3.8'"),
    "1.1.0",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, "<3.6,>1.9,!=1.9.6,<4.0a0"),
    "3.0.12-alpha.14",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">=1.4.2,<2.2,!=1.5.*,!=1.6.*"),
    "2.0.3",
  );
  assert.deepStrictEqual(
    guessPypiMatchingVersion(versionsList, ">=1.21.1,<3"),
    "2.0.3",
  );
});

it("records a jar with unreadable coordinates as a file component", async () => {
  const { extractJarArchive } = await import("./ecosystems.js");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-unresolved-"));
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-extract-"));
  try {
    // A jar with classes but no pom.properties and a name carrying no version
    // has no readable Maven coordinates.
    const classDir = join(workDir, "com", "example");
    execFileSync("mkdir", ["-p", classDir]);
    writeFileSync(join(classDir, "A.class"), "not really bytecode");
    const jarPath = join(workDir, "mystery.jar");
    try {
      execFileSync("jar", ["cf", jarPath, "-C", workDir, "com"]);
    } catch {
      // No JDK on this machine; the behaviour is covered by the repotests.
      return;
    }

    const pkgList = await extractJarArchive(jarPath, tempDir);
    assert.strictEqual(pkgList.length, 1);
    const [component] = pkgList;
    assert.strictEqual(component.type, "file");
    assert.strictEqual(component.name, "mystery.jar");
    // Identity is asserted at zero confidence: the file is known, the package
    // it contains is not.
    assert.strictEqual(component.evidence.identity[0].confidence, 0);
    assert.strictEqual(
      component.evidence.identity[0].methods[0].technique,
      "filename",
    );
    assert.strictEqual(component.evidence.identity[0].concludedValue, jarPath);
    assert.deepStrictEqual(
      component.hashes.map((h) => h.alg),
      ["MD5", "SHA-1", "SHA-256"],
    );
    for (const hash of component.hashes) {
      assert.match(hash.content, /^[0-9a-f]{32,64}$/);
    }
    assert.ok(
      component.properties.some(
        (p) => p.name === "internal:SrcFile" && p.value === jarPath,
      ),
    );
    // The purl carries no path: the extraction directory is temporary, so a
    // location in the purl would differ between runs over the same input.
    assert.strictEqual(component.purl, "pkg:generic/mystery.jar");
  } finally {
    rmSync(workDir, { force: true, recursive: true });
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("extractJarArchive leaves the scanned directory untouched and reads a sibling POM", async () => {
  const { extractJarArchive } = await import("./ecosystems.js");
  const {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
  } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const buildDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-build-"));
  const scanDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-scan-"));
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-jar-extract-"));
  try {
    mkdirSync(join(buildDir, "com", "example"), { recursive: true });
    writeFileSync(join(buildDir, "com", "example", "Foo.class"), "x");
    const jarPath = join(scanDir, "foo-1.2.jar");
    try {
      execFileSync("jar", ["cf", jarPath, "-C", buildDir, "com"]);
    } catch {
      // No JDK on this machine; the behaviour is covered by the repotests.
      return;
    }
    // The layout that used to make cdxgen extract the jar into the scanned
    // directory and then delete that directory's META-INF.
    writeFileSync(
      join(scanDir, "foo-1.2.pom"),
      "<project><groupId>com.example</groupId><artifactId>foo</artifactId><version>1.2</version></project>",
    );
    mkdirSync(join(scanDir, "META-INF"));
    writeFileSync(
      join(scanDir, "META-INF", "MANIFEST.MF"),
      "Manifest-Version: 1.0\n",
    );
    writeFileSync(join(scanDir, "META-INF", "keep-me.txt"), "user data");

    const pkgList = await extractJarArchive(jarPath, tempDir);

    assert.strictEqual(
      readFileSync(join(scanDir, "META-INF", "keep-me.txt"), "utf-8"),
      "user data",
    );
    assert.ok(
      !existsSync(join(scanDir, "com")),
      "nothing is extracted next to the jar",
    );
    assert.deepStrictEqual(
      pkgList.map((p) => p.purl),
      ["pkg:maven/com.example/foo@1.2?type=jar"],
    );
  } finally {
    rmSync(buildDir, { force: true, recursive: true });
    rmSync(scanDir, { force: true, recursive: true });
    rmSync(tempDir, { force: true, recursive: true });
  }
});

it("extractJarArchive reads each jar in a war from its own descriptor", async () => {
  const { extractJarArchive } = await import("./ecosystems.js");
  const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = await import(
    "node:fs"
  );
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFileSync } = await import("node:child_process");

  const buildDir = mkdtempSync(join(tmpdir(), "cdxgen-war-build-"));
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-war-extract-"));
  try {
    const libDir = join(buildDir, "lib");
    mkdirSync(join(libDir, "META-INF", "maven", "org.lib", "libby"), {
      recursive: true,
    });
    writeFileSync(
      join(libDir, "META-INF", "maven", "org.lib", "libby", "pom.properties"),
      "groupId=org.lib\nartifactId=libby\nversion=2.0\n",
    );
    const warDir = join(buildDir, "war");
    // The war's own descriptor sorts first, which is what made the first
    // nested jar take the war's coordinates when both shared one directory.
    mkdirSync(join(warDir, "META-INF", "maven", "aaa.app", "webapp"), {
      recursive: true,
    });
    writeFileSync(
      join(warDir, "META-INF", "maven", "aaa.app", "webapp", "pom.properties"),
      "groupId=aaa.app\nartifactId=webapp\nversion=1.0\n",
    );
    mkdirSync(join(warDir, "WEB-INF", "lib"), { recursive: true });
    const warPath = join(buildDir, "app.war");
    try {
      execFileSync("jar", [
        "cf",
        join(warDir, "WEB-INF", "lib", "libby-2.0.jar"),
        "-C",
        libDir,
        "META-INF",
      ]);
      execFileSync("jar", ["cf", warPath, "-C", warDir, "."]);
    } catch {
      return;
    }

    const pkgList = await extractJarArchive(warPath, tempDir);

    assert.deepStrictEqual(
      pkgList.map((p) => p.purl),
      ["pkg:maven/org.lib/libby@2.0?type=jar"],
    );
  } finally {
    rmSync(buildDir, { force: true, recursive: true });
    rmSync(tempDir, { force: true, recursive: true });
  }
});
