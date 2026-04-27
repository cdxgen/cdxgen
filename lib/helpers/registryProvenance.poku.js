import { assert, describe, it } from "poku";

import {
  collectNpmRegistryProvenanceProperties,
  collectPypiRegistryProvenanceProperties,
} from "./registryProvenance.js";

function getProperty(properties, propertyName) {
  return properties.find((property) => property.name === propertyName)?.value;
}

describe("collectNpmRegistryProvenanceProperties()", () => {
  it("extracts trusted publishing and publisher details from npm metadata", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      {
        time: {
          "1.2.3": "2026-04-01T10:00:00.000Z",
        },
        versions: {
          "1.2.3": {
            _npmUser: {
              email: "publisher@example.com",
              name: "publisher",
            },
            dist: {
              provenance: {
                url: "https://registry.npmjs.org/-/npm/v1/attestations/example@1.2.3",
              },
            },
          },
        },
      },
      "1.2.3",
    );

    assert.strictEqual(
      getProperty(properties, "cdx:npm:trustedPublishing"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenanceUrl"),
      "https://registry.npmjs.org/-/npm/v1/attestations/example@1.2.3",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:publisher"),
      "publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:publisherEmail"),
      "publisher@example.com",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:publishTime"),
      "2026-04-01T10:00:00.000Z",
    );
  });
});

describe("collectPypiRegistryProvenanceProperties()", () => {
  it("extracts trusted publishing and uploader details from PyPI metadata", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "2.0.0": [
            {
              provenance_url:
                "https://pypi.org/integrity/example/2.0.0/example-2.0.0.tar.gz/provenance",
              upload_time_iso_8601: "2026-03-20T08:15:30.000Z",
              uploader: "trusted-publisher",
              uploader_verified: true,
            },
          ],
        },
      },
      "2.0.0",
    );

    assert.strictEqual(
      getProperty(properties, "cdx:pypi:trustedPublishing"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:provenanceUrl"),
      "https://pypi.org/integrity/example/2.0.0/example-2.0.0.tar.gz/provenance",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publishTime"),
      "2026-03-20T08:15:30.000Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publisher"),
      "trusted-publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderVerified"),
      "true",
    );
  });
});
