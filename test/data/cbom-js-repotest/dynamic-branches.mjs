import { createHash, webcrypto } from "node:crypto";
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
