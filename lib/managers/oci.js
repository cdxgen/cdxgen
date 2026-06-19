import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { isCycloneDxBom } from "../helpers/bomUtils.js";
import { cdxgenAgent, getAllFiles, safeExistsSync } from "../helpers/utils.js";

const ORAS_CREATED_ANNOTATION = "org.opencontainers.image.created";

function getManifestDescriptors(manifestObj) {
  if (Array.isArray(manifestObj?.manifests)) {
    return manifestObj.manifests;
  }
  if (Array.isArray(manifestObj?.referrers)) {
    return manifestObj.referrers;
  }
  return [];
}

function getRepositoryRef(image) {
  let repositoryRef = image;
  const digestIndex = repositoryRef.indexOf("@");
  if (digestIndex !== -1) {
    repositoryRef = repositoryRef.slice(0, digestIndex);
  }
  const lastSlashIndex = repositoryRef.lastIndexOf("/");
  const tagIndex = repositoryRef.lastIndexOf(":");
  if (tagIndex > lastSlashIndex) {
    repositoryRef = repositoryRef.slice(0, tagIndex);
  }
  return repositoryRef;
}

function getManifestImageRef(image, manifest) {
  if (manifest?.reference) {
    return manifest.reference;
  }
  if (manifest?.digest) {
    return `${getRepositoryRef(image)}@${manifest.digest}`;
  }
  return undefined;
}

function getManifestCreatedAt(manifest) {
  const createdAt = manifest?.annotations?.[ORAS_CREATED_ANNOTATION];
  if (!createdAt) {
    return undefined;
  }
  const createdAtTimestamp = Date.parse(createdAt);
  if (Number.isNaN(createdAtTimestamp)) {
    return undefined;
  }
  return createdAtTimestamp;
}

function selectManifestImageRef(image, manifestObj) {
  const manifestDescriptors = getManifestDescriptors(manifestObj);
  const candidates = manifestDescriptors
    .map((manifest, index) => {
      const imageRef = getManifestImageRef(image, manifest);
      if (!imageRef) {
        return undefined;
      }
      return {
        createdAt: getManifestCreatedAt(manifest),
        imageRef,
        index,
      };
    })
    .filter(Boolean);
  if (!candidates.length) {
    return undefined;
  }
  candidates.sort((a, b) => {
    if (a.createdAt !== undefined || b.createdAt !== undefined) {
      if (a.createdAt === undefined) {
        return 1;
      }
      if (b.createdAt === undefined) {
        return -1;
      }
      if (b.createdAt !== a.createdAt) {
        return b.createdAt - a.createdAt;
      }
    }
    return b.index - a.index;
  });
  return candidates[0]?.imageRef;
}

function _getBomFiles(tmpDir) {
  let bomFiles = getAllFiles(tmpDir, "**/*.{bom,cdx}.json");
  if (!bomFiles.length) {
    bomFiles = getAllFiles(tmpDir, "**/bom.json");
  }
  if (!bomFiles.length) {
    bomFiles = getAllFiles(tmpDir, "**/*.json");
  }
  return bomFiles;
}

function parseImageRef(image) {
  let registry = "docker.io";
  let repoAndTag = image;
  const firstSlash = image.indexOf("/");
  if (firstSlash !== -1) {
    const hostCandidate = image.slice(0, firstSlash);
    if (
      hostCandidate.includes(".") ||
      hostCandidate.includes(":") ||
      hostCandidate === "localhost"
    ) {
      registry = hostCandidate;
      repoAndTag = image.slice(firstSlash + 1);
    }
  }
  let repository = repoAndTag;
  let reference = "latest";
  const atIndex = repoAndTag.indexOf("@");
  if (atIndex !== -1) {
    repository = repoAndTag.slice(0, atIndex);
    reference = repoAndTag.slice(atIndex + 1);
  } else {
    const colonIndex = repoAndTag.lastIndexOf(":");
    if (colonIndex !== -1) {
      repository = repoAndTag.slice(0, colonIndex);
      reference = repoAndTag.slice(colonIndex + 1);
    }
  }
  if (registry === "docker.io" && !repository.includes("/")) {
    repository = `library/${repository}`;
  }
  return { registry, repository, reference };
}

