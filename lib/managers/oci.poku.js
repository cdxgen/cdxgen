import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

import { isSameRegistryHost } from "./oci.js";

async function loadOciModule({ cdxgenAgentMock, env }) {
  return esmock("./oci.js", {
    "../core/activity.js": {
      cdxgenAgent: cdxgenAgentMock,
      ...(env && { readEnvironmentVariable: (varName) => env[varName] }),
    },
    "../core/fs.js": { safeExistsSync: () => false },
  });
}

describe("getBomWithOras() native implementation", () => {
  const agentServing = (blobText) => {
    const agent = { get: sinon.stub() };
    agent.get.onCall(0).resolves({ statusCode: 401, headers: {} });
    agent.get.onCall(1).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:targetdigest",
        "content-type": "application/vnd.docker.distribution.manifest.v2+json",
      },
      body: JSON.stringify({ layers: [] }),
    });
    agent.get.onCall(2).resolves({
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
    const manifest = (digest) => ({
      statusCode: 200,
      headers: {
        "docker-content-digest": digest,
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({ layers: [{ digest: "sha256:blobdigest" }] }),
    });
    agent.get.onCall(3).resolves(manifest("sha256:newer"));
    agent.get.onCall(4).resolves({
      statusCode: 200,
      headers: {},
      body: Buffer.from(blobText),
    });
    agent.get.onCall(5).resolves(manifest("sha256:older"));
    agent.get.onCall(6).resolves({
      statusCode: 200,
      headers: {},
      body: Buffer.from('{"bomFormat":"CycloneDX","specVersion":"1.6"}'),
    });
    return agent;
  };

  it("passes the BOM bytes to checkBytes and does not fall back when it throws", async () => {
    const duplicated =
      '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"version":2}';
    const checked = [];
    const { getBomWithOras } = await loadOciModule({
      cdxgenAgentMock: agentServing(duplicated),
    });
    await assert.rejects(
      getBomWithOras("ghcr.io/cdxgen/alpine-python313:master", undefined, {
        checkBytes: (bytes) => {
          checked.push(bytes.toString("utf8"));
          throw new Error("refused");
        },
      }),
      /refused/,
    );
    assert.deepStrictEqual(checked, [duplicated]);

    const lenient = await loadOciModule({
      cdxgenAgentMock: agentServing(duplicated),
    });
    const bom = await lenient.getBomWithOras(
      "ghcr.io/cdxgen/alpine-python313:master",
    );
    assert.strictEqual(bom.version, 2);
  });

  it("tells a registry that failed from one that has no SBOM when asked to report errors", async () => {
    const image = "ghcr.io/cdxgen/alpine-python313:master";
    const agentAnswering = (manifestResponse) => {
      const agent = { get: sinon.stub() };
      agent.get.onCall(0).resolves({ statusCode: 200, headers: {} });
      if (manifestResponse instanceof Error) {
        agent.get.onCall(1).rejects(manifestResponse);
      } else {
        agent.get.onCall(1).resolves(manifestResponse);
      }
      return agent;
    };
    for (const failure of [
      { statusCode: 503, headers: {}, body: "" },
      { statusCode: 429, headers: {}, body: "" },
      new Error("connect ECONNREFUSED"),
    ]) {
      const strict = await loadOciModule({
        cdxgenAgentMock: agentAnswering(failure),
      });
      await assert.rejects(
        strict.getBomWithOras(image, undefined, { reportErrors: true }),
      );
      // Other callers still see "not found"
      const lenient = await loadOciModule({
        cdxgenAgentMock: agentAnswering(failure),
      });
      assert.strictEqual(await lenient.getBomWithOras(image), undefined);
    }
    // A 404 is an answer
    const missing = await loadOciModule({
      cdxgenAgentMock: agentAnswering({
        statusCode: 404,
        headers: {},
        body: "",
      }),
    });
    assert.strictEqual(
      await missing.getBomWithOras(image, undefined, { reportErrors: true }),
      undefined,
    );
  });

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

  // Serves a referrers list whose every artifact carries a JSON layer that is
  // not a CycloneDX BOM, so the lookup moves on to the next candidate.
  const agentServingReferrers = (manifests) => {
    const agent = { get: sinon.stub() };
    agent.get.callsFake(async (url) => {
      if (url.endsWith("/v2/")) {
        return { statusCode: 401, headers: {} };
      }
      if (url.endsWith("/manifests/nightly")) {
        return {
          statusCode: 200,
          headers: { "docker-content-digest": "sha256:targetdigest" },
          body: JSON.stringify({ layers: [] }),
        };
      }
      if (url.includes("/referrers/")) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ manifests }),
        };
      }
      if (url.includes("/manifests/")) {
        return {
          statusCode: 200,
          headers: {},
          body: JSON.stringify({ layers: [{ digest: "sha256:blobdigest" }] }),
        };
      }
      return { statusCode: 200, headers: {}, body: Buffer.from("[]") };
    });
    return agent;
  };
  const referrerManifestUrls = (agent) =>
    agent.get
      .getCalls()
      .map((call) => call.args[0])
      .filter((url) => url.includes("/manifests/sha256:"));

  it("tries a referrer that is listed many times only once", async () => {
    const cdxgenAgentMock = agentServingReferrers(
      Array(500).fill({ digest: "sha256:artifact" }),
    );
    const { getBomWithOras } = await loadOciModule({ cdxgenAgentMock });

    const result = await getBomWithOras(
      "ghcr.io/cdxgen/debian-dotnet6:nightly",
    );
    assert.strictEqual(result, undefined);
    assert.deepStrictEqual(referrerManifestUrls(cdxgenAgentMock), [
      "https://ghcr.io/v2/cdxgen/debian-dotnet6/manifests/sha256:artifact",
    ]);
  });

  it("tries only the newest few of many distinct referrers", async () => {
    const cdxgenAgentMock = agentServingReferrers(
      Array.from({ length: 500 }, (_, i) => ({
        digest: `sha256:artifact${i}`,
      })),
    );
    const { getBomWithOras } = await loadOciModule({ cdxgenAgentMock });

    const result = await getBomWithOras(
      "ghcr.io/cdxgen/debian-dotnet6:nightly",
    );
    assert.strictEqual(result, undefined);
    const tried = referrerManifestUrls(cdxgenAgentMock);
    assert.strictEqual(tried.length, 20);
    assert.strictEqual(
      tried[0],
      "https://ghcr.io/v2/cdxgen/debian-dotnet6/manifests/sha256:artifact499",
    );
  });
});

