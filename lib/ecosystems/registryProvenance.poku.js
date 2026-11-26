import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assert, describe, it } from "poku";

import {
  canonicalPypiVersion,
  collectCargoRegistryProvenanceProperties,
  collectNpmRegistryProvenanceProperties,
  collectPypiRegistryProvenanceProperties,
  isoTimestamp,
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

  it("ignores provenance keys that come from the publisher's package.json", () => {
    for (const manifestKeys of [
      { provenance: true },
      { attestations: true },
      {
        provenance: {
          predicateType: "https://slsa.dev/provenance/v1",
          url: "https://registry.npmjs.org/-/npm/v1/attestations/example@1.0.0",
        },
      },
      { dist: { provenance: true } },
    ]) {
      const versionBody = {
        _npmUser: { name: "publisher" },
        provenance: manifestKeys.provenance,
        attestations: manifestKeys.attestations,
        dist: {
          integrity: "sha512-artifact-integrity",
          shasum: "deadbeefcafebabe",
          ...manifestKeys.dist,
        },
      };
      const properties = collectNpmRegistryProvenanceProperties(
        {
          time: { "1.0.0": "2025-01-01T10:00:00.000Z" },
          versions: { "1.0.0": versionBody },
        },
        "1.0.0",
      );
      for (const name of [
        "cdx:npm:trustedPublishing",
        "cdx:npm:provenanceUrl",
        "cdx:npm:provenancePredicateType",
      ]) {
        assert.strictEqual(getProperty(properties, name), undefined, name);
      }
    }
  });

  it("accepts the attestations the npm registry records in dist", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      {
        time: { "1.0.0": "2025-01-01T10:00:00.000Z" },
        versions: {
          "1.0.0": {
            dist: {
              attestations: {
                provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                url: "https://registry.npmjs.org/-/npm/v1/attestations/example@1.0.0",
              },
            },
          },
        },
      },
      "1.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:trustedPublishing"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:provenanceUrl"),
      "https://registry.npmjs.org/-/npm/v1/attestations/example@1.0.0",
    );
  });

  it("ignores a publisher key that comes from the publisher's package.json", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      {
        time: {
          "1.0.0": "2025-01-01T10:00:00.000Z",
          "1.0.1": "2025-02-01T10:00:00.000Z",
        },
        versions: {
          "1.0.0": {
            _npmUser: { name: "alice" },
            maintainers: [{ name: "alice" }],
          },
          "1.0.1": {
            _npmUser: { name: "mallory" },
            maintainers: [{ name: "mallory" }],
            publisher: { email: "alice@example.com", name: "alice" },
          },
        },
      },
      "1.0.1",
    );
    assert.strictEqual(getProperty(properties, "cdx:npm:publisher"), "mallory");
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSet"),
      "mallory",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSetDrift"),
      "true",
    );
  });

  it("derives each version's prior release and gaps from one shared packument", () => {
    const packument = {
      time: {
        "2.0.0": "2025-03-02T10:00:00.000Z",
        "1.0.2": "2025-01-15T10:00:00.000Z",
        "1.0.0": "2025-01-01T10:00:00.000Z",
        "1.0.3": "2025-01-16T10:00:00.000Z",
        "1.0.1": "2025-01-11T10:00:00.000Z",
        created: "2025-01-01T10:00:00.000Z",
        modified: "2025-03-02T10:00:00.000Z",
      },
    };
    const expected = {
      "2.0.0": ["1.0.3", "45.00", "4.00", "3"],
      "1.0.3": ["1.0.2", "1.00", "7.00", "2"],
      "1.0.2": ["1.0.1", "4.00", "10.00", "1"],
      "1.0.1": ["1.0.0", "10.00", undefined, "0"],
      "1.0.0": [undefined, undefined, undefined, undefined],
    };
    for (const [version, values] of Object.entries(expected)) {
      const properties = collectNpmRegistryProvenanceProperties(
        packument,
        version,
      );
      assert.deepStrictEqual(
        [
          getProperty(properties, "cdx:npm:priorVersion"),
          getProperty(properties, "cdx:npm:releaseGapDays"),
          getProperty(properties, "cdx:npm:releaseGapBaselineDays"),
          getProperty(properties, "cdx:npm:releaseGapSampleSize"),
        ],
        values,
        version,
      );
      assert.strictEqual(getProperty(properties, "cdx:npm:versionCount"), "5");
    }
  });

  it("drops oversized registry values instead of copying them onto every version", () => {
    const longValue = "x".repeat(100_000);
    const packument = {
      maintainers: [{ name: longValue }],
      time: {
        "1.0.0": "2025-01-01T10:00:00.000Z",
        "1.0.1": "2025-01-11T10:00:00.000Z",
        created: longValue,
        modified: "2025-01-11T10:00:00.000Z",
      },
      versions: {
        "1.0.0": { maintainers: [{ name: longValue }] },
        "1.0.1": {
          maintainers: [{ name: "alice" }],
          dist: { integrity: "sha512-abc" },
        },
      },
    };
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "1.0.1",
    );
    assert.ok(properties.every((property) => property.value.length <= 4096));
    for (const name of [
      "cdx:npm:packageCreatedTime",
      "cdx:npm:publisher",
      "cdx:npm:priorMaintainerSet",
    ]) {
      assert.strictEqual(getProperty(properties, name), undefined, name);
    }
    assert.strictEqual(
      getProperty(properties, "cdx:npm:lastModifiedTime"),
      "2025-01-11T10:00:00.000Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSet"),
      "alice",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:priorVersion"),
      "1.0.0",
    );
  });
});