function getDockerCreds(registry) {
  try {
    const configPath = join(homedir(), ".docker", "config.json");
    if (safeExistsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (config.auths) {
        const auth =
          config.auths[registry] ||
          config.auths[`https://${registry}`] ||
          config.auths[`https://${registry}/v1/`];
        if (auth?.auth) {
          return auth.auth;
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
  return process.env.DOCKER_AUTH;
}

async function getOciToken(registry, repository, scope) {
  const creds = getDockerCreds(registry);
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const authUrl = `${scheme}://${registry}/v2/`;
  try {
    const res = await cdxgenAgent.get(authUrl, { throwHttpErrors: false });
    if (res.statusCode === 401) {
      const wwwAuth = res.headers["www-authenticate"];
      if (wwwAuth?.toLowerCase().startsWith("bearer ")) {
        const params = {};
        wwwAuth
          .substring(7)
          .split(",")
          .forEach((part) => {
            const [k, v] = part.split("=");
            if (v) params[k.trim()] = v.trim().replace(/"/g, "");
          });
        if (params.realm) {
          const reqUrl = new URL(params.realm);
          if (params.service)
            reqUrl.searchParams.set("service", params.service);
          reqUrl.searchParams.set("scope", `repository:${repository}:${scope}`);
          const options = { responseType: "json" };
          if (creds) {
            options.headers = { Authorization: `Basic ${creds}` };
          }
          const tokenRes = await cdxgenAgent.get(reqUrl.toString(), options);
          if (
            tokenRes.body &&
            (tokenRes.body.token || tokenRes.body.access_token)
          ) {
            return tokenRes.body.token || tokenRes.body.access_token;
          }
        }
      }
    }
  } catch (_e) {
    /* ignore */
  }
  if (creds) return `Basic ${creds}`;
  return null;
}

async function fetchManifest(registry, repository, reference, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/manifests/${reference}`;
  const headers = {
    Accept:
      "application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.index.v1+json",
  };
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await cdxgenAgent.get(url, {
    headers,
    responseType: "json",
    throwHttpErrors: false,
  });
  if (res.statusCode === 200) {
    return {
      manifest: res.body,
      digest: res.headers["docker-content-digest"],
      mediaType: res.headers["content-type"],
    };
  }
  return null;
}

async function discoverReferrers(registry, repository, digest, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/referrers/${digest}?artifactType=application/vnd.cyclonedx+json`;
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  try {
    const res = await cdxgenAgent.get(url, {
      headers,
      responseType: "json",
      throwHttpErrors: false,
    });
    if (res.statusCode === 200) {
      return res.body;
    }
  } catch (_e) {
    /* ignore */
  }
  return undefined;
}

async function pullBlob(registry, repository, digest, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const url = `${scheme}://${registry}/v2/${repository}/blobs/${digest}`;
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await cdxgenAgent.get(url, { headers, responseType: "buffer" });
  return res.body;
}

/**
 * Retrieves a CycloneDX BOM attached to an OCI image purely in JavaScript
 * without relying on the `oras` CLI tool.
 *
 * @param {string} image OCI image reference (e.g. `"registry.example.com/org/app:tag"`)
 * @param {string} [platform] OCI platform string (e.g. `"linux/amd64"`); no-op for JS implementation
 * @returns {Promise<Object|undefined>} Parsed CycloneDX BOM JSON object, or `undefined` if not found
 */
export async function getBomWithOras(image, _platform = undefined) {
  const { registry, repository, reference } = parseImageRef(image);
  const token = await getOciToken(registry, repository, "pull");

  try {
    const targetManifest = await fetchManifest(
      registry,
      repository,
      reference,
      token,
    );
    if (!targetManifest?.digest) {
      return undefined;
    }
    const digest = targetManifest.digest;

    let referrersObj = await discoverReferrers(
      registry,
      repository,
      digest,
      token,
    );

    // If not found with artifactType filter, try fetching all referrers
    if (!referrersObj?.manifests || referrersObj.manifests.length === 0) {
      const scheme = registry.startsWith("localhost") ? "http" : "https";
      let url = `${scheme}://${registry}/v2/${repository}/referrers/${digest}`;
      const headers = token
        ? {
            Authorization: token.startsWith("Basic")
              ? token
              : `Bearer ${token}`,
          }
        : {};
      let res = await cdxgenAgent.get(url, {
        headers,
        responseType: "json",
        throwHttpErrors: false,
      });
      if (res.statusCode === 200) {
        referrersObj = res.body;
      } else if (res.statusCode === 404 || res.statusCode === 400) {
        // Fallback to OCI referrers tag schema
        const fallbackTag = digest.replace(":", "-");
        url = `${scheme}://${registry}/v2/${repository}/manifests/${fallbackTag}`;
        headers.Accept = "application/vnd.oci.image.index.v1+json";
        res = await cdxgenAgent.get(url, {
          headers,
          responseType: "json",
          throwHttpErrors: false,
        });
        if (res.statusCode === 200) {
          referrersObj = res.body;
        }
      }
    }

    let imageRef = selectManifestImageRef(image, referrersObj);

    if (!imageRef && referrersObj?.manifests) {
      for (const m of referrersObj.manifests) {
        if (
          m.artifactType === "application/vnd.cyclonedx+json" ||
          m.artifactType === "sbom/cyclonedx"
        ) {
          imageRef = `${repository}@${m.digest}`;
          break;
        }
      }
    }

    if (imageRef) {
      const refParsed = parseImageRef(imageRef);
      const manifestNode = await fetchManifest(
        refParsed.registry,
        refParsed.repository,
        refParsed.reference,
        token,
      );
      if (
        manifestNode?.manifest?.layers &&
        manifestNode.manifest.layers.length > 0
      ) {
        const layerDigest = manifestNode.manifest.layers[0].digest;
        const blob = await pullBlob(
          registry,
          refParsed.repository,
          layerDigest,
          token,
        );
        let bomJson = JSON.parse(blob.toString("utf8"));

        // Extract from in-toto envelope (BuildKit native attestations)
        if (
          bomJson &&
          (bomJson._type === "https://in-toto.io/Statement/v0.1" ||
            bomJson._type === "https://in-toto.io/Statement/v1") &&
          bomJson.predicateType === "https://cyclonedx.org/bom" &&
          bomJson.predicate
        ) {
          bomJson = bomJson.predicate;
        }

        if (isCycloneDxBom(bomJson)) {
          return bomJson;
        }
      }
    }
  } catch (e) {
    console.log(
      `Unable to pull the SBOM attachment for ${image} natively! ${e.message}`,
    );
  }
  return undefined;
}

function getDigest(buffer) {
  return `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
}

async function pushBlob(registry, repository, buffer, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const digest = getDigest(buffer);
  const headers = {};
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }

  // 1. Initiate upload
  const initUrl = `${scheme}://${registry}/v2/${repository}/blobs/uploads/`;
  const initRes = await cdxgenAgent.post(initUrl, {
    headers,
    throwHttpErrors: false,
  });
  if (initRes.statusCode === 201 || initRes.statusCode === 202) {
    let location = initRes.headers.location;
    if (!location.startsWith("http")) {
      location = `${scheme}://${registry}${location.startsWith("/") ? "" : "/"}${location}`;
    }
    const uploadUrl = new URL(location);
    uploadUrl.searchParams.set("digest", digest);

    // 2. Upload blob
    const putHeaders = {
      ...headers,
      "Content-Length": buffer.length.toString(),
      "Content-Type": "application/octet-stream",
    };
    const putRes = await cdxgenAgent.put(uploadUrl.toString(), {
      headers: putHeaders,
      body: buffer,
      throwHttpErrors: false,
    });
    if (putRes.statusCode === 201 || putRes.statusCode === 202) {
      return { digest, size: buffer.length };
    }
    throw new Error(
      `Failed to upload blob: ${putRes.statusCode} ${putRes.body}`,
    );
  }
  if (initRes.statusCode === 401) {
    throw new Error(
      `Unauthorized to initiate blob upload: ${initRes.statusCode}`,
    );
  }
  throw new Error(
    `Failed to initiate blob upload: ${initRes.statusCode} ${initRes.body}`,
  );
}

async function pushManifest(registry, repository, manifestObj, token) {
  const scheme = registry.startsWith("localhost") ? "http" : "https";
  const buffer = Buffer.from(JSON.stringify(manifestObj));
  const digest = getDigest(buffer);
  const url = `${scheme}://${registry}/v2/${repository}/manifests/${digest}`;
  const headers = {
    "Content-Type":
      manifestObj.mediaType || "application/vnd.oci.image.manifest.v1+json",
  };
  if (token) {
    headers.Authorization = token.startsWith("Basic")
      ? token
      : `Bearer ${token}`;
  }
  const res = await cdxgenAgent.put(url, {
    headers,
    body: buffer,
    throwHttpErrors: false,
  });
  if (res.statusCode === 201 || res.statusCode === 202) {
    return digest;
  }
  throw new Error(`Failed to push manifest: ${res.statusCode} ${res.body}`);
}

export async function attachBomNative(image, bomJson) {
  const { registry, repository, reference } = parseImageRef(image);
  const token = await getOciToken(registry, repository, "pull,push");

  // 1. Fetch target manifest
  const targetManifest = await fetchManifest(
    registry,
    repository,
    reference,
    token,
  );
  if (!targetManifest?.digest) {
    throw new Error(`Target image ${image} not found or no access.`);
  }

  // 2. Push SBOM blob
  const bomBuffer = Buffer.from(JSON.stringify(bomJson));
  const blobInfo = await pushBlob(registry, repository, bomBuffer, token);

  // Push the empty config blob ({}) required by the OCI 1.1 artifact manifest
  const emptyConfigBuffer = Buffer.from("{}");
  await pushBlob(registry, repository, emptyConfigBuffer, token);

  // 3. Push OCI 1.1 Manifest
  const manifestObj = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.cyclonedx+json",
    config: {
      mediaType: "application/vnd.oci.empty.v1+json",
      digest:
        "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
      size: 2,
    },
    layers: [
      {
        mediaType: "application/vnd.cyclonedx+json",
        digest: blobInfo.digest,
        size: blobInfo.size,
      },
    ],
    subject: {
      mediaType:
        targetManifest.mediaType ||
        "application/vnd.oci.image.manifest.v1+json",
      digest: targetManifest.digest,
      size: targetManifest.manifest
        ? Buffer.from(JSON.stringify(targetManifest.manifest)).length
        : 0,
    },
    annotations: {
      "org.opencontainers.image.created": new Date().toISOString(),
    },
  };

  let manifestDigest = await pushManifest(
    registry,
    repository,
    manifestObj,
    token,
  );

  // Probe if referrers API is supported by the registry
  const probeUrl = `${registry.startsWith("localhost") ? "http" : "https"}://${registry}/v2/${repository}/referrers/${targetManifest.digest}`;
  const probeHeaders = token
    ? { Authorization: token.startsWith("Basic") ? token : `Bearer ${token}` }
    : {};
  const probeRes = await cdxgenAgent.get(probeUrl, {
    headers: probeHeaders,
    throwHttpErrors: false,
  });

  if (probeRes.statusCode === 404 || probeRes.statusCode === 400) {
    // Registry does not support referrers API natively. Create the fallback tag.
    const fallbackTag = targetManifest.digest.replace(":", "-");

    // Check if the fallback tag already exists (an Image Index)
    const fallbackUrl = `${registry.startsWith("localhost") ? "http" : "https"}://${registry}/v2/${repository}/manifests/${fallbackTag}`;
    const getRes = await cdxgenAgent.get(fallbackUrl, {
      headers: {
        ...probeHeaders,
        Accept: "application/vnd.oci.image.index.v1+json",
      },
      responseType: "json",
      throwHttpErrors: false,
    });

    let indexObj;
    if (getRes.statusCode === 200 && getRes.body && getRes.body.manifests) {
      indexObj = getRes.body;
      indexObj.manifests.push({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: manifestDigest,
        size: Buffer.from(JSON.stringify(manifestObj)).length,
        artifactType: "application/vnd.cyclonedx+json",
      });
    } else {
      indexObj = {
        schemaVersion: 2,
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            digest: manifestDigest,
            size: Buffer.from(JSON.stringify(manifestObj)).length,
            artifactType: "application/vnd.cyclonedx+json",
          },
        ],
      };
    }

    const indexBuffer = Buffer.from(JSON.stringify(indexObj));
    const putHeaders = {
      ...probeHeaders,
      "Content-Type": "application/vnd.oci.image.index.v1+json",
    };
    await cdxgenAgent.put(fallbackUrl, {
      headers: putHeaders,
      body: indexBuffer,
      throwHttpErrors: false,
    });
    manifestDigest = getDigest(indexBuffer);
  }

  console.log(`Attached SBOM natively to ${image} via ${manifestDigest}`);
  return manifestDigest;
}