describe("OCI token realm credential handling", () => {
  it("isSameRegistryHost accepts only the registry origin", () => {
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
      isSameRegistryHost(
        "registry.example.com",
        new URL("http://registry.example.com/token"),
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
    const savedDockerServerAddress = process.env.DOCKER_SERVER_ADDRESS;
    process.env.DOCKER_SERVER_ADDRESS = "localhost:5999";
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
      if (savedDockerServerAddress === undefined) {
        delete process.env.DOCKER_SERVER_ADDRESS;
      } else {
        process.env.DOCKER_SERVER_ADDRESS = savedDockerServerAddress;
      }
    }
  });

  it("still authenticates to a same-host realm with stored credentials", async () => {
    const cdxgenAgentMock = { get: sinon.stub() };
    const oci = await loadOciModule({ cdxgenAgentMock });
    const savedDockerAuth = process.env.DOCKER_AUTH;
    const savedDockerServerAddress = process.env.DOCKER_SERVER_ADDRESS;
    process.env.DOCKER_SERVER_ADDRESS = "localhost:5999";
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
      if (savedDockerServerAddress === undefined) {
        delete process.env.DOCKER_SERVER_ADDRESS;
      } else {
        process.env.DOCKER_SERVER_ADDRESS = savedDockerServerAddress;
      }
    }
  });

  it("keeps DOCKER_AUTH away from registries other than DOCKER_SERVER_ADDRESS", async () => {
    const DOCKER_AUTH = Buffer.from("victim:supersecret").toString("base64");
    // The registry comes from scanned content (a compose file, Dockerfile or
    // BOM under --bom-audit), so the login must stay with the registry the
    // operator configured it for: DOCKER_SERVER_ADDRESS, or docker.io.
    for (const DOCKER_SERVER_ADDRESS of [undefined, "registry.corp.example"]) {
      const cdxgenAgentMock = { get: sinon.stub() };
      const oci = await loadOciModule({
        cdxgenAgentMock,
        env: { DOCKER_AUTH, DOCKER_SERVER_ADDRESS },
      });
      // /v2/ handshake naming a realm on the hostile registry itself
      cdxgenAgentMock.get.onCall(0).resolves({
        statusCode: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="http://localhost:5999/token",service="evil"',
        },
      });
      // No token, so the client would fall back to Basic auth
      cdxgenAgentMock.get.onCall(1).resolves({ body: {} });
      cdxgenAgentMock.get.onCall(2).resolves({
        statusCode: 404,
        headers: {},
        body: undefined,
      });

      await oci.getBomWithOras("localhost:5999/fake/image:latest");

      assert.strictEqual(cdxgenAgentMock.get.callCount, 3);
      for (const call of cdxgenAgentMock.get.getCalls()) {
        assert.strictEqual(
          call.args[1]?.headers?.Authorization,
          undefined,
          `credentials must not be sent to ${call.args[0]}`,
        );
      }
    }
  });
});

