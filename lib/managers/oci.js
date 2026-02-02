import { Buffer } from "node:buffer";
import fs from "node:fs";
import { arch } from "node:os";

import {
  getAllFiles,
  getTmpDir,
  isWin,
  safeSpawnSync,
} from "../helpers/utils.js";

export function getBomWithOras(image, platform = undefined) {
  const platformArch = arch() === "arm64" ? "arm64" : "amd64";
  let parameters = [
    "discover",
    "--format",
    "json",
    "--artifact-type",
    "sbom/cyclonedx",
  ];
  if (platform) {
    parameters = parameters.concat(["--platform", platform]);
  } else {
    parameters = parameters.concat(["--platform", platformArch]);
  }
  let result = safeSpawnSync("oras", parameters.concat([image]), {
    shell: isWin,
  });
  if (result.status !== 0 || result.error) {
    console.log(
      "Install oras by following the instructions at: https://oras.land/docs/installation",
    );
    if (result.stderr) {
      console.log(result.stderr);
    }
    return undefined;
  }
  if (result.stdout) {
    const out = Buffer.from(result.stdout).toString();
    try {
      const manifestObj = JSON.parse(out);
      let manifest;
      if (manifestObj?.manifests) {
        if (
          manifestObj?.manifests?.length &&
          Array.isArray(manifestObj.manifests) &&
          manifestObj.manifests[0]?.reference
        ) {
          manifest = manifestObj.manifests[0];
        }
      } else if (manifestObj?.referrers) {
        if (
          manifestObj?.referrers?.length &&
          Array.isArray(manifestObj.referrers) &&
          manifestObj.referrers[0]?.reference
        ) {
          manifest = manifestObj.referrers[0];
        }
      }
      if (manifest != null) {
        const imageRef = manifest.reference;
        const tmpDir = getTmpDir();
        result = safeSpawnSync("oras", ["pull", imageRef, "-o", tmpDir], {
          shell: isWin,
        });
        if (result.status !== 0 || result.error) {
          console.log(
            `Unable to pull the SBOM attachment for ${imageRef} with oras!`,
          );
          return undefined;
        }
        const bomFiles = getAllFiles(tmpDir, "**/*.{bom,cdx}.json");
        if (bomFiles.length) {
          return JSON.parse(fs.readFileSync(bomFiles.pop(), "utf8"));
        }
      } else {
        console.log(`${image} does not contain any SBOM attachment!`);
      }
    } catch (e) {
      console.log(e);
    }
  }
  return undefined;
}
