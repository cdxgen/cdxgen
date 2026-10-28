import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import esmock from "esmock";
import { afterEach, assert, beforeEach, describe, it } from "poku";
import sinon from "sinon";

import { isWin } from "../core/paths.js";
import {
  getGitRemoteHost,
  isAllowedHost,
  isAllowedPath,
  isAllowedRealPath,
  isAllowedWinPath,
  validateAndRejectGitSource,
} from "../inventory/source.js";
import {
  getQueryParams,
  isAllowedHttpHost,
  parseQueryString,
  parseValue,
  validateRequestOptions,
} from "./server.js";

function nullProtoObj(obj) {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(nullProtoObj);
  }
  if (Object.prototype.toString.call(obj) === "[object Object]") {
    const result = Object.create(null);
    for (const [key, value] of Object.entries(obj)) {
      result[key] = nullProtoObj(value);
    }
    return result;
  }
  return obj;
}

function checkEqual(actual, expected, message) {
  assert.deepStrictEqual(nullProtoObj(actual), nullProtoObj(expected), message);
}

it("parseValue tests", () => {
  checkEqual(parseValue("foo"), "foo");
  checkEqual(parseValue("foo\n"), "foo");
  checkEqual(parseValue("foo\r\n"), "foo");
  checkEqual(parseValue(1), 1);
  checkEqual(parseValue("true"), true);
  checkEqual(parseValue("false"), false);
  checkEqual(parseValue(["foo", "bar", 42]), ["foo", "bar", 42]);
  assert.throws(() => parseValue({ foo: "bar" }), TypeError);
  assert.throws(() => parseValue([42, "foo", { foo: "bar" }]), TypeError);
  assert.throws(() => parseValue([42, "foo", new Error()]), TypeError);
  assert.throws(() => parseValue(["foo", "bar", new String(42)]), TypeError);
  checkEqual(parseValue(true), true);
  checkEqual(parseValue(false), false);
  checkEqual(parseValue(null), null);
  checkEqual(parseValue(undefined), undefined);
  checkEqual(parseValue([null, undefined, null]), [null, undefined, null]);
  checkEqual(parseValue(""), "");
  checkEqual(parseValue("   \n"), "   ");
  checkEqual(parseValue("42"), "42");
  checkEqual(parseValue("0"), "0");
  checkEqual(parseValue("-1"), "-1");
  checkEqual(parseValue("True"), "True");
  checkEqual(parseValue("False"), "False");
  checkEqual(parseValue(" TRUE "), " TRUE ");
  checkEqual(parseValue(["true", "false", 0, "0", null, undefined]), [
    true,
    false,
    0,
    "0",
    null,
    undefined,
  ]);
  assert.throws(() => parseValue([["nested"]]), TypeError);
  assert.throws(() => parseValue(Symbol("test")), TypeError);
  assert.throws(() => parseValue(BigInt(42)), TypeError);
  // biome-ignore-start lint/suspicious/noEmptyBlockStatements: test
  assert.throws(() => parseValue(() => {}), TypeError);
  // biome-ignore-end lint/suspicious/noEmptyBlockStatements: test
  checkEqual(parseValue(Number.NaN), Number.NaN);
  checkEqual(parseValue(Number.POSITIVE_INFINITY), Number.POSITIVE_INFINITY);
  const obj = { toString: () => "foo" };
  assert.throws(() => parseValue(obj), TypeError);
  checkEqual(parseValue("hello\r\n"), "hello");
});

