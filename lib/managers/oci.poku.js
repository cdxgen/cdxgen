import esmock from "esmock";
import { assert, describe, it } from "poku";
import sinon from "sinon";

async function loadOciModule({ cdxgenAgentMock }) {
  return esmock("./oci.js", {
    "../helpers/utils.js": {
      cdxgenAgent: cdxgenAgentMock,
      safeExistsSync: () => false,
    },
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
      body: { layers: [] },
    });

    // Mock discover referrers
    cdxgenAgentMock.get.onCall(2).resolves({
      statusCode: 200,
      headers: {},
      body: {
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
      },
    });

    // Mock fetch referrer manifest
    cdxgenAgentMock.get.onCall(3).resolves({
      statusCode: 200,
      headers: {
        "docker-content-digest": "sha256:newer",
        "content-type": "application/vnd.oci.image.manifest.v1+json",
      },
      body: {
        layers: [{ digest: "sha256:blobdigest" }],
      },
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
});
