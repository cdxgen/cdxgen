import { assert, describe, it } from "poku";

import {
  collectCargoRegistryProvenanceProperties,
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
          "1.2.0": "2025-01-01T10:00:00.000Z",
          "1.2.1": "2025-01-15T10:00:00.000Z",
          "1.2.2": "2026-03-01T10:00:00.000Z",
          "1.2.3": "2026-04-01T10:00:00.000Z",
          created: "2024-01-01T10:00:00.000Z",
          modified: "2026-04-01T10:00:00.000Z",
        },
        versions: {
          "1.2.0": {
            _npmUser: {
              name: "previous-publisher",
            },
            maintainers: [{ name: "alice" }, { email: "alice@example.com" }],
          },
          "1.2.1": {
            _npmUser: {
              name: "previous-publisher",
            },
            maintainers: [{ name: "alice" }, { email: "alice@example.com" }],
          },
          "1.2.2": {
            _npmUser: {
              name: "previous-publisher",
            },
            maintainers: [{ name: "alice" }, { email: "alice@example.com" }],
          },
          "1.2.3": {
            _npmUser: {
              email: "publisher@example.com",
              name: "publisher",
            },
            maintainers: [{ name: "bob" }, { email: "bob@example.com" }],
            dist: {
              integrity: "sha512-artifact-integrity",
              provenance: {
                predicateType: "https://slsa.dev/provenance/v1",
                signatures: [
                  {
                    keyid: "sigstore-npm-key",
                    sig: "MEUCIQDsig",
                  },
                ],
                subject: {
                  digest: {
                    sha256: "npm-subject-digest",
                  },
                },
                url: "https://registry.npmjs.org/-/npm/v1/attestations/example@1.2.3",
              },
              shasum: "deadbeefcafebabe",
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
    assert.strictEqual(
      getProperty(properties, "cdx:npm:artifactIntegrity"),
      "sha512-artifact-integrity",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:artifactShasum"),
      "deadbeefcafebabe",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenanceDigest"),
      "npm-subject-digest",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenanceKeyId"),
      "sigstore-npm-key",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenancePredicateType"),
      "https://slsa.dev/provenance/v1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenanceSignature"),
      "MEUCIQDsig",
    );
    assert.strictEqual(getProperty(properties, "cdx:npm:versionCount"), "4");
    assert.strictEqual(
      getProperty(properties, "cdx:npm:priorVersion"),
      "1.2.2",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:priorPublisher"),
      "previous-publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:publisherDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:packageCreatedTime"),
      "2024-01-01T10:00:00.000Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSet"),
      "bob, bob@example.com, publisher, publisher@example.com",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:priorMaintainerSet"),
      "alice, alice@example.com, previous-publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSetDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:releaseGapDays"),
      "31.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:releaseGapBaselineDays"),
      "212.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:releaseGapSampleSize"),
      "2",
    );
  });

  it("extracts compressed cadence and partial maintainer overlap drift from npm metadata", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      {
        time: {
          "0.9.0": "2024-11-01T10:00:00.000Z",
          "1.0.0": "2025-01-01T10:00:00.000Z",
          "1.1.0": "2025-03-15T10:00:00.000Z",
          "1.2.0": "2025-05-27T10:00:00.000Z",
          "1.2.1": "2025-06-05T10:00:00.000Z",
          created: "2024-01-01T10:00:00.000Z",
          modified: "2025-06-05T10:00:00.000Z",
        },
        versions: {
          "0.9.0": {
            _npmUser: {
              name: "alice",
            },
          },
          "1.0.0": {
            _npmUser: {
              name: "alice",
            },
          },
          "1.1.0": {
            _npmUser: {
              name: "alice",
            },
          },
          "1.2.0": {
            _npmUser: {
              name: "bob",
            },
            maintainers: [{ name: "alice" }],
          },
          "1.2.1": {
            _npmUser: {
              name: "bob",
            },
            maintainers: [{ name: "charlie" }],
          },
        },
      },
      "1.2.1",
    );

    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSetPartialDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerOverlapCount"),
      "1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerOverlapRatio"),
      "0.33",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:compressedCadence"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:releaseCadenceCompressionRatio"),
      "0.12",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSetDrift"),
      undefined,
    );
  });
});