describe("maintainer and uploader set comparison", () => {
  it("compares two large disjoint npm maintainer lists", () => {
    const names = (prefix) =>
      Array.from({ length: 50000 }, (_, index) => ({
        name: `${prefix}-${index}`,
      }));
    const packument = {
      time: {
        "1.0.0": "2025-01-01T10:00:00.000Z",
        "2.0.0": "2025-02-01T10:00:00.000Z",
      },
      versions: {
        "1.0.0": { maintainers: names("old") },
        "2.0.0": { maintainers: names("new") },
      },
    };
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "2.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerSetDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:maintainerOverlapCount"),
      "0",
    );
  });

  it("compares two large disjoint PyPI uploader lists", () => {
    const files = (prefix, uploadTime) =>
      Array.from({ length: 20000 }, (_, index) => ({
        upload_time_iso_8601: uploadTime,
        uploader: `${prefix}-${index}`,
      }));
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "1.0.0": files("Old", "2025-01-01T10:00:00.000Z"),
          "2.0.0": files("New", "2025-02-01T10:00:00.000Z"),
        },
      },
      "2.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publisherDrift"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:uploaderSetDrift"),
      "true",
    );
  });

  it("does not report publisher drift when an uploader only changes case", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "1.0.0": [
            {
              upload_time_iso_8601: "2025-01-01T10:00:00.000Z",
              uploader: "Alice",
            },
          ],
          "2.0.0": [
            {
              upload_time_iso_8601: "2025-02-01T10:00:00.000Z",
              uploader: "alice",
            },
          ],
        },
      },
      "2.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publisherDrift"),
      undefined,
    );
  });
});