describe("parseQueryString tests", () => {
  it("prioritizes q over body and calls parseValue for each allowed param", () => {
    const q = { foo: "1", excludeType: ["2"] };
    const body = {
      foo: "x",
      excludeType: ["3"],
      technique: ["manifest-analysis"],
    };
    const options = {};
    const result = parseQueryString(q, body, options);
    checkEqual(result.foo, undefined);
    checkEqual(result.excludeType, ["2"]);
    checkEqual(result.technique, ["manifest-analysis"]);
  });

  it("splits type into projectType and removes type", () => {
    const options = { type: "a,b,c" };
    const result = parseQueryString({}, {}, options);
    checkEqual(result.projectType, ["a", "b", "c"]);
    checkEqual(result.type, undefined);
  });

  it("sets installDeps to false for pre-build lifecycle", () => {
    const options = { lifecycle: "pre-build" };
    const result = parseQueryString({}, {}, options);
    checkEqual(result.installDeps, false);
  });

  it("parses parentProjectName and parentProjectVersion", () => {
    const q = {
      parentProjectName: "parent-app",
      parentProjectVersion: "1.2.3",
    };
    const result = parseQueryString(q, {}, {});
    checkEqual(result.parentProjectName, "parent-app");
    checkEqual(result.parentProjectVersion, "1.2.3");
  });

  it("parses autoCreate and isLatest boolean options", () => {
    const q = {
      autoCreate: "false",
      isLatest: "true",
    };
    const result = parseQueryString(q, {}, {});
    checkEqual(result.autoCreate, false);
    checkEqual(result.isLatest, true);
  });

  it("parses format for SPDX export requests", () => {
    const q = {
      format: "spdx",
    };
    const result = parseQueryString(q, {}, {});
    checkEqual(result.format, "spdx");
  });

  it("does not let a request turn on code execution the operator turned off", () => {
    const operator = { installDeps: false, deep: false };
    for (const q of [
      { installDeps: "true", deep: "true" },
      { profile: "appsec" },
      { profile: "research" },
    ]) {
      const result = parseQueryString(q, {}, { ...operator });
      checkEqual(result.installDeps, false, JSON.stringify(q));
      checkEqual(result.deep, false, JSON.stringify(q));
    }
    const fromBody = parseQueryString(
      {},
      { installDeps: true, deep: true },
      { ...operator },
    );
    checkEqual(fromBody.installDeps, false);
    checkEqual(fromBody.deep, false);
  });

  it("does not let falsy non-boolean values slip past the restriction", () => {
    // Gates such as getMavenCommand test `installDeps !== false`, so "" or 0
    // must not survive as anything other than false.
    for (const value of ["", 0, "0", "no", "yes", 1]) {
      const fromQuery = parseQueryString(
        { installDeps: value, deep: value },
        {},
        { installDeps: false },
      );
      checkEqual(fromQuery.installDeps, false, JSON.stringify(value));
      checkEqual(fromQuery.deep, false, JSON.stringify(value));
      const fromBody = parseQueryString(
        {},
        { installDeps: value, deep: value },
        { installDeps: false },
      );
      checkEqual(fromBody.installDeps, false, JSON.stringify(value));
      checkEqual(fromBody.deep, false, JSON.stringify(value));
    }
  });

  it("never lets a request end the server process", () => {
    checkEqual(
      parseQueryString({}, {}, { failOnError: true }).failOnError,
      false,
    );
    checkEqual(
      parseQueryString({}, { failOnError: true }, {}).failOnError,
      false,
    );
  });

  it("accepts the project type as an array from the operator or the request", () => {
    checkEqual(parseQueryString({}, {}, { type: ["js"] }).projectType, ["js"]);
    checkEqual(
      parseQueryString({ type: ["java", "js,python"] }, {}, {}).projectType,
      ["java", "js", "python"],
    );
    checkEqual(parseQueryString({}, {}, {}).projectType, undefined);
  });

  it("keeps code execution options the operator turned on", () => {
    const result = parseQueryString(
      { deep: "true" },
      {},
      { installDeps: false, deep: true },
    );
    checkEqual(result.deep, true);
    const turnedOff = parseQueryString(
      { deep: "false", installDeps: "false" },
      {},
      { installDeps: true, deep: true },
    );
    checkEqual(turnedOff.deep, false);
    checkEqual(turnedOff.installDeps, false);
  });
});

