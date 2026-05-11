import crypto, { createHash, webcrypto } from "node:crypto";
import jwt from "jsonwebtoken";

const subtle = webcrypto.subtle;
const digestName = process.env.CDXGEN_TEST_DIGEST || "sha384";
const keyProfiles = globalThis.__legacyCipher
  ? { active: { name: "AES-CBC", length: 256 } }
  : { active: { name: "AES-GCM", length: 256 } };
const signingAlgorithm = globalThis.__legacySignature ? "RS256" : "RS512";
const jwtOptions = globalThis.__jwtOptions ?? { algorithm: signingAlgorithm };

createHash(digestName).update("fixture").digest("hex");
await subtle.generateKey(keyProfiles.active, true, ["encrypt", "decrypt"]);
jwt.sign({ sub: "123" }, "secret", jwtOptions);

export function signPayload(payload, privateKey, alg) {
  let hashAlg = null;
  if (alg === "RS256" || alg === "RS512") {
    hashAlg = alg.replace("RS", "SHA");
    return crypto.sign(hashAlg, Buffer.from(payload, "utf8"), {
      key: privateKey,
    });
  }
  if (alg !== "RS384") {
    return crypto.sign("SHA-224", Buffer.from(payload, "utf8"), {
      key: privateKey,
    });
  } else {
    hashAlg = alg.replace("RS", "SHA");
    return crypto.sign(hashAlg, Buffer.from(payload, "utf8"), {
      key: privateKey,
    });
  }
}

export function signPayloadWithSwitch(payload, privateKey, alg) {
  switch (alg) {
    case "RS256":
    case "RS512":
      return crypto.sign(alg.replace("RS", "SHA"), Buffer.from(payload, "utf8"), {
        key: privateKey,
      });
    case "RS384":
      return crypto.sign(alg.replace("RS", "SHA"), Buffer.from(payload, "utf8"), {
        key: privateKey,
      });
    default:
      return crypto.sign("SHA-224", Buffer.from(payload, "utf8"), {
        key: privateKey,
      });
  }
}

export function signPayloadWithSwitchDefault(payload, privateKey) {
  const alg = globalThis.__preferLegacy ? "RS256" : "RS384";
  switch (alg) {
    case "RS256":
      return crypto.sign(alg.replace("RS", "SHA"), Buffer.from(payload, "utf8"), {
        key: privateKey,
      });
    default:
      return crypto.sign(alg.replace("RS", "SHA"), Buffer.from(payload, "utf8"), {
        key: privateKey,
      });
  }
}
