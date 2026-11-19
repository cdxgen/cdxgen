import { assert, describe, it } from "poku";

import {
  CREDENTIAL_KEY_NAME_SOURCE,
  isCredentialKeyName,
} from "./credentialNames.js";

describe("isCredentialKeyName()", () => {
  it("accepts key, and a credential qualifier before key", () => {
    for (const name of [
      "key",
      "keys",
      "Key",
      "api_key",
      "apiKey",
      "APIKey",
      "apikey",
      "accessKey",
      "private-key",
      "signing.key",
      "AWS_SECRET_ACCESS_KEY",
      "ssh_keys",
      "deployKey",
      "licensekey",
      "WEBHOOK_KEY",
    ]) {
      assert.strictEqual(isCredentialKeyName(name), true, name);
    }
  });

  it("rejects names that only contain the word key", () => {
    for (const name of [
      "sort_key",
      "primary_key",
      "cache_key",
      "projectKey",
      "sonar.projectKey",
      "monkey",
      "turkey",
      "keyboard",
      "keyId",
      "",
    ]) {
      assert.strictEqual(isCredentialKeyName(name), false, name);
    }
  });
});

describe("CREDENTIAL_KEY_NAME_SOURCE", () => {
  const pattern = new RegExp(CREDENTIAL_KEY_NAME_SOURCE, "iu");

  it("matches the qualified and the standalone forms", () => {
    for (const text of [
      "key=1",
      "api_key=1",
      "x-api-key: 1",
      "SECRET_ACCESS_KEY",
    ]) {
      assert.ok(pattern.test(text), text);
    }
  });

  it("does not match a key after another word or inside one", () => {
    for (const text of ["sort_key=1", "cache.key=1", "monkey=1"]) {
      assert.ok(!pattern.test(text), text);
    }
  });
});