describe("isAllowedRealPath()", () => {
  it("follows links on both the scan path and the allowed path", () => {
    const original = process.env.CDXGEN_SERVER_ALLOWED_PATHS;
    const root = mkdtempSync(path.join(os.tmpdir(), "cdxgen-realpath-"));
    const allowed = path.join(root, "allowed");
    const outside = path.join(root, "outside");
    mkdirSync(path.join(allowed, "project"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    // Junctions need no extra privileges on Windows and act as directory
    // symlinks elsewhere.
    const linkOut = path.join(allowed, "link-out");
    const allowedAlias = path.join(root, "allowed-alias");
    symlinkSync(outside, linkOut, "junction");
    symlinkSync(allowed, allowedAlias, "junction");
    try {
      process.env.CDXGEN_SERVER_ALLOWED_PATHS = allowed;
      checkEqual(isAllowedRealPath(path.join(allowed, "project")), true);
      // The link sits inside the allowed directory but leads outside it.
      checkEqual(isAllowedPath(linkOut), true);
      checkEqual(isAllowedRealPath(linkOut), false);
      checkEqual(isAllowedRealPath(path.join(allowed, "not-yet")), true);
      // An allowlist entry reached through a link, like /tmp on macOS, still
      // matches the real location of paths under it.
      process.env.CDXGEN_SERVER_ALLOWED_PATHS = allowedAlias;
      checkEqual(isAllowedRealPath(path.join(allowed, "project")), true);
      checkEqual(isAllowedRealPath(path.join(allowedAlias, "project")), true);
      checkEqual(isAllowedRealPath(outside), false);
    } finally {
      if (original === undefined) {
        delete process.env.CDXGEN_SERVER_ALLOWED_PATHS;
      } else {
        process.env.CDXGEN_SERVER_ALLOWED_PATHS = original;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("validateRequestOptions()", () => {
  it("refuses project types that scan the server host", () => {
    for (const type of [
      "os",
      "linux",
      "hbom",
      "cargo-cache",
      "maven-cache",
      "maven-repo",
      "gradle-index",
      "helm-index",
      "vscode-extension",
      "chrome-extension",
      "agentic",
    ]) {
      const reqOptions = parseQueryString({ type: `js,${type}` }, {}, {});
      const result = validateRequestOptions(reqOptions, {});
      checkEqual(result?.status, 403, type);
      checkEqual(result?.error, "Project Type Not Allowed", type);
    }
    checkEqual(
      validateRequestOptions(parseQueryString({ type: "js" }, {}, {}), {}),
      null,
    );
  });

  it("allows a host-wide type the operator started the server with", () => {
    const operator = { type: ["os"] };
    const reqOptions = parseQueryString({}, {}, { ...operator });
    checkEqual(validateRequestOptions(reqOptions, operator), null);
  });

  it("refuses brace and oversized exclude patterns", () => {
    for (const exclude of [["{1..100000}"], "**/{a,b}/**", ["x".repeat(513)]]) {
      const reqOptions = parseQueryString({}, { exclude }, {});
      checkEqual(
        validateRequestOptions(reqOptions, {})?.error,
        "Invalid Exclude Pattern",
      );
    }
    const ok = parseQueryString({}, { exclude: ["**/test/**"] }, {});
    checkEqual(validateRequestOptions(ok, {}), null);
  });

  it("keeps the operator's API key on the operator's Dependency-Track server", () => {
    const operator = {
      serverUrl: "https://dtrack.example.com",
      apiKey: "operator-key",
    };
    const leak = parseQueryString(
      { serverUrl: "https://attacker.example" },
      {},
      { ...operator },
    );
    checkEqual(
      validateRequestOptions(leak, operator)?.error,
      "API Key Required",
    );
    const ownKey = parseQueryString(
      { serverUrl: "https://other.example", apiKey: "client-key" },
      {},
      { ...operator },
    );
    checkEqual(validateRequestOptions(ownKey, operator), null);
    const samePlace = parseQueryString(
      { serverUrl: "https://dtrack.example.com/" },
      {},
      { ...operator },
    );
    checkEqual(validateRequestOptions(samePlace, operator), null);
    const invalid = parseQueryString(
      { serverUrl: "not a url", apiKey: "k" },
      {},
      {},
    );
    checkEqual(
      validateRequestOptions(invalid, {})?.error,
      "Invalid Server URL",
    );
  });
});

describe("isAllowedHost()", () => {
  let originalHosts;

  beforeEach(() => {
    originalHosts = process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
  });

  afterEach(() => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = originalHosts;
  });

  it("returns true if CDXGEN_SERVER_ALLOWED_HOSTS is not set", () => {
    delete process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
    checkEqual(isAllowedHost("anything"), true);
  });

  it("returns true for a hostname that is in the list", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "foo.com,bar.com";
    checkEqual(isAllowedHost("foo.com"), true);
    checkEqual(isAllowedHost("bar.com"), true);
  });

  it("returns false for a hostname not in the list", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "foo.com,bar.com";
    checkEqual(isAllowedHost("baz.com"), false);
  });

  it("treats an empty-string env var as unset (returns true)", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "";
    checkEqual(isAllowedHost("whatever"), true);
  });
});

describe("isAllowedHttpHost()", () => {
  let originalAllowedHosts;

  beforeEach(() => {
    originalAllowedHosts = process.env.CDXGEN_ALLOWED_HOSTS;
  });

  afterEach(() => {
    if (originalAllowedHosts === undefined) {
      delete process.env.CDXGEN_ALLOWED_HOSTS;
    } else {
      process.env.CDXGEN_ALLOWED_HOSTS = originalAllowedHosts;
    }
  });

  it("allows exact host matches", () => {
    process.env.CDXGEN_ALLOWED_HOSTS = "dependencytrack.example.com";
    assert.strictEqual(isAllowedHttpHost("dependencytrack.example.com"), true);
    assert.strictEqual(isAllowedHttpHost("other.example.com"), false);
  });

  it("allows only real subdomains for wildcard entries", () => {
    process.env.CDXGEN_ALLOWED_HOSTS = "*.example.com";
    assert.strictEqual(isAllowedHttpHost("api.example.com"), true);
    assert.strictEqual(isAllowedHttpHost("deep.api.example.com"), true);
    assert.strictEqual(isAllowedHttpHost("example.com"), false);
    assert.strictEqual(isAllowedHttpHost("evil-example.com"), false);
  });
});

describe("isAllowedPath()", () => {
  let originalPaths;

  beforeEach(() => {
    originalPaths = process.env.CDXGEN_SERVER_ALLOWED_PATHS;
  });

  afterEach(() => {
    if (originalPaths === undefined) {
      delete process.env.CDXGEN_SERVER_ALLOWED_PATHS;
    } else {
      process.env.CDXGEN_SERVER_ALLOWED_PATHS = originalPaths;
    }
  });

  it("returns false for non-string inputs", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api";
    assert.strictEqual(isAllowedPath(null), false);
    assert.strictEqual(isAllowedPath(123), false);
    assert.strictEqual(isAllowedPath({}), false);
    assert.strictEqual(isAllowedPath(undefined), false);
  });

  it("returns true if CDXGEN_SERVER_ALLOWED_PATHS is not set", () => {
    delete process.env.CDXGEN_SERVER_ALLOWED_PATHS;
    assert.strictEqual(isAllowedPath("/any/path"), true);
  });

  it("treats an empty-string env var as unset (returns true)", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "";
    assert.strictEqual(isAllowedPath("/anything"), true);
  });

  it("returns true for exact directory matches", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api,/public";
    assert.strictEqual(isAllowedPath("/api"), true);
    assert.strictEqual(isAllowedPath("/public"), true);
  });

  it("returns true for files safely nested inside allowed directories", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api,/public";
    assert.strictEqual(isAllowedPath("/api/resource"), true);
    assert.strictEqual(isAllowedPath("/public/index.html"), true);
    assert.strictEqual(isAllowedPath("/public/assets/css/main.css"), true);
  });

  it("returns false for completely unrelated paths", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api,/public";
    assert.strictEqual(isAllowedPath("/private/data"), false);
    assert.strictEqual(isAllowedPath("/etc/passwd"), false);
  });

  it("prevents directory prefix bypass (e.g., /var/www vs /var/www-secret)", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api,/var/www";
    assert.strictEqual(isAllowedPath("/api-secret/data"), false);
    assert.strictEqual(isAllowedPath("/api-secret"), false);
    assert.strictEqual(isAllowedPath("/var/www-backup"), false);
  });

  it("prevents path traversal attacks using ../", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api";
    assert.strictEqual(isAllowedPath("/api/../private"), false);
    assert.strictEqual(isAllowedPath("/api/../../etc/passwd"), false);
  });

  it("allows paths that contain ../ but safely resolve inside the allowed directory", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api";
    assert.strictEqual(isAllowedPath("/api/resource/../data"), true);
  });

  it("gracefully handles comma-separated lists with empty segments", () => {
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = "/api,,/public,";
    assert.strictEqual(isAllowedPath("/api/resource"), true);
    assert.strictEqual(isAllowedPath("/public/index.html"), true);
    assert.strictEqual(isAllowedPath("/private/data"), false);
  });
});

