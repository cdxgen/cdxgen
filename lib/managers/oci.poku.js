import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { isSameRegistryHost } from "./oci.js";

async function loadOciModule({ cdxgenAgentMock }) {
  return esmock("./oci.js", {
    "../core/activity.js": { cdxgenAgent: cdxgenAgentMock },
    "../core/fs.js": { safeExistsSync: () => false },
  });
}

describe("getBomWithOras() native implementation", () => {
  it("pulls the newest digest-only SBOM referrer", async () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      signature: {
        algorithm: "RS512",
        value: "signed",
      },
    };

    const cdxgenAgentMock = {
      get: sinon.stub(),
    };

    // Mock get docker creds - implicitly false via safeExistsSync mock

    // Mock /v2/ auth check
    cdxgenAgentMock.get.onCall(0).resolves({
      statusCode: 401,
      headers: {},
    });

    // Mock fetch target manifest
    cdxgenAgentMock.get.onCall(1).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:targetdigest",
        "content-type": "application/vnd.docker.distribution.manifest.v2+json",
      },
      body: JSON.stringify({ layers: [] }),
    });

    // Mock discover referrers
    cdxgenAgentMock.get.onCall(2).resolves({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({
        manifests: [
          {
            digest: "sha256:older",
            annotations: {
              "org.opencontainers.image.created": "2026-04-29T01:26:38Z",
            },
          },
          {
            digest: "sha256:newer",
            annotations: {
              "org.opencontainers.image.created": "2026-04-29T02:00:20Z",
            },
          },
        ],
      }),
    });

    // Mock fetch referrer manifest
    cdxgenAgentMock.get.onCall(3).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:newer",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({
        layers: [{ digest: "sha256:blobdigest" }],
      }),
    });

    // Mock pull blob
    cdxgenAgentMock.get.onCall(4).resolves({
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(bomJson)),
    });

    const { getBomWithOras } = await loadOciModule({
      cdxgenAgentMock,
    });

    const result = await getBomWithOras(
      "ghcr.io/cdxgen/alpine-python313:master",
    );
    assert.deepStrictEqual(result, bomJson);

    // Validate auth check
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(0).args[0],
      "https://ghcr.io/v2/",
    );
    // Validate target manifest fetch
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(1).args[0],
      "https://ghcr.io/v2/cdxgen/alpine-python313/manifests/master",
    );
    // Validate referrers fetch
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(2).args[0],
      "https://ghcr.io/v2/cdxgen/alpine-python313/referrers/sha256:targetdigest?artifactType=application/vnd.cyclonedx+json",
    );
    // Validate referrer manifest fetch
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(3).args[0],
      "https://ghcr.io/v2/cdxgen/alpine-python313/manifests/sha256:newer",
    );
    // Validate blob pull
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(4).args[0],
      "https://ghcr.io/v2/cdxgen/alpine-python313/blobs/sha256:blobdigest",
    );
  });

  it("skips newer non-CycloneDX referrers and picks the SBOM (nightly tag)", async () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      signature: {
        algorithm: "RS512",
        value: "signed",
      },
    };

    const cdxgenAgentMock = {
      get: sinon.stub(),
    };

    // Mock /v2/ auth check
    cdxgenAgentMock.get.onCall(0).resolves({
      statusCode: 401,
      headers: {},
    });

    // Mock fetch target manifest
    cdxgenAgentMock.get.onCall(1).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:targetdigest",
        "content-type": "application/vnd.docker.distribution.manifest.v2+json",
      },
      body: JSON.stringify({ layers: [] }),
    });

    // Mock discover referrers. ghcr.io ignores the artifactType query filter and
    // returns every referrer. The newest one here is a build-provenance
    // attestation (not a CycloneDX SBOM), which previously got selected and
    // failed to parse as JSON.
    cdxgenAgentMock.get.onCall(2).resolves({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({
        manifests: [
          {
            digest: "sha256:sbom",
            artifactType: "application/vnd.cyclonedx+json",
            annotations: {
              "org.opencontainers.image.created": "2026-04-29T01:26:38Z",
            },
          },
          {
            digest: "sha256:provenance",
            artifactType: "application/vnd.dev.sigstore.bundle.v0.3+json",
            annotations: {
              "org.opencontainers.image.created": "2026-04-29T03:00:00Z",
            },
          },
        ],
      }),
    });

    // Mock fetch of the CycloneDX referrer manifest
    cdxgenAgentMock.get.onCall(3).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:sbom",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({
        layers: [{ digest: "sha256:sbomblob" }],
      }),
    });

    // Mock pull blob
    cdxgenAgentMock.get.onCall(4).resolves({
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(bomJson)),
    });

    const { getBomWithOras } = await loadOciModule({
      cdxgenAgentMock,
    });

    const result = await getBomWithOras(
      "ghcr.io/cdxgen/debian-dotnet6:nightly",
    );
    assert.deepStrictEqual(result, bomJson);

    // The CycloneDX referrer manifest must be fetched, not the newer provenance.
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(3).args[0],
      "https://ghcr.io/v2/cdxgen/debian-dotnet6/manifests/sha256:sbom",
    );
  });

  it("falls back to the referrers tag schema when the referrers API returns HTML (ghcr.io)", async () => {
    const bomJson = {
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      signature: { algorithm: "RS512", value: "signed" },
    };

    const cdxgenAgentMock = {
      get: sinon.stub(),
    };

    // Auth check
    cdxgenAgentMock.get.onCall(0).resolves({ statusCode: 401, headers: {} });

    // Target manifest
    cdxgenAgentMock.get.onCall(1).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:targetdigest",
        "content-type": "application/vnd.docker.distribution.manifest.v2+json",
      },
      body: JSON.stringify({ layers: [] }),
    });

    // discoverReferrers (filtered) -> ghcr answers 404 with an HTML page
    cdxgenAgentMock.get.onCall(2).resolves({
      statusCode: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "\n\n<!DOCTYPE html>\n<html><body>Not Found</body></html>",
    });

    // Unfiltered referrers probe -> also 404 HTML
    cdxgenAgentMock.get.onCall(3).resolves({
      statusCode: 404,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "\n\n<!DOCTYPE html>\n<html><body>Not Found</body></html>",
    });

    // Referrers tag schema (sha256-<digest>) -> the SBOM image index
    cdxgenAgentMock.get.onCall(4).resolves({
      statusCode: 200,
      headers: {
        "content-type": "application/vnd.oci.image.index.v1+json",
      },
      body: JSON.stringify({
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            digest: "sha256:sbom",
            artifactType: "application/vnd.cyclonedx+json",
          },
        ],
      }),
    });

    // Fetch the SBOM referrer manifest
    cdxgenAgentMock.get.onCall(5).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:sbom",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({
        layers: [
          {
            digest: "sha256:sbomblob",
            mediaType: "application/vnd.cyclonedx+json",
          },
        ],
      }),
    });

    // Pull the SBOM blob
    cdxgenAgentMock.get.onCall(6).resolves({
      statusCode: 200,
      headers: {},
      body: Buffer.from(JSON.stringify(bomJson)),
    });

    const { getBomWithOras } = await loadOciModule({ cdxgenAgentMock });

    const result = await getBomWithOras(
      "ghcr.io/cdxgen/debian-dotnet6:nightly",
    );
    assert.deepStrictEqual(result, bomJson);

    // The referrers tag schema must have been queried after the API 404s.
    assert.strictEqual(
      cdxgenAgentMock.get.getCall(4).args[0],
      "https://ghcr.io/v2/cdxgen/debian-dotnet6/manifests/sha256-targetdigest",
    );
  });
});

