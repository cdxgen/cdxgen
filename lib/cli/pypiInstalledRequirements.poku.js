import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// The installed dist-info METADATA pass covers requirements.txt and
// Pipfile.lock entries the same way it covers the poetry, uv and pylock
// locks: the installation answers before PyPI, and an installation that
// enriched an entry is not also emitted as a component of its own. The
// assertions are on the exact requests a stubbed agent records and on the
// components of the built BOM. The environment it changes is process-wide,
// so the cases run one after the other inside a single it.

// The METADATA file of the installed attrs distribution, as the scan itself
// reads it.
const ATTRS_METADATA = [
  "Metadata-Version: 2.4",
  "Name: attrs",
  "Version: 25.3.0",
  "Summary: Classes Without Boilerplate",
  "License-Expression: MIT",
  "Author: Hynek Schlawack",
  "Home-page: https://www.attrs.org/",
  "",
].join("\n");

/**
 * A project directory holding a manifest plus an installed attrs
 * distribution under a virtualenv layout the scan walks.
 *
 * @param {string} manifestFileName File to write the manifest to
 * @param {string} manifestContent Manifest content
 * @returns {string} Project directory
 */
function buildProject(manifestFileName, manifestContent) {
  const project = mkdtempSync(join(tmpdir(), "cdxgen-req-installed-"));
  writeFileSync(join(project, manifestFileName), manifestContent);
  const distInfo = join(
    project,
    "venv",
    "lib",
    "python3.12",
    "site-packages",
    "attrs-25.3.0.dist-info",
  );
  mkdirSync(distInfo, { recursive: true });
  writeFileSync(join(distInfo, "METADATA"), ATTRS_METADATA);
  return project;
}

/**
 * Load createPythonBom with every PyPI request answered by a stub agent that
 * records its URLs, and run it over the given project.
 *
 * @param {string} project Project directory
 * @returns {Promise<{bomJson: Object, requested: string[]}>}
 */
async function scanRecordingRequests(project) {
  const requested = [];
  const agentGet = sinon.stub().callsFake(async (url) => {
    requested.push(url);
    const name = url.split("/pypi/")[1]?.split("/")[0] || "unknown";
    return {
      statusCode: 200,
      body: {
        info: {
          name,
          version: "9.9.9",
          summary: "from the registry",
          license: "",
          classifiers: ["License :: OSI Approved :: MIT License"],
        },
        releases: {},
      },
    };
  });
  const { createPythonBom } = await esmock(
    "./managedBom.js",
    {},
    {
      "../core/httpClient.js": {
        createHttpClient: sinon.stub().returns({ get: agentGet }),
      },
    },
  );
  const { resetBatchFetchAvailability } = await import(
    "../inventory/fetchBatch.js"
  );
  resetBatchFetchAvailability();
  const { bomJson } = await createPythonBom(project, {
    installDeps: false,
    // The venv tree below the project root is only walked for installed
    // METADATA files in multi-project mode.
    multiProject: true,
    projectType: ["python"],
  });
  return { bomJson, requested };
}

await it("installed METADATA enriches requirements and Pipfile.lock entries without duplicating components", async () => {
  const previousFetchLicense = process.env.FETCH_LICENSE;
  const previousPypiUrl = process.env.PYPI_URL;
  const previousRsDisable = process.env.CDXGEN_RS_DISABLE;
  const previousFetchPkgMetadata = process.env.CDXGEN_FETCH_PKG_METADATA;
  delete process.env.CDXGEN_FETCH_PKG_METADATA;
  process.env.FETCH_LICENSE = "true";
  process.env.CDXGEN_RS_DISABLE = "fetch";
  process.env.PYPI_URL = "http://127.0.0.1:1/pypi/";
  try {
    // requirements.txt
    {
      const project = buildProject(
        "requirements.txt",
        "attrs==25.3.0\ncertifi==2026.7.22\n",
      );
      try {
        const { bomJson, requested } = await scanRecordingRequests(project);
        // Positive control: the stub saw a request, and every one of them is
        // for the package no installation covers.
        assert.ok(requested.length >= 1, "the stub agent saw no request");
        for (const url of requested) {
          assert.ok(
            url.startsWith("http://127.0.0.1:1/pypi/certifi/"),
            `unexpected request ${url}`,
          );
        }
        const components = bomJson.components || [];
        const attrs = components.filter(
          (c) => c.name === "attrs" && c.version === "25.3.0",
        );
        // The installation enriched the requirements entry, whose licence and
        // description come from the METADATA file, and it added no component
        // of its own.
        assert.strictEqual(attrs.length, 1);
        assert.deepStrictEqual(attrs[0].licenses, [{ expression: "MIT" }]);
        assert.strictEqual(attrs[0].description, "Classes Without Boilerplate");
        // The package without an installation was enriched by the registry.
        const certifi = components.find(
          (c) => c.name === "certifi" && c.version === "2026.7.22",
        );
        assert.ok(certifi);
        assert.strictEqual(certifi.description, "from the registry");
      } finally {
        rmSync(project, { force: true, recursive: true });
      }
    }
    // Pipfile.lock
    {
      const project = buildProject(
        "Pipfile.lock",
        JSON.stringify(
          {
            _meta: {
              hash: { sha256: "0123456789abcdef" },
              "pipfile-spec": 6,
              requires: {},
              sources: [{ name: "pypi", url: "https://pypi.org/simple" }],
            },
            default: {
              attrs: {
                hashes: ["sha256:abcdef"],
                version: "==25.3.0",
              },
              certifi: {
                hashes: ["sha123456".padEnd(19, "0")],
                version: "==2026.7.22",
              },
            },
            develop: {},
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(project, "Pipfile"),
        '[["source"]]\nurl = "https://pypi.org/simple"\n\n[packages]\nattrs = "==25.3.0"\ncertifi = "==2026.7.22"\n',
      );
      try {
        const { bomJson, requested } = await scanRecordingRequests(project);
        assert.ok(requested.length >= 1, "the stub agent saw no request");
        for (const url of requested) {
          assert.ok(
            url.startsWith("http://127.0.0.1:1/pypi/certifi/"),
            `unexpected request ${url}`,
          );
        }
        const attrs = (bomJson.components || []).filter(
          (c) => c.name === "attrs" && c.version === "25.3.0",
        );
        assert.strictEqual(attrs.length, 1);
        assert.deepStrictEqual(attrs[0].licenses, [{ expression: "MIT" }]);
        assert.strictEqual(attrs[0].description, "Classes Without Boilerplate");
      } finally {
        rmSync(project, { force: true, recursive: true });
      }
    }
  } finally {
    for (const [name, value] of Object.entries({
      FETCH_LICENSE: previousFetchLicense,
      PYPI_URL: previousPypiUrl,
      CDXGEN_RS_DISABLE: previousRsDisable,
      CDXGEN_FETCH_PKG_METADATA: previousFetchPkgMetadata,
    })) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});