describe("isAllowedWinPath windows tests()", () => {
  it("returns false for windows device name paths", () => {
    if (isWin) {
      checkEqual(isAllowedWinPath("CON:../foo"), false);
      checkEqual(isAllowedWinPath("X:\\foo\\..\\bar"), true);
      checkEqual(isAllowedWinPath("C:\\Users"), true);
      checkEqual(isAllowedWinPath("C:\\🚀"), true);
      checkEqual(isAllowedWinPath("C:"), true);
      checkEqual(isAllowedWinPath("c:"), true);
      checkEqual(isAllowedWinPath("CON:"), false);
      checkEqual(isAllowedWinPath("COM¹:"), false);
      checkEqual(isAllowedWinPath("COM¹:../foo"), false);
      for (const d of [
        "PRN:.\\..\\bar",
        "LpT5:/another/path",
        "PRN:.././../etc/passwd",
        "AUX:/foo\\bar/baz",
        "COM¹:/printer/foo",
        "LPT³:/C:\\Users\\cdxgen//..\\",
        "COM²:LPT³:.\\../../..\\",
        "С:\\",
        "Ϲ:\\",
        "Ⅽ:\\",
        "C\u0301:\\",
        "C\\u0308:\\",
        "C\u00A0:\\",
        "C\u2000:\\",
        "C\u2003:\\",
        "C\\u202E:\\",
        "C\\u202D:\\",
        "😀:\\",
        "$:\\",
        "CD:\\",
        "ABC:\\",
        "con:\\",
        "Con:\\",
        "cOn:\\",
        "COM1.txt:\\",
        "C\\u200B:\\",
        "C\\u200D:\\",
        "C\\\\u29F5\\",
        "🚀:\\",
        "⚡:\\",
      ]) {
        checkEqual(isAllowedWinPath(d), false);
      }
    }
  });
});

