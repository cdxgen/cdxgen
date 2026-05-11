import { createHash, generateKeySync, pbkdf2Sync, webcrypto } from "node:crypto";

const digestAlgorithm = "sha512";
const symmetricKeyParams = {
  name: "AES-GCM",
  length: 256,
};

createHash(digestAlgorithm).update("fixture").digest("hex");
pbkdf2Sync("password", "salt", 1000, 32, "sha256");
generateKeySync("hmac", { length: 256 });
await webcrypto.subtle.generateKey(symmetricKeyParams, true, [
  "encrypt",
  "decrypt",
]);