describe("registry documents shared by many locked versions", () => {
  // The metadata loops pass one registry document to the collector for every
  // locked version of a package; each call must still report the history
  // seen from its own version.
  const releaseCount = 4000;
  const releaseVersions = Array.from(
    { length: releaseCount },
    (_, index) => `1.0.${index}`,
  );
  const releaseTime = (index) =>
    new Date(Date.UTC(2020, 0, 1) + index * 3600 * 1000).toISOString();

  it("reads an npm release history for every version of a shared packument", () => {
    const time = {};
    releaseVersions.forEach((version, index) => {
      time[version] = releaseTime(index);
    });
    const packument = { time, versions: {} };
    let last;
    for (const version of releaseVersions) {
      last = collectNpmRegistryProvenanceProperties(packument, version);
    }
    assert.strictEqual(
      getProperty(last, "cdx:npm:priorVersion"),
      releaseVersions.at(-2),
    );
    assert.strictEqual(
      getProperty(last, "cdx:npm:versionCount"),
      String(releaseCount),
    );
  });

  it("compares many versions with the maintainer set of a shared prior release", () => {
    // Every locked version has the same publish time, so the one older
    // release is the prior release of all of them.
    const time = { "0.0.1": "2019-01-01T00:00:00.000Z" };
    const versions = {
      "0.0.1": {
        maintainers: Array.from({ length: 20000 }, (_, index) => ({
          name: `maintainer-${index}`,
        })),
      },
    };
    const lockedVersions = Array.from(
      { length: 2000 },
      (_, index) => `1.0.${index}`,
    );
    for (const version of lockedVersions) {
      time[version] = "2020-01-01T00:00:00.000Z";
      versions[version] = { maintainers: [{ name: "alice" }] };
    }
    const packument = { time, versions };
    let last;
    for (const version of lockedVersions) {
      last = collectNpmRegistryProvenanceProperties(packument, version);
    }
    assert.strictEqual(getProperty(last, "cdx:npm:priorVersion"), "0.0.1");
    assert.strictEqual(
      getProperty(last, "cdx:npm:priorMaintainerSetCount"),
      "20000",
    );
    assert.strictEqual(getProperty(last, "cdx:npm:maintainerSetDrift"), "true");
  });

  it("compares many versions with the uploader set of a shared PyPI prior release", () => {
    const releases = {
      "0.0.1": Array.from({ length: 20000 }, (_, index) => ({
        upload_time_iso_8601: "2019-01-01T00:00:00.000Z",
        uploader: `Uploader-${index}`,
      })),
    };
    const requestedVersions = Array.from(
      { length: 2000 },
      (_, index) => `1.0.${index}`,
    );
    for (const version of requestedVersions) {
      releases[version] = [
        { upload_time_iso_8601: "2020-01-01T00:00:00.000Z", uploader: "alice" },
      ];
    }
    const projectBody = { releases };
    let last;
    for (const version of requestedVersions) {
      last = collectPypiRegistryProvenanceProperties(projectBody, version);
    }
    assert.strictEqual(
      getProperty(last, "cdx:pypi:priorUploaderSetCount"),
      "20000",
    );
    assert.strictEqual(getProperty(last, "cdx:pypi:publisherDrift"), "true");
  });

  it("reads a PyPI release history for every requirement of a shared project", () => {
    const releases = {};
    releaseVersions.forEach((version, index) => {
      releases[version] = [{ upload_time_iso_8601: releaseTime(index) }];
    });
    const projectBody = { releases };
    let last;
    for (const version of releaseVersions) {
      last = collectPypiRegistryProvenanceProperties(projectBody, version);
    }
    assert.strictEqual(
      getProperty(last, "cdx:pypi:releaseGapSampleSize"),
      String(releaseCount - 2),
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

  it("keeps the digests of a release with many files but drops oversized values", () => {
    const digests = Array.from({ length: 120 }, (_, index) =>
      index.toString(16).padStart(64, "0"),
    );
    const properties = collectPypiRegistryProvenanceProperties(
      {
        releases: {
          "1.0.0": digests.map((sha256) => ({
            digests: { sha256 },
            upload_time_iso_8601: "2025-01-01T10:00:00.000Z",
            uploader: "u".repeat(100_000),
          })),
        },
      },
      "1.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:artifactDigestSha256"),
      digests.join(", "),
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:publisher"),
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

describe("collectNpmRegistryProvenanceProperties() on a real packument", () => {
  const packument = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-semver-packument.json",
      ),
      "utf8",
    ),
  );

  it("keeps a version the registry knows unmarked", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "7.7.2",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      undefined,
    );
    // The packument's own created and modified times, not guessed values.
    assert.strictEqual(
      getProperty(properties, "cdx:npm:packageCreatedTime"),
      packument.time.created,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:lastModifiedTime"),
      packument.time.modified,
    );
  });

  it("marks a version the registry does not know", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "9.9.9",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      "true",
    );
  });

  it("marks nothing when the component carries no version", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      undefined,
    );
  });
});

describe("collectPypiRegistryProvenanceProperties() on a real index response", () => {
  const projectBody = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/data/registry/pypi-requests.json"),
      "utf8",
    ),
  );

  it("records the newest release time for a known version", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      projectBody,
      "2.32.3",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionMissing"),
      undefined,
    );
    const latest = getProperty(properties, "cdx:pypi:latestPublishTime");
    assert.strictEqual(latest !== undefined, true);
    const created = getProperty(properties, "cdx:pypi:packageCreatedTime");
    assert.strictEqual(
      new Date(latest).getTime() >= new Date(created).getTime(),
      true,
    );
  });

  it("marks a version the index does not know", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      projectBody,
      "1.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionMissing"),
      "true",
    );
  });
});

describe("collectCargoRegistryProvenanceProperties() on a real crates.io response", () => {
  const crateBody = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/data/registry/cargo-serde.json"),
      "utf8",
    ),
  );

  it("records the newest release time for a known version", () => {
    const properties = collectCargoRegistryProvenanceProperties(
      crateBody,
      "1.0.210",
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:versionMissing"),
      undefined,
    );
    const latest = getProperty(properties, "cdx:cargo:latestPublishTime");
    assert.strictEqual(latest !== undefined, true);
    const created = getProperty(properties, "cdx:cargo:packageCreatedTime");
    assert.strictEqual(
      new Date(latest).getTime() >= new Date(created).getTime(),
      true,
    );
  });

  it("marks a version crates.io does not list", () => {
    const properties = collectCargoRegistryProvenanceProperties(
      crateBody,
      "0.0.1",
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:versionMissing"),
      "true",
    );
  });
});