describe("getQueryParams", () => {
  // Mock request objects for different scenarios
  const createMockRequest = (url, host = "localhost", protocol = "http") => ({
    url,
    headers: { host },
    protocol,
  });

  it("should parse simple query parameters", () => {
    const req = createMockRequest(
      "/sbom?url=https://example.com&multiProject=true&type=js",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      url: "https://example.com",
      multiProject: "true",
      type: "js",
    });
  });

  it("should handle query parameters with special characters", () => {
    const req = createMockRequest(
      "/search?q=hello%20world&filter=category%3Dtech",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      q: "hello world",
      filter: "category=tech",
    });
  });

  it("should handle multiple values for the same parameter", () => {
    const req = createMockRequest("/api?tags=javascript&tags=react&tags=node");
    const result = getQueryParams(req);

    // URLSearchParams.entries() returns the first value when there are duplicates
    checkEqual(result, {
      tags: ["javascript", "react", "node"],
    });
  });

  it("should handle empty query string", () => {
    const req = createMockRequest("/sbom");
    const result = getQueryParams(req);

    checkEqual(result, {});
  });

  it("should handle query string with only question mark", () => {
    const req = createMockRequest("/sbom?");
    const result = getQueryParams(req);

    checkEqual(result, {});
  });

  it("should handle parameters without values", () => {
    const req = createMockRequest("/api?flag1&flag2&param=value");
    const result = getQueryParams(req);

    checkEqual(result, {
      flag1: "",
      flag2: "",
      param: "value",
    });
  });

  it("should handle custom host", () => {
    const req = createMockRequest(
      "/endpoint?param1=value1",
      "api.example.com:3000",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      param1: "value1",
    });
  });

  it("should handle HTTPS protocol", () => {
    const req = createMockRequest(
      "/secure?token=abc123",
      "secure.example.com",
      "https",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      token: "abc123",
    });
  });

  it("should handle complex URL with path segments", () => {
    const req = createMockRequest(
      "/api/v1/users/search?name=john&age=25&active=true",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      name: "john",
      age: "25",
      active: "true",
    });
  });

  it("should handle encoded parameters", () => {
    const req = createMockRequest(
      "/search?q=hello%20world%21&category=web%20development",
    );
    const result = getQueryParams(req);

    checkEqual(result, {
      q: "hello world!",
      category: "web development",
    });
  });

  it("should return empty object when url is undefined", () => {
    const req = createMockRequest(undefined);
    const result = getQueryParams(req);

    checkEqual(result, {});
  });

  it("should handle numeric values as strings", () => {
    const req = createMockRequest("/calculate?x=10&y=20&operation=add");
    const result = getQueryParams(req);

    checkEqual(result, {
      x: "10",
      y: "20",
      operation: "add",
    });
  });

  it("should handle boolean-like values as strings", () => {
    const req = createMockRequest("/config?debug=true&verbose=false&enabled=1");
    const result = getQueryParams(req);

    checkEqual(result, {
      debug: "true",
      verbose: "false",
      enabled: "1",
    });
  });

  // Error handling tests
  it("should handle malformed URL gracefully", () => {
    const req = createMockRequest("not-a-valid-url");
    const result = getQueryParams(req);

    checkEqual(result, {});
  });

  it("should handle empty host gracefully", () => {
    const req = {
      url: "/test?param=value",
      headers: { host: "" },
      protocol: "http",
    };
    const result = getQueryParams(req);

    checkEqual(result, {
      param: "value",
    });
  });

  it("should handle missing headers gracefully", () => {
    const req = {
      url: "/test?param=value",
      headers: {},
      protocol: "http",
    };
    const result = getQueryParams(req);

    checkEqual(result, {
      param: "value",
    });
  });
});
describe("validateGitSource() tests", () => {
  let originalGitAllow;
  let originalAllowedHosts;

  beforeEach(() => {
    originalGitAllow = process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL;
    originalAllowedHosts = process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
    delete process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL;
    delete process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
  });

  afterEach(() => {
    if (originalGitAllow)
      process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL = originalGitAllow;
    if (originalAllowedHosts)
      process.env.CDXGEN_SERVER_ALLOWED_HOSTS = originalAllowedHosts;
  });

  it("should reject ext:: and fd:: outright", () => {
    checkEqual(
      validateAndRejectGitSource("ext::sh -c id").error,
      "Invalid Protocol",
    );
    checkEqual(validateAndRejectGitSource("fd::123").error, "Invalid Protocol");
    checkEqual(
      validateAndRejectGitSource("EXT::sh -c id").error,
      "Invalid Protocol",
    );
  });

  it("should allow standard local paths to bypass validation", () => {
    checkEqual(validateAndRejectGitSource("/tmp/local-path"), null);
    checkEqual(validateAndRejectGitSource("C:\\Users\\local"), null);
  });

  it("should handle ssh git@ format gracefully", () => {
    checkEqual(validateAndRejectGitSource("git@github.com:foo/bar.git"), null);
  });

  it("should reject malformed git URLs", () => {
    // invalid URL format (can't parse via node's new URL object)
    checkEqual(
      validateAndRejectGitSource("http://[:::1]/bad-ipv6").error,
      "Invalid URL Format",
    );
  });

  it("should enforce GIT_ALLOW_PROTOCOL default schemes", () => {
    checkEqual(validateAndRejectGitSource("https://github.com/repo"), null);
    checkEqual(validateAndRejectGitSource("http://github.com/repo"), {
      status: 400,
      error: "Protocol Not Allowed",
      details: "The protocol 'http:' is not permitted by GIT_ALLOW_PROTOCOL.",
    });
    checkEqual(validateAndRejectGitSource("git://github.com/repo"), null);
    checkEqual(validateAndRejectGitSource("ssh://github.com/repo"), null);
    checkEqual(validateAndRejectGitSource("git+ssh://github.com/repo"), null);

    // ftp is not allowed by default
    const res = validateAndRejectGitSource("ftp://github.com/repo");
    checkEqual(res.error, "Protocol Not Allowed");
    checkEqual(
      res.details,
      "The protocol 'ftp:' is not permitted by GIT_ALLOW_PROTOCOL.",
    );
  });

  it("should reject protocol smuggling techniques", () => {
    checkEqual(
      validateAndRejectGitSource("git+ext://github.com/repo").error,
      "Protocol Not Allowed",
    );
    checkEqual(
      validateAndRejectGitSource("http+ext://github.com/repo").error,
      "Protocol Not Allowed",
    );
  });

  it("should respect custom CDXGEN_SERVER_GIT_ALLOW_PROTOCOL configs", () => {
    process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL = "https:git";
    checkEqual(validateAndRejectGitSource("https://github.com/repo"), null);
    checkEqual(validateAndRejectGitSource("git://github.com/repo"), null);

    // http is no longer allowed
    const res = validateAndRejectGitSource("http://github.com/repo");
    checkEqual(res.error, "Protocol Not Allowed");
    checkEqual(
      res.details,
      "The protocol 'http:' is not permitted by GIT_ALLOW_PROTOCOL.",
    );
  });

  it("should reject remote helper syntax (::) inside valid schemes", () => {
    checkEqual(
      validateAndRejectGitSource("https://github.com/ext::sh -c id").error,
      "Invalid URL Syntax",
    );
    checkEqual(
      validateAndRejectGitSource("git://foo::bar/repo").error,
      "Invalid URL Format",
    );
  });

  it("should validate allowed hosts", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "github.com,gitlab.com";
    checkEqual(validateAndRejectGitSource("https://github.com/repo"), null);

    const res = validateAndRejectGitSource("https://evil.com/repo");
    checkEqual(res.error, "Host Not Allowed");
    checkEqual(res.status, 403);
  });
});
it("should correctly normalize and validate various git@ (SCP-like) formats", () => {
  checkEqual(
    validateAndRejectGitSource("git@gitlab.com:group/project.git"),
    null,
  );
  checkEqual(
    validateAndRejectGitSource("git@bitbucket.org:workspace/repo:name.git"),
    null,
  );
  // git reads this as a local path, not as an SCP-like remote.
  checkEqual(
    validateAndRejectGitSource("git@github.com/user/repo.git").error,
    "Invalid URL Format",
  );
  checkEqual(
    validateAndRejectGitSource("ssh://git@github.com/user/repo.git"),
    null,
  );
  process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "github.com,bitbucket.org";
  checkEqual(validateAndRejectGitSource("git@github.com:user/repo.git"), null);
  checkEqual(
    validateAndRejectGitSource("git@bitbucket.org:workspace/repo.git"),
    null,
  );
  const deniedRes = validateAndRejectGitSource("git@evil.com:foo/bar.git");
  checkEqual(deniedRes.status, 403);
  checkEqual(deniedRes.error, "Host Not Allowed");
  delete process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
});

