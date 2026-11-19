import process from "node:process";

import esmock from "esmock";
import { assert, it } from "poku";
import sinon from "sinon";

// GEM_HOST_API_KEY is the credential of one gem server, while the three
// lookup endpoints are overridden one by one and each defaults to
// rubygems.org. The key must reach only the server the operator named. The
// assertions are on the Authorization header a stubbed agent records for each
// request.

const GEMFILE_LOCK = [
  "GEM",
  "  remote: https://gems.acme.example/",
  "  specs:",
  "    acme-native (1.0.0)",
  "    acme-native (1.0.0-x86_64-linux)",
  "    rake (13.0.6)",
  "",
  "PLATFORMS",
  "  ruby",
  "",
  "DEPENDENCIES",
  "  acme-native",
  "  rake",
  "",
].join("\n");

const KEY = "private-gem-server-key";

async function recordAuthorization(environment) {
  const previous = {};
  for (const [name, value] of Object.entries({
    FETCH_LICENSE: "true",
    CDXGEN_RS_DISABLE: "fetch",
    CDXGEN_CASSETTE_REPLAY: undefined,
    GEM_HOST_API_KEY: KEY,
    RUBYGEMS_V2_URL: undefined,
    RUBYGEMS_V1_URL: undefined,
    RUBYGEMS_V1_VERSIONS_URL: undefined,
    ...environment,
  })) {
    previous[name] = process.env[name];
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  const authorizationByUrl = {};
  const agentGet = sinon.stub().callsFake(async (url, options) => {
    authorizationByUrl[url] = options?.headers?.Authorization;
    return { statusCode: 404, body: undefined };
  });
  try {
    const { resetBatchFetchAvailability } = await import(
      "../inventory/fetchBatch.js"
    );
    resetBatchFetchAvailability();
    const { parseGemfileLockData } = await esmock(
      "./rubyutils.js",
      {},
      {
        "../core/httpClient.js": {
          createHttpClient: sinon.stub().returns({ get: agentGet }),
        },
      },
    );
    await parseGemfileLockData(GEMFILE_LOCK, "/project/Gemfile.lock");
    return authorizationByUrl;
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

await it("the key is not sent to an endpoint left at its rubygems.org default", async () => {
  // The versions listing, used for a gem with several builds, is not
  // overridden here and so is asked of rubygems.org.
  const authorizationByUrl = await recordAuthorization({
    RUBYGEMS_V2_URL: "http://127.0.0.1:1/private/v2/",
    RUBYGEMS_V1_URL: "http://127.0.0.1:1/private/v1/",
  });
  assert.deepStrictEqual(authorizationByUrl, {
    "http://127.0.0.1:1/private/v2/acme-native/versions/1.0.0.json": KEY,
    "http://127.0.0.1:1/private/v2/acme-native/versions/1.0.0.json?platform=x86_64-linux":
      KEY,
    "http://127.0.0.1:1/private/v2/rake/versions/13.0.6.json": KEY,
    "https://rubygems.org/api/v1/versions/acme-native.json": undefined,
  });
});

await it("the key stays with the named server when the batch is skipped", async () => {
  // Without the prefetch every lookup takes its direct path, which builds its
  // own request options.
  const authorizationByUrl = await recordAuthorization({
    CDXGEN_CASSETTE_REPLAY: "true",
    RUBYGEMS_V1_VERSIONS_URL: "http://127.0.0.1:2/private/versions/",
  });
  assert.deepStrictEqual(authorizationByUrl, {
    "http://127.0.0.1:2/private/versions/acme-native.json": KEY,
    "https://rubygems.org/api/v2/rubygems/acme-native/versions/1.0.0.json":
      undefined,
    "https://rubygems.org/api/v2/rubygems/acme-native/versions/1.0.0.json?platform=x86_64-linux":
      undefined,
    "https://rubygems.org/api/v2/rubygems/rake/versions/13.0.6.json": undefined,
  });
});

await it("the key is sent to rubygems.org when no endpoint is overridden", async () => {
  const authorizationByUrl = await recordAuthorization({});
  assert.deepStrictEqual(authorizationByUrl, {
    "https://rubygems.org/api/v1/versions/acme-native.json": KEY,
    "https://rubygems.org/api/v2/rubygems/acme-native/versions/1.0.0.json": KEY,
    "https://rubygems.org/api/v2/rubygems/acme-native/versions/1.0.0.json?platform=x86_64-linux":
      KEY,
    "https://rubygems.org/api/v2/rubygems/rake/versions/13.0.6.json": KEY,
  });
});