describe("collectNpmRegistryProvenanceProperties() on the deprecations of a real packument", () => {
  // DefinitelyTyped deprecates only the stub release it publishes once a
  // package ships its own types, so the newest release is deprecated while
  // the version in use is not.
  const packument = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-types-component-emitter-packument.json",
      ),
      "utf8",
    ),
  );

  it("names the newest release's deprecation when the version in use is not deprecated", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "1.2.13",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:deprecation_notice"),
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:latest_deprecation_notice"),
      packument.versions[packument["dist-tags"].latest].deprecated,
    );
  });

  it("names the deprecation of the version in use itself", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "2.0.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:deprecation_notice"),
      packument.versions["2.0.0"].deprecated,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:latest_deprecation_notice"),
      undefined,
      "the newest release is the version in use, so there is no separate notice",
    );
  });

  it("writes no deprecation property for a packument with none", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "../../test/data/registry/npm-semver-packument.json",
          ),
          "utf8",
        ),
      ),
      "7.7.2",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:deprecation_notice"),
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:latest_deprecation_notice"),
      undefined,
    );
  });
});

describe("collectNpmRegistryProvenanceProperties() on a real platform-package packument", () => {
  // rollup ships its native code as separate platform packages declared in
  // optionalDependencies; its own version entry carries no os or cpu.
  const packument = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-rollup-packument.json",
      ),
      "utf8",
    ),
  );

  it("records the platform packages a version ships through", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      packument["dist-tags"].latest,
    );
    const listed = getProperty(
      properties,
      "cdx:npm:platformOptionalDependencies",
    );
    assert.ok(listed?.includes("@rollup/rollup-darwin-x64"));
    assert.ok(listed?.includes("@rollup/rollup-linux-x64-gnu"));
    assert.ok(listed?.includes("@rollup/rollup-win32-x64-msvc"));
    assert.strictEqual(getProperty(properties, "cdx:npm:os"), undefined);
  });
});

describe("collectNpmRegistryProvenanceProperties() on a real node-pre-gyp packument", () => {
  // sqlite3@5.1.7 declares a `binary` field whose entry names no host.
  const packument = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-sqlite3-packument.json",
      ),
      "utf8",
    ),
  );

  it("marks the version as downloading a native module", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "5.1.7",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:binaryDownload"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:binaryHost"),
      undefined,
    );
    // The install script is the parser's business, not the registry lookup's.
    assert.strictEqual(
      getProperty(properties, "cdx:npm:hasInstallScript"),
      undefined,
    );
  });
});

describe("collectPypiRegistryProvenanceProperties() on a real yanked release", () => {
  const projectBody = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/data/registry/pypi-attrs.json"),
      "utf8",
    ),
  );

  it("marks a yanked release with the index's reason", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      projectBody,
      "21.1.0",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:yanked"), "true");
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:yanked_reason"),
      projectBody.releases["21.1.0"][0].yanked_reason,
    );
  });

  it("leaves a release the index did not yank unmarked", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      projectBody,
      "22.1.0",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:yanked"), undefined);
  });

  it("does not hand a version the index does not list the yank of another release", () => {
    // The index's `urls` lists the files of its newest release. Here that is
    // the yanked one, and the requested version has no release of its own.
    const properties = collectPypiRegistryProvenanceProperties(
      { ...projectBody, urls: projectBody.releases["21.1.0"] },
      "0.1.0",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:yanked"), undefined);
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionMissing"),
      "true",
    );
  });
});