describe("git remote host differentials", () => {
  const fixture = JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "..",
        "..",
        "test",
        "data",
        "git-remote-differentials.json",
      ),
      "utf-8",
    ),
  );
  // poku hooks are not scoped to a describe block, so set and restore the
  // environment inside each test.
  function withFixtureEnv(fn) {
    const originalAllowedHosts = process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
    const originalAllowProtocol = process.env.CDXGEN_GIT_ALLOW_PROTOCOL;
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = fixture.allowedHosts;
    // Allow every transport so each case is decided by the host checks.
    process.env.CDXGEN_GIT_ALLOW_PROTOCOL = "https:http:ssh:git";
    try {
      fn();
    } finally {
      if (originalAllowedHosts === undefined) {
        delete process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
      } else {
        process.env.CDXGEN_SERVER_ALLOWED_HOSTS = originalAllowedHosts;
      }
      if (originalAllowProtocol === undefined) {
        delete process.env.CDXGEN_GIT_ALLOW_PROTOCOL;
      } else {
        process.env.CDXGEN_GIT_ALLOW_PROTOCOL = originalAllowProtocol;
      }
    }
  }

  it("rejects remotes whose host git reads differently from new URL()", () => {
    withFixtureEnv(() => {
      for (const { remote, reason } of fixture.rejected) {
        const result = validateAndRejectGitSource(remote);
        assert.ok(
          result,
          `${JSON.stringify(remote)} must be rejected: ${reason}`,
        );
        assert.ok([400, 403].includes(result.status), remote);
      }
    });
  });

  it("accepts ordinary remotes on the allowed host", () => {
    withFixtureEnv(() => {
      for (const remote of fixture.accepted) {
        checkEqual(validateAndRejectGitSource(remote), null, remote);
      }
    });
  });

  it("applies the path allowlist to file:// remotes", () => {
    const original = process.env.CDXGEN_SERVER_ALLOWED_PATHS;
    const originalProtocol = process.env.CDXGEN_GIT_ALLOW_PROTOCOL;
    const allowedDir = path.join(os.tmpdir(), "cdxgen-allowed-file-remote");
    process.env.CDXGEN_SERVER_ALLOWED_PATHS = allowedDir;
    process.env.CDXGEN_GIT_ALLOW_PROTOCOL = "https:file";
    try {
      const inside = pathToFileURL(path.join(allowedDir, "repo")).href;
      const outside = pathToFileURL(path.join(os.tmpdir(), "elsewhere")).href;
      checkEqual(validateAndRejectGitSource(inside), null);
      checkEqual(
        validateAndRejectGitSource(outside)?.error,
        "Path Not Allowed",
      );
    } finally {
      if (original === undefined) {
        delete process.env.CDXGEN_SERVER_ALLOWED_PATHS;
      } else {
        process.env.CDXGEN_SERVER_ALLOWED_PATHS = original;
      }
      if (originalProtocol === undefined) {
        delete process.env.CDXGEN_GIT_ALLOW_PROTOCOL;
      } else {
        process.env.CDXGEN_GIT_ALLOW_PROTOCOL = originalProtocol;
      }
    }
  });

  it("reads the host the way git and OpenSSH do", () => {
    checkEqual(
      getGitRemoteHost("https://allowed.com\\@evil.com/x"),
      "evil.com",
    );
    checkEqual(getGitRemoteHost("ssh://allowed.com#@evil.com/x"), undefined);
    checkEqual(getGitRemoteHost("https://a@b@allowed.com/x"), undefined);
    checkEqual(getGitRemoteHost("git@Allowed.com:org/repo.git"), "allowed.com");
    checkEqual(getGitRemoteHost("git@allowed.com/org/repo.git"), undefined);
    checkEqual(getGitRemoteHost("ssh://git@[::1]:22/x"), "[::1]");
    checkEqual(getGitRemoteHost("https://allowed.com:8443"), "allowed.com");
    checkEqual(getGitRemoteHost("ssh://evil%2F@allowed.com/x"), undefined);
    checkEqual(getGitRemoteHost("ssh://[evil]:@allowed.com/x"), undefined);
    // libcurl reads the https authority as written, so a percent-encoded
    // password stays valid there.
    checkEqual(
      getGitRemoteHost("https://user:p%40ss@allowed.com/x"),
      "allowed.com",
    );
    checkEqual(getGitRemoteHost(undefined), undefined);
  });
});