describe("collectPypiRegistryProvenanceProperties()", () => {
  it("extracts trusted publishing and uploader details from PyPI metadata", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "1.7.0": [
            {
              upload_time_iso_8601: "2025-11-20T08:15:30.000Z",
              uploader: "previous-uploader",
            },
          ],
          "1.8.0": [
            {
              upload_time_iso_8601: "2025-12-05T08:15:30.000Z",
              uploader: "previous-uploader",
            },
          ],
          "1.9.0": [
            {
              upload_time_iso_8601: "2025-12-20T08:15:30.000Z",
              uploader: "previous-uploader",
            },
          ],
          "2.0.0": [
            {
              digests: {
                blake2b_256: "pypi-blake",
                sha256: "pypi-sha256",
              },
              md5_digest: "pypi-md5",
              provenance: {
                predicateType: "https://docs.pypi.org/attestations/publish/v1",
                signatures: [
                  {
                    keyid: "sigstore-pypi-key",
                    sig: "c2lnbmF0dXJl",
                  },
                ],
                subject: {
                  digest: {
                    sha256: "pypi-provenance-digest",
                  },
                },
              },
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
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:artifactDigestSha256"),
      "pypi-sha256",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:artifactDigestBlake2b256"),
      "pypi-blake",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:artifactDigestMd5"),
      "pypi-md5",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:provenanceDigest"),
      "pypi-provenance-digest",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:provenanceKeyId"),
      "sigstore-pypi-key",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:provenancePredicateType"),
      "https://docs.pypi.org/attestations/publish/v1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:provenanceSignature"),
      "c2lnbmF0dXJl",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:versionCount"), "4");
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:priorVersion"),
      "1.9.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:priorPublisher"),
      "previous-uploader",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publisherDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:packageCreatedTime"),
      "2025-11-20T08:15:30.000Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderSet"),
      "trusted-publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:priorUploaderSet"),
      "previous-uploader",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderSetDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:releaseGapDays"),
      "90.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:releaseGapBaselineDays"),
      "15.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:releaseGapSampleSize"),
      "2",
    );
  });

  it("extracts compressed cadence and partial uploader overlap drift from PyPI metadata", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "0.9.0": [
            {
              upload_time_iso_8601: "2024-11-01T08:15:30.000Z",
              uploader: "alice",
            },
          ],
          "1.0.0": [
            {
              upload_time_iso_8601: "2025-01-01T08:15:30.000Z",
              uploader: "alice",
            },
          ],
          "1.1.0": [
            {
              upload_time_iso_8601: "2025-03-15T08:15:30.000Z",
              uploader: "alice",
            },
          ],
          "1.2.0": [
            {
              upload_time_iso_8601: "2025-05-27T08:15:30.000Z",
              uploader: "alice",
            },
            {
              upload_time_iso_8601: "2025-05-27T08:16:30.000Z",
              uploader: "bob",
            },
          ],
          "1.2.1": [
            {
              upload_time_iso_8601: "2025-06-05T08:15:30.000Z",
              uploader: "bob",
            },
            {
              upload_time_iso_8601: "2025-06-05T08:16:30.000Z",
              uploader: "charlie",
            },
          ],
        },
      },
      "1.2.1",
    );

    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderSetPartialDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderOverlapCount"),
      "1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderOverlapRatio"),
      "0.33",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:compressedCadence"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:releaseCadenceCompressionRatio"),
      "0.12",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderSetDrift"),
      undefined,
    );
  });
});

describe("collectCargoRegistryProvenanceProperties()", () => {
  it("extracts Cargo publisher, release cadence, artifact, and trusted-publishing details", () => {
    const properties = collectCargoRegistryProvenanceProperties(
      {
        crate: {
          trustpub_only: true,
        },
        versions: [
          {
            num: "0.9.0",
            created_at: "2025-01-01T10:00:00.000Z",
            published_by: { login: "previous-publisher" },
          },
          {
            num: "1.0.0",
            created_at: "2025-03-01T10:00:00.000Z",
            published_by: { login: "previous-publisher" },
          },
          {
            num: "1.1.0",
            created_at: "2025-05-15T10:00:00.000Z",
            published_by: { login: "previous-publisher" },
          },
          {
            num: "1.2.0",
            created_at: "2025-06-05T10:00:00.000Z",
            checksum: "cargo-sha256",
            crate_size: 4242,
            edition: "2021",
            has_lib: true,
            bin_names: ["cargo-demo"],
            yanked: true,
            published_by: {
              login: "publisher",
              name: "Publisher Name",
            },
            trustpub_data: {
              predicateType: "https://slsa.dev/provenance/v1",
              signatures: [
                { keyid: "sigstore-cargo-key", sig: "cargo-signature" },
              ],
              subject: {
                digest: {
                  sha256: "cargo-subject-digest",
                },
              },
              url: "https://crates.io/provenance/cargo-demo/1.2.0",
            },
          },
        ],
      },
      "1.2.0",
      {
        users: [
          { login: "publisher", name: "Publisher Name" },
          { login: "owner-two", name: "Owner Two" },
        ],
      },
    );

    assert.strictEqual(
      getProperty(properties, "cdx:cargo:trustedPublishing"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:publishTime"),
      "2025-06-05T10:00:00.000Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:publisher"),
      "publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:priorPublisher"),
      "previous-publisher",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:publisherDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:publisherSet"),
      "publisher, publisher name",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:ownerSet"),
      "publisher, publisher name, owner-two, owner two",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:artifactDigestSha256"),
      "cargo-sha256",
    );
    assert.strictEqual(getProperty(properties, "cdx:cargo:yanked"), "true");
    assert.strictEqual(getProperty(properties, "cdx:cargo:edition"), "2021");
    assert.strictEqual(getProperty(properties, "cdx:cargo:hasLib"), "true");
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:binNames"),
      "cargo-demo",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:provenanceUrl"),
      "https://crates.io/provenance/cargo-demo/1.2.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:provenanceDigest"),
      "cargo-subject-digest",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:provenanceKeyId"),
      "sigstore-cargo-key",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:provenanceSignature"),
      "cargo-signature",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:provenancePredicateType"),
      "https://slsa.dev/provenance/v1",
    );
    assert.strictEqual(getProperty(properties, "cdx:cargo:versionCount"), "4");
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:priorVersion"),
      "1.1.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:releaseGapDays"),
      "21.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:releaseGapBaselineDays"),
      "67.00",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:releaseGapSampleSize"),
      "2",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:compressedCadence"),
      undefined,
    );
  });
});