describe("collectCargoRegistryProvenanceProperties() on a real yanked version", () => {
  const crateBody = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/data/registry/cargo-anyhow.json"),
      "utf8",
    ),
  );

  it("marks the yanked version in use", () => {
    const properties = collectCargoRegistryProvenanceProperties(
      crateBody,
      "1.0.46",
      undefined,
    );
    assert.strictEqual(getProperty(properties, "cdx:cargo:yanked"), "true");
  });

  it("leaves a version crates.io did not yank unmarked", () => {
    const properties = collectCargoRegistryProvenanceProperties(
      crateBody,
      "1.0.47",
      undefined,
    );
    assert.strictEqual(getProperty(properties, "cdx:cargo:yanked"), undefined);
  });

  it("does not hand a version crates.io does not list the yank of the first listed one", () => {
    // The same two real entries with the yanked one listed first, which is
    // the entry the collector falls back to for an unknown version.
    const reordered = {
      ...crateBody,
      versions: [crateBody.versions[1], crateBody.versions[0]],
    };
    const properties = collectCargoRegistryProvenanceProperties(
      reordered,
      "0.0.1",
      undefined,
    );
    assert.strictEqual(getProperty(properties, "cdx:cargo:yanked"), undefined);
    assert.strictEqual(
      getProperty(properties, "cdx:cargo:versionMissing"),
      "true",
    );
  });
});

describe("collectPypiRegistryProvenanceProperties() on a real version document", () => {
  // `/pypi/<name>/<version>/json` has no `releases` map: `info` and `urls`
  // describe the one release.
  const requestsVersion = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/pypi-requests-2.31.0-version.json",
      ),
      "utf8",
    ),
  );
  const attrsVersion = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/pypi-attrs-21.1.0-version.json",
      ),
      "utf8",
    ),
  );
  const attrsProject = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../test/data/registry/pypi-attrs.json"),
      "utf8",
    ),
  );

  it("does not mark a release the index served as missing", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      requestsVersion,
      "2.31.0",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionMissing"),
      undefined,
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:yanked"), undefined);
    // Without the project document there is no history to count.
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionCount"),
      undefined,
    );
  });

  it("reads the yank from the version document's info", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      attrsVersion,
      "21.1.0",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:yanked"), "true");
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:yanked_reason"),
      attrsVersion.info.yanked_reason,
    );
  });

  it("takes the age and newest release from the project document", () => {
    const properties = collectPypiRegistryProvenanceProperties(
      attrsVersion,
      "21.1.0",
      { projectBody: attrsProject },
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:packageCreatedTime"),
      "2021-05-06T08:26:59.426Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:latestPublishTime"),
      "2022-07-28T13:20:27.076Z",
    );
    assert.strictEqual(getProperty(properties, "cdx:pypi:versionCount"), "2");
    assert.strictEqual(
      getProperty(properties, "cdx:pypi:versionMissing"),
      undefined,
    );
  });

  it("marks a version missing only on a real signal", () => {
    assert.strictEqual(
      getProperty(
        collectPypiRegistryProvenanceProperties(attrsProject, "21.1.0", {
          projectBody: attrsProject,
          versionNotFound: true,
        }),
        "cdx:pypi:versionMissing",
      ),
      "true",
    );
    // A spelling PEP 440 treats as the same release is not missing.
    for (const spelling of ["21.1", "21.1.0.0", "v21.1.0"]) {
      assert.strictEqual(
        getProperty(
          collectPypiRegistryProvenanceProperties(attrsProject, spelling),
          "cdx:pypi:versionMissing",
        ),
        undefined,
        spelling,
      );
    }
  });
});

describe("canonicalPypiVersion()", () => {
  it("compares the spellings PEP 440 treats as one release", () => {
    for (const [left, right] of [
      ["1.0", "1.0.0"],
      ["1.0RC1", "1.0rc1"],
      ["1.0-rc.1", "1.0rc1"],
      ["1.0.alpha2", "1.0a2"],
      ["1.0-post1", "1.0.post1"],
      ["1.0-1", "1.0.post1"],
      ["1.0.dev", "1.0.dev0"],
      ["0!1.0", "1.0"],
      ["01.02", "1.2"],
      ["1.0+Local_1", "1.0+local.1"],
    ]) {
      assert.strictEqual(
        canonicalPypiVersion(left),
        canonicalPypiVersion(right),
        `${left} = ${right}`,
      );
    }
    assert.notStrictEqual(
      canonicalPypiVersion("1.0.1"),
      canonicalPypiVersion("1.0"),
    );
    assert.notStrictEqual(
      canonicalPypiVersion("1.0rc1"),
      canonicalPypiVersion("1.0"),
    );
  });
});