describe("gitClone() hardening tests", () => {
  it("passes core.hooksPath=/dev/null and --template= flags to git", async () => {
    const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/activity.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "../core/fs.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "node:fs": {
        mkdtempSync: mkdtempStub,
        existsSync: sinon.stub().returns(false),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isDirectory: () => true }),
        readFileSync: sinon.stub().returns(""),
      },
    });

    gitClone("https://example.com/repo.git");

    sinon.assert.calledOnce(spawnStub);
    const [cmd, args] = spawnStub.firstCall.args;
    assert.strictEqual(cmd, "git");

    // core.hooksPath=/dev/null must be present as a -c flag
    const hooksPathIdx = args.indexOf("core.hooksPath=/dev/null");
    assert.ok(
      hooksPathIdx > 0 && args[hooksPathIdx - 1] === "-c",
      "expected -c core.hooksPath=/dev/null in git args",
    );

    // --template= must appear after "clone"
    const cloneIdx = args.indexOf("clone");
    assert.ok(cloneIdx >= 0, "expected 'clone' subcommand in git args");
    assert.ok(
      args.slice(cloneIdx).includes("--template="),
      "expected --template= after clone in git args",
    );
  });

  it("uses GIT_CONFIG_GLOBAL=/dev/null instead of invalid GIT_CONFIG_NOGLOBAL in secure mode", async () => {
    const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/activity.js": {
        isSecureMode: true,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "../core/fs.js": {
        isSecureMode: true,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "node:fs": {
        mkdtempSync: mkdtempStub,
        existsSync: sinon.stub().returns(false),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isDirectory: () => true }),
        readFileSync: sinon.stub().returns(""),
      },
    });

    gitClone("https://example.com/repo.git");

    sinon.assert.calledOnce(spawnStub);
    const opts = spawnStub.firstCall.args[2];
    assert.ok(opts.env, "expected env to be set");
    assert.ok(
      !("GIT_CONFIG_NOGLOBAL" in opts.env),
      "GIT_CONFIG_NOGLOBAL must not be set (it is not a valid Git env var)",
    );
    assert.strictEqual(
      opts.env.GIT_CONFIG_GLOBAL,
      "/dev/null",
      "GIT_CONFIG_GLOBAL must be /dev/null in secure mode",
    );
    assert.strictEqual(
      opts.env.GIT_CONFIG_NOSYSTEM,
      "1",
      "GIT_CONFIG_NOSYSTEM must be '1' in secure mode",
    );
  });

  it("sets GIT_TERMINAL_PROMPT=0 in both secure and non-secure mode", async () => {
    for (const secureMode of [false, true]) {
      const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
      const mkdtempStub = sinon
        .stub()
        .returns(path.join(os.tmpdir(), "fake-repo"));

      const { gitClone } = await esmock("../inventory/source.js", {
        "../core/activity.js": {
          isSecureMode: secureMode,
          safeSpawnSync: spawnStub,
          hasDangerousUnicode: sinon.stub().returns(false),
          getTmpDir: sinon.stub().returns(os.tmpdir()),
        },
        "../core/fs.js": {
          isSecureMode: secureMode,
          safeSpawnSync: spawnStub,
          hasDangerousUnicode: sinon.stub().returns(false),
          getTmpDir: sinon.stub().returns(os.tmpdir()),
        },
        "node:fs": {
          mkdtempSync: mkdtempStub,
          existsSync: sinon.stub().returns(false),
          readdirSync: sinon.stub().returns([]),
          statSync: sinon.stub().returns({ isDirectory: () => true }),
          readFileSync: sinon.stub().returns(""),
        },
      });

      gitClone("https://example.com/repo.git");

      const opts = spawnStub.firstCall.args[2];
      assert.strictEqual(
        opts.env.GIT_TERMINAL_PROMPT,
        "0",
        `GIT_TERMINAL_PROMPT must be '0' when isSecureMode=${secureMode}`,
      );
    }
  });

  it("inserts --branch before repoUrl when a valid branch is specified", async () => {
    const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/activity.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "../core/fs.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "node:fs": {
        mkdtempSync: mkdtempStub,
        existsSync: sinon.stub().returns(false),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isDirectory: () => true }),
        readFileSync: sinon.stub().returns(""),
      },
    });

    gitClone("https://example.com/repo.git", "main");

    const [, args] = spawnStub.firstCall.args;
    const branchIdx = args.indexOf("--branch");
    assert.ok(branchIdx >= 0, "expected --branch in git args");
    assert.strictEqual(args[branchIdx + 1], "main");
  });

  it("skips --branch when the branch name starts with a dash", async () => {
    const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/activity.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "../core/fs.js": {
        isSecureMode: false,
        safeSpawnSync: spawnStub,
        hasDangerousUnicode: sinon.stub().returns(false),
        getTmpDir: sinon.stub().returns(os.tmpdir()),
      },
      "node:fs": {
        mkdtempSync: mkdtempStub,
        existsSync: sinon.stub().returns(false),
        readdirSync: sinon.stub().returns([]),
        statSync: sinon.stub().returns({ isDirectory: () => true }),
        readFileSync: sinon.stub().returns(""),
      },
    });

    gitClone("https://example.com/repo.git", "--malicious");

    const [, args] = spawnStub.firstCall.args;
    assert.ok(
      !args.includes("--branch"),
      "must not include --branch for dash-prefixed branch names",
    );
  });

  it("throws without leaking stderr or the URL when git clone fails", async () => {
    const spawnStub = sinon.stub().returns({
      status: 128,
      stderr: "fatal: write error: No space left on device",
    });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));
    const rmStub = sinon.stub();

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: mkdtempStub,
        safeRmSync: rmStub,
        safeSpawnSync: spawnStub,
      },
    });

    const repoUrl = "https://user:token@example.com/repo.git";
    let thrown;
    try {
      gitClone(repoUrl);
    } catch (err) {
      thrown = err;
    }

    assert.ok(thrown, "expected gitClone to throw when git exits non-zero");
    assert.ok(
      !thrown.message.includes("No space left on device"),
      "the error message must not carry the git stderr",
    );
    assert.ok(
      !thrown.message.includes(repoUrl),
      "the error message must not carry the repository URL",
    );
  });

  it("logs git stderr without the credentials of the remote", async () => {
    const stderr =
      "fatal: unable to access 'https://user:token@example.com/repo.git/': Could not resolve host\n" +
      "fatal: fetch from https://other:secret2@mirror.example.org:8443/x failed";
    const spawnStub = sinon.stub().returns({ status: 128, stderr });
    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: sinon
          .stub()
          .returns(path.join(os.tmpdir(), "fake-repo")),
        safeRmSync: sinon.stub(),
        safeSpawnSync: spawnStub,
      },
    });
    const errorStub = sinon.stub(console, "error");
    try {
      assert.throws(() => gitClone("https://user:token@example.com/repo.git"));
      const logged = errorStub.args.map((a) => a.join(" ")).join("\n");
      assert.ok(logged.includes("Could not resolve host"));
      assert.ok(!logged.includes("token"), "the token must not be logged");
      assert.ok(!logged.includes("secret2"), "the password must not be logged");
      assert.ok(!logged.includes("user:"), "the user name must not be logged");
    } finally {
      errorStub.restore();
    }
  });

  it("removes the temporary directory when git clone fails", async () => {
    const spawnStub = sinon.stub().returns({
      status: 128,
      stderr: "fatal: write error: No space left on device",
    });
    const tempDir = path.join(os.tmpdir(), "fake-repo");
    const mkdtempStub = sinon.stub().returns(tempDir);
    const rmStub = sinon.stub();

    const { gitClone } = await esmock("../inventory/source.js", {
      "../core/fs.js": {
        getTmpDir: sinon.stub().returns(os.tmpdir()),
        safeMkdtempSync: mkdtempStub,
        safeRmSync: rmStub,
        safeSpawnSync: spawnStub,
      },
    });

    assert.throws(
      () => gitClone("https://example.com/repo.git"),
      /Git clone failed/,
    );
    sinon.assert.calledOnce(rmStub);
    sinon.assert.calledWith(rmStub, tempDir, {
      recursive: true,
      force: true,
    });
  });
});