describe("OCI referrer descriptor handling", () => {
  it("keeps referrer requests on the image's own registry and repository", async () => {
    const bomJson = { bomFormat: "CycloneDX", specVersion: "1.6" };
    const cdxgenAgentMock = { get: sinon.stub() };
    const oci = await loadOciModule({ cdxgenAgentMock });
    const savedDockerAuth = process.env.DOCKER_AUTH;
    process.env.DOCKER_AUTH =
      Buffer.from("victim:supersecret").toString("base64");
    try {
      const expectedAuth = `Basic ${process.env.DOCKER_AUTH}`;
      // /v2/ on a Basic-auth registry: no bearer challenge, so the stored
      // credential itself is used as the token
      cdxgenAgentMock.get.onCall(0).resolves({ statusCode: 200, headers: {} });
      // Target manifest
      cdxgenAgentMock.get.onCall(1).resolves({
        statusCode: 200,
        headers: {
          "docker-content-digest": "sha256:targetdigest",
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: JSON.stringify({ layers: [] }),
      });
      // No referrers API
      cdxgenAgentMock.get.onCall(2).resolves({ statusCode: 404, headers: {} });
      cdxgenAgentMock.get.onCall(3).resolves({ statusCode: 404, headers: {} });
      // Referrers tag schema: an index anyone with push access can write
      cdxgenAgentMock.get.onCall(4).resolves({
        statusCode: 200,
        headers: {},
        body: JSON.stringify({
          manifests: [
            {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              artifactType: "application/vnd.cyclonedx+json",
              digest: "sha256:sbom",
              reference: "attacker.example/any/thing:latest",
            },
            {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              artifactType: "application/vnd.cyclonedx+json",
              reference: "attacker.example/no/digest:latest",
            },
            {
              mediaType: "application/vnd.oci.image.manifest.v1+json",
              artifactType: "application/vnd.cyclonedx+json",
              digest: "sha256:x/../../../other/repo/manifests/latest",
            },
          ],
        }),
      });
      // SBOM artifact manifest
      cdxgenAgentMock.get.onCall(5).resolves({
        statusCode: 200,
        headers: {
          "docker-content-digest": "sha256:sbom",
          "content-type": "application/vnd.oci.image.manifest.v1+json",
        },
        body: JSON.stringify({
          layers: [
            {
              mediaType: "application/vnd.cyclonedx+json",
              digest: "sha256:sbomblob",
            },
          ],
        }),
      });
      // SBOM blob
      cdxgenAgentMock.get.onCall(6).resolves({
        statusCode: 200,
        headers: {},
        body: Buffer.from(JSON.stringify(bomJson)),
      });

      const result = await oci.getBomWithOras("localhost:5999/team/app:latest");

      assert.deepStrictEqual(result, bomJson);
      assert.strictEqual(
        cdxgenAgentMock.get.getCall(5).args[0],
        "http://localhost:5999/v2/team/app/manifests/sha256:sbom",
      );
      assert.strictEqual(
        cdxgenAgentMock.get.getCall(5).args[1]?.headers?.Authorization,
        expectedAuth,
      );
      assert.strictEqual(
        cdxgenAgentMock.get.getCall(6).args[0],
        "http://localhost:5999/v2/team/app/blobs/sha256:sbomblob",
      );
      // The descriptors without a well-formed digest are dropped
      assert.strictEqual(cdxgenAgentMock.get.callCount, 7);
      for (const call of cdxgenAgentMock.get.getCalls()) {
        assert.ok(
          call.args[0] === "http://localhost:5999/v2/" ||
            call.args[0].startsWith("http://localhost:5999/v2/team/app/"),
          `request must stay on the image's registry and repository: ${call.args[0]}`,
        );
      }
    } finally {
      if (savedDockerAuth === undefined) {
        delete process.env.DOCKER_AUTH;
      } else {
        process.env.DOCKER_AUTH = savedDockerAuth;
      }
    }
  });

  it("skips a referrer manifest whose layer digest is malformed", async () => {
    const cdxgenAgentMock = { get: sinon.stub() };
    const { getBomWithOras } = await loadOciModule({ cdxgenAgentMock });
    cdxgenAgentMock.get.onCall(0).resolves({ statusCode: 401, headers: {} });
    cdxgenAgentMock.get.onCall(1).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:targetdigest",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({ layers: [] }),
    });
    cdxgenAgentMock.get.onCall(2).resolves({
      statusCode: 200,
      headers: {},
      body: JSON.stringify({
        manifests: [
          {
            artifactType: "application/vnd.cyclonedx+json",
            digest: "sha256:sbom",
          },
        ],
      }),
    });
    cdxgenAgentMock.get.onCall(3).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:sbom",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: JSON.stringify({
        layers: [
          {
            mediaType: "application/vnd.cyclonedx+json",
            digest: "sha256:x/../../../other/repo/blobs/sha256:secret",
          },
        ],
      }),
    });

    const result = await getBomWithOras("ghcr.io/team/app:latest");

    assert.strictEqual(result, undefined);
    assert.strictEqual(cdxgenAgentMock.get.callCount, 4);
  });

  it("keeps the registry token off a cross-host blob upload location", async () => {
    const expectedAuth = "Bearer push-token";
    for (const [location, uploadPrefix, uploadAuth] of [
      [
        "/v2/fake/image/blobs/uploads/session-1",
        "http://localhost:5999/v2/fake/image/blobs/uploads/session-1?digest=",
        expectedAuth,
      ],
      [
        "http://localhost:5999/v2/fake/image/blobs/uploads/session-1",
        "http://localhost:5999/v2/fake/image/blobs/uploads/session-1?digest=",
        expectedAuth,
      ],
      [
        "http://attacker.example/upload/session-1",
        "http://attacker.example/upload/session-1?digest=",
        undefined,
      ],
    ]) {
      const cdxgenAgentMock = {
        get: sinon.stub(),
        post: sinon.stub().resolves({ statusCode: 202, headers: { location } }),
        put: sinon.stub().resolves({ statusCode: 201, headers: {} }),
      };
      const oci = await loadOciModule({ cdxgenAgentMock });
      cdxgenAgentMock.get.onCall(0).resolves({
        statusCode: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="http://localhost:5999/token",service="local"',
        },
      });
      cdxgenAgentMock.get.onCall(1).resolves({
        body: { token: "push-token" },
      });
      // Target manifest
      cdxgenAgentMock.get.onCall(2).resolves({
        statusCode: 200,
        headers: { "docker-content-digest": "sha256:targetdigest" },
        body: JSON.stringify({ layers: [] }),
      });
      // Referrers API probe
      cdxgenAgentMock.get.onCall(3).resolves({ statusCode: 200, headers: {} });

      await oci.attachBomNative("localhost:5999/fake/image:latest", {
        bomFormat: "CycloneDX",
        specVersion: "1.6",
      });

      // BOM blob, empty config blob and the manifest
      assert.strictEqual(cdxgenAgentMock.put.callCount, 3);
      for (const call of cdxgenAgentMock.put.getCalls().slice(0, 2)) {
        assert.ok(
          call.args[0].startsWith(uploadPrefix),
          `blob upload goes to ${call.args[0]}`,
        );
        assert.strictEqual(call.args[1]?.headers?.Authorization, uploadAuth);
      }
      assert.strictEqual(
        cdxgenAgentMock.put.getCall(2).args[1]?.headers?.Authorization,
        expectedAuth,
        "the manifest push to the registry stays authenticated",
      );
    }
  });
});