describe("OCI token realm credential handling", () => {
  it("isSameRegistryHost accepts only the registry host and port", () => {
    assert.strictEqual(
      isSameRegistryHost(
        "localhost:5999",
        new URL("http://localhost:5999/token"),
      ),
      true,
    );
    assert.strictEqual(
      isSameRegistryHost(
        "registry.example.com",
        new URL("https://registry.example.com/token?service=x"),
      ),
      true,
    );
    assert.strictEqual(
      isSameRegistryHost(
        "localhost:5999",
        new URL("http://127.0.0.1:5998/token"),
      ),
      false,
    );
    assert.strictEqual(
      isSameRegistryHost(
        "registry.example.com",
        new URL("https://registry.example.com:5000/token"),
      ),
      false,
    );
    assert.strictEqual(
      isSameRegistryHost("docker.io", new URL("https://auth.docker.io/token")),
      false,
    );
    assert.strictEqual(
      isSameRegistryHost("registry.example.com", undefined),
      false,
    );
  });

  it("does not forward stored registry credentials to a cross-host realm", async () => {
    const cdxgenAgentMock = { get: sinon.stub() };
    const oci = await loadOciModule({ cdxgenAgentMock });
    const savedDockerAuth = process.env.DOCKER_AUTH;
    process.env.DOCKER_AUTH =
      Buffer.from("victim:supersecret").toString("base64");
    try {
      // /v2/ handshake on the evil registry
      cdxgenAgentMock.get.onCall(0).resolves({
        statusCode: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="http://attacker.example/token",service="evil"',
        },
      });
      // The realm request the attacker chose
      cdxgenAgentMock.get.onCall(1).resolves({
        body: { token: "attacker-token" },
      });
      // Manifest request with whatever token came back
      cdxgenAgentMock.get.onCall(2).resolves({
        statusCode: 404,
        headers: {},
        body: undefined,
      });

      await oci.getBomWithOras("localhost:5999/fake/image:latest");

      const realmCall = cdxgenAgentMock.get.getCall(1);
      assert.strictEqual(
        realmCall.args[0],
        "http://attacker.example/token?service=evil&scope=repository%3Afake%2Fimage%3Apull",
      );
      assert.strictEqual(
        realmCall.args[1]?.headers?.Authorization,
        undefined,
        "credentials must not be sent to a realm on another host",
      );
    } finally {
      if (savedDockerAuth === undefined) {
        delete process.env.DOCKER_AUTH;
      } else {
        process.env.DOCKER_AUTH = savedDockerAuth;
      }
    }
  });

  it("still authenticates to a same-host realm with stored credentials", async () => {
    const cdxgenAgentMock = { get: sinon.stub() };
    const oci = await loadOciModule({ cdxgenAgentMock });
    const savedDockerAuth = process.env.DOCKER_AUTH;
    process.env.DOCKER_AUTH = Buffer.from("victim:ok").toString("base64");
    try {
      cdxgenAgentMock.get.onCall(0).resolves({
        statusCode: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="http://localhost:5999/token",service="local"',
        },
      });
      cdxgenAgentMock.get.onCall(1).resolves({
        body: { token: "good-token" },
      });
      cdxgenAgentMock.get.onCall(2).resolves({
        statusCode: 404,
        headers: {},
        body: undefined,
      });

      const expectedAuth = `Basic ${process.env.DOCKER_AUTH}`;
      await oci.getBomWithOras("localhost:5999/fake/image:latest");

      const realmCall = cdxgenAgentMock.get.getCall(1);
      assert.strictEqual(
        realmCall.args[1]?.headers?.Authorization,
        expectedAuth,
        "same-host realm requests keep the stored credentials",
      );
      assert.strictEqual(
        realmCall.args[1]?.cache,
        false,
        "short-lived tokens must not be served from the response cache",
      );
    } finally {
      if (savedDockerAuth === undefined) {
        delete process.env.DOCKER_AUTH;
      } else {
        process.env.DOCKER_AUTH = savedDockerAuth;
      }
    }
  });
});