describe("/sbom clone failure", () => {
  it("answers 500 with a generic error when the repository cannot be cloned", async () => {
    const previous = process.env.CDXGEN_GIT_ALLOWED_HOSTS;
    process.env.CDXGEN_GIT_ALLOWED_HOSTS = "example.com";
    let cdxgenServer;
    try {
      const http = await import("node:http");
      const { start } = await esmock("./server.js", {
        "../inventory/source.js": {
          // The message plants the git stderr so the assertions below fail
          // when the handler ever copies it into the response.
          gitClone: sinon
            .stub()
            .throws(
              new Error(
                "Git clone failed: fatal: write error: No space left on device",
              ),
            ),
        },
        "node:http": {
          ...http,
          default: {
            ...http.default,
            createServer: (app) => {
              cdxgenServer = http.default.createServer(app);
              return cdxgenServer;
            },
          },
        },
      });
      // start() refuses port 0, so a free port is found first.
      const probe = http.createServer();
      const port = await new Promise((resolve) => {
        probe.listen(0, "127.0.0.1", () => resolve(probe.address().port));
      });
      await new Promise((resolve) => probe.close(resolve));
      start({ serverHost: "127.0.0.1", serverPort: port });
      await new Promise((resolve) => cdxgenServer.once("listening", resolve));
      const response = await fetch(
        `http://127.0.0.1:${port}/sbom?url=${encodeURIComponent("https://example.com/repo.git")}`,
      );
      const body = await response.text();
      assert.strictEqual(response.status, 500);
      const parsed = JSON.parse(body);
      assert.strictEqual(parsed.error, "Unable to clone repository");
      assert.strictEqual(
        parsed.details,
        "Cloning the repository failed. See the server log.",
      );
      assert.ok(
        !body.includes("No space left on device"),
        "the response must not carry the git stderr",
      );
      assert.strictEqual(
        parsed.components,
        undefined,
        "the response must not be a BOM document",
      );
    } finally {
      if (cdxgenServer) {
        await new Promise((resolve) => cdxgenServer.close(resolve));
      }
      if (previous === undefined) {
        delete process.env.CDXGEN_GIT_ALLOWED_HOSTS;
      } else {
        process.env.CDXGEN_GIT_ALLOWED_HOSTS = previous;
      }
    }
  });
});