describe("collectNpmRegistryProvenanceProperties() on versions the packument holds under another key or no longer holds", () => {
  const eventStream = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-event-stream-packument.json",
      ),
      "utf8",
    ),
  );
  const semverPackument = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../test/data/registry/npm-semver-packument.json",
      ),
      "utf8",
    ),
  );

  it("marks an unpublished version, whose publish time npm keeps", () => {
    assert.ok(eventStream.time["3.3.6"]);
    const properties = collectNpmRegistryProvenanceProperties(
      eventStream,
      "3.3.6",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      "true",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionUnpublished"),
      "true",
    );
  });

  it("records the newest release time, not the packument's modification time", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      eventStream,
      "4.0.1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:latestPublishTime"),
      "2018-09-29T06:55:49.107Z",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:lastModifiedTime"),
      "2022-11-08T10:38:35.230Z",
    );
  });

  it("finds a version with build metadata under its registry key", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      semverPackument,
      "7.7.2+build.1",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      undefined,
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:publishTime"),
      semverPackument.time["7.7.2"],
    );
  });

  it("leaves the version unmarked when the caller has no registry evidence for it", () => {
    const properties = collectNpmRegistryProvenanceProperties(
      semverPackument,
      "99.0.0",
      { versionPresenceEvidence: false },
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:versionMissing"),
      undefined,
    );
  });

  it("names the newest release when only it is deprecated", () => {
    const packument = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../test/data/registry/npm-types-component-emitter-packument.json",
        ),
        "utf8",
      ),
    );
    const properties = collectNpmRegistryProvenanceProperties(
      packument,
      "1.2.13",
    );
    assert.strictEqual(
      getProperty(properties, "cdx:npm:latest_deprecated_version"),
      "2.0.0",
    );
  });
});

describe("collectNpmRegistryProvenanceProperties() on native install scripts and platform packages", () => {
  const load = (name) =>
    JSON.parse(
      readFileSync(
        join(import.meta.dirname, `../../test/data/registry/${name}`),
        "utf8",
      ),
    );

  it("names the native build tools an install script runs", () => {
    assert.strictEqual(
      getProperty(
        collectNpmRegistryProvenanceProperties(
          load("npm-bufferutil-packument.json"),
          "4.0.8",
        ),
        "cdx:npm:nativeBuildTool",
      ),
      "node-gyp-build",
    );
    assert.strictEqual(
      getProperty(
        collectNpmRegistryProvenanceProperties(
          load("npm-better-sqlite3-packument.json"),
          "12.11.1",
        ),
        "cdx:npm:nativeBuildTool",
      ),
      "node-gyp, prebuild-install",
    );
    // A test or build script running node-gyp is not run at install time.
    assert.strictEqual(
      getProperty(
        collectNpmRegistryProvenanceProperties(
          {
            versions: {
              "1.0.0": {
                scripts: {
                  build: "node-gyp rebuild",
                  install: "echo node-gyp-buildx",
                },
              },
            },
          },
          "1.0.0",
        ),
        "cdx:npm:nativeBuildTool",
      ),
      undefined,
    );
  });

  it("matches platform words as whole name parts", () => {
    const withOptional = (optionalDependencies) =>
      getProperty(
        collectNpmRegistryProvenanceProperties(
          { versions: { "1.0.0": { optionalDependencies } } },
          "1.0.0",
        ),
        "cdx:npm:platformOptionalDependencies",
      );
    assert.strictEqual(
      withOptional({
        "@esbuild/darwin-arm64": "1.0.0",
        "@img/sharp-linuxmusl-x64": "1.0.0",
        "fsevents-linux": "1.0.0",
      }),
      "@esbuild/darwin-arm64, @img/sharp-linuxmusl-x64, fsevents-linux",
    );
    assert.strictEqual(
      withOptional({
        aixgen: "1.0.0",
        linuxify: "1.0.0",
        "@darwinia/api": "1.0.0",
        "muslim-prayer-times": "1.0.0",
      }),
      undefined,
    );
  });
});

describe("isoTimestamp()", () => {
  it("writes registry times as ISO 8601 UTC and drops what it cannot read", () => {
    assert.strictEqual(
      isoTimestamp("2023-05-22T15:12:42.313790Z"),
      "2023-05-22T15:12:42.313Z",
    );
    assert.strictEqual(
      isoTimestamp("2019-10-04T21:22:49.209036+00:00"),
      "2019-10-04T21:22:49.209Z",
    );
    assert.strictEqual(
      isoTimestamp("2023-05-22T15:12:44"),
      "2023-05-22T15:12:44.000Z",
    );
    assert.strictEqual(
      isoTimestamp("2023-05-22 15:12:44"),
      "2023-05-22T15:12:44.000Z",
    );
    assert.strictEqual(isoTimestamp("garbage"), undefined);
    assert.strictEqual(isoTimestamp(undefined), undefined);
  });
});
