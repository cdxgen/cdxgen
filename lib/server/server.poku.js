import { afterEach, assert, beforeEach, describe, it } from "poku";

import { isWin } from "../helpers/utils.js";
import {
  getQueryParams,
  isAllowedHost,
  isAllowedPath,
  isAllowedWinPath,
  parseQueryString,
  parseValue,
  validateAndRejectGitSource,
} from "./server.js";

it("parseValue tests", () => {
  assert.deepStrictEqual(parseValue("foo"), "foo");
  assert.deepStrictEqual(parseValue("foo\n"), "foo");
  assert.deepStrictEqual(parseValue("foo\r\n"), "foo");
  assert.deepStrictEqual(parseValue(1), 1);
  assert.deepStrictEqual(parseValue("true"), true);
  assert.deepStrictEqual(parseValue("false"), false);
  assert.deepStrictEqual(parseValue(["foo", "bar", 42]), ["foo", "bar", 42]);
  assert.throws(() => parseValue({ foo: "bar" }), TypeError);
  assert.throws(() => parseValue([42, "foo", { foo: "bar" }]), TypeError);
  assert.throws(() => parseValue([42, "foo", new Error()]), TypeError);
  assert.throws(() => parseValue(["foo", "bar", new String(42)]), TypeError);
  assert.deepStrictEqual(parseValue(true), true);
  assert.deepStrictEqual(parseValue(false), false);
  assert.deepStrictEqual(parseValue(null), null);
  assert.deepStrictEqual(parseValue(undefined), undefined);
  assert.deepStrictEqual(parseValue([null, undefined, null]), [
    null,
    undefined,
    null,
  ]);
  assert.deepStrictEqual(parseValue(""), "");
  assert.deepStrictEqual(parseValue("   \n"), "   ");
  assert.deepStrictEqual(parseValue("42"), "42");
  assert.deepStrictEqual(parseValue("0"), "0");
  assert.deepStrictEqual(parseValue("-1"), "-1");
  assert.deepStrictEqual(parseValue("True"), "True");
  assert.deepStrictEqual(parseValue("False"), "False");
  assert.deepStrictEqual(parseValue(" TRUE "), " TRUE ");
  assert.deepStrictEqual(
    parseValue(["true", "false", 0, "0", null, undefined]),
    [true, false, 0, "0", null, undefined],
  );
  assert.throws(() => parseValue([["nested"]]), TypeError);
  assert.throws(() => parseValue(Symbol("test")), TypeError);
  assert.throws(() => parseValue(BigInt(42)), TypeError);
  // biome-ignore-start lint/suspicious/noEmptyBlockStatements: test
  assert.throws(() => parseValue(() => {}), TypeError);
  // biome-ignore-end lint/suspicious/noEmptyBlockStatements: test
  assert.deepStrictEqual(parseValue(Number.NaN), Number.NaN);
  assert.deepStrictEqual(
    parseValue(Number.POSITIVE_INFINITY),
    Number.POSITIVE_INFINITY,
  );
  const obj = { toString: () => "foo" };
  assert.throws(() => parseValue(obj), TypeError);
  assert.deepStrictEqual(parseValue("hello\r\n"), "hello");
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
    assert.deepStrictEqual(result.foo, undefined);
    assert.deepStrictEqual(result.excludeType, ["2"]);
    assert.deepStrictEqual(result.technique, ["manifest-analysis"]);
  });

  it("splits type into projectType and removes type", () => {
    const options = { type: "a,b,c" };
    const result = parseQueryString({}, {}, options);
    assert.deepStrictEqual(result.projectType, ["a", "b", "c"]);
    assert.deepStrictEqual(result.type, undefined);
  });

  it("sets installDeps to false for pre-build lifecycle", () => {
    const options = { lifecycle: "pre-build" };
    const result = parseQueryString({}, {}, options);
    assert.deepStrictEqual(result.installDeps, false);
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
    assert.deepStrictEqual(isAllowedHost("anything"), true);
  });

  it("returns true for a hostname that is in the list", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "foo.com,bar.com";
    assert.deepStrictEqual(isAllowedHost("foo.com"), true);
    assert.deepStrictEqual(isAllowedHost("bar.com"), true);
  });

  it("returns false for a hostname not in the list", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "foo.com,bar.com";
    assert.deepStrictEqual(isAllowedHost("baz.com"), false);
  });

  it("treats an empty-string env var as unset (returns true)", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "";
    assert.deepStrictEqual(isAllowedHost("whatever"), true);
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
      assert.deepStrictEqual(isAllowedWinPath("CON:../foo"), false);
      assert.deepStrictEqual(isAllowedWinPath("X:\\foo\\..\\bar"), true);
      assert.deepStrictEqual(isAllowedWinPath("C:\\Users"), true);
      assert.deepStrictEqual(isAllowedWinPath("C:\\🚀"), true);
      assert.deepStrictEqual(isAllowedWinPath("C:"), true);
      assert.deepStrictEqual(isAllowedWinPath("c:"), true);
      assert.deepStrictEqual(isAllowedWinPath("CON:"), false);
      assert.deepStrictEqual(isAllowedWinPath("COM¹:"), false);
      assert.deepStrictEqual(isAllowedWinPath("COM¹:../foo"), false);
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
        assert.deepStrictEqual(isAllowedWinPath(d), false);
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

    assert.deepStrictEqual(result, {
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

    assert.deepStrictEqual(result, {
      q: "hello world",
      filter: "category=tech",
    });
  });

  it("should handle multiple values for the same parameter", () => {
    const req = createMockRequest("/api?tags=javascript&tags=react&tags=node");
    const result = getQueryParams(req);

    // URLSearchParams.entries() returns the first value when there are duplicates
    assert.deepStrictEqual(result, {
      tags: ["javascript", "react", "node"],
    });
  });

  it("should handle empty query string", () => {
    const req = createMockRequest("/sbom");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {});
  });

  it("should handle query string with only question mark", () => {
    const req = createMockRequest("/sbom?");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {});
  });

  it("should handle parameters without values", () => {
    const req = createMockRequest("/api?flag1&flag2&param=value");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {
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

    assert.deepStrictEqual(result, {
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

    assert.deepStrictEqual(result, {
      token: "abc123",
    });
  });

  it("should handle complex URL with path segments", () => {
    const req = createMockRequest(
      "/api/v1/users/search?name=john&age=25&active=true",
    );
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {
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

    assert.deepStrictEqual(result, {
      q: "hello world!",
      category: "web development",
    });
  });

  it("should return empty object when url is undefined", () => {
    const req = createMockRequest(undefined);
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {});
  });

  it("should handle numeric values as strings", () => {
    const req = createMockRequest("/calculate?x=10&y=20&operation=add");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {
      x: "10",
      y: "20",
      operation: "add",
    });
  });

  it("should handle boolean-like values as strings", () => {
    const req = createMockRequest("/config?debug=true&verbose=false&enabled=1");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {
      debug: "true",
      verbose: "false",
      enabled: "1",
    });
  });

  // Error handling tests
  it("should handle malformed URL gracefully", () => {
    const req = createMockRequest("not-a-valid-url");
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {});
  });

  it("should handle empty host gracefully", () => {
    const req = {
      url: "/test?param=value",
      headers: { host: "" },
      protocol: "http",
    };
    const result = getQueryParams(req);

    assert.deepStrictEqual(result, {
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

    assert.deepStrictEqual(result, {
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
    assert.deepStrictEqual(
      validateAndRejectGitSource("ext::sh -c id").error,
      "Invalid Protocol",
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("fd::123").error,
      "Invalid Protocol",
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("EXT::sh -c id").error,
      "Invalid Protocol",
    );
  });

  it("should allow standard local paths to bypass validation", () => {
    assert.deepStrictEqual(validateAndRejectGitSource("/tmp/local-path"), null);
    assert.deepStrictEqual(
      validateAndRejectGitSource("C:\\Users\\local"),
      null,
    );
  });

  it("should handle ssh git@ format gracefully", () => {
    assert.deepStrictEqual(
      validateAndRejectGitSource("git@github.com:foo/bar.git"),
      null,
    );
  });

  it("should reject malformed git URLs", () => {
    // invalid URL format (can't parse via node's new URL object)
    assert.deepStrictEqual(
      validateAndRejectGitSource("http://[:::1]/bad-ipv6").error,
      "Invalid URL Format",
    );
  });

  it("should enforce GIT_ALLOW_PROTOCOL default schemes", () => {
    assert.deepStrictEqual(
      validateAndRejectGitSource("https://github.com/repo"),
      null,
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("http://github.com/repo"),
      {
        status: 400,
        error: "Protocol Not Allowed",
        details: "The protocol 'http:' is not permitted by GIT_ALLOW_PROTOCOL.",
      },
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("git://github.com/repo"),
      null,
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("ssh://github.com/repo"),
      null,
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("git+ssh://github.com/repo"),
      null,
    );

    // ftp is not allowed by default
    const res = validateAndRejectGitSource("ftp://github.com/repo");
    assert.deepStrictEqual(res.error, "Protocol Not Allowed");
    assert.deepStrictEqual(
      res.details,
      "The protocol 'ftp:' is not permitted by GIT_ALLOW_PROTOCOL.",
    );
  });

  it("should reject protocol smuggling techniques", () => {
    assert.deepStrictEqual(
      validateAndRejectGitSource("git+ext://github.com/repo").error,
      "Protocol Not Allowed",
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("http+ext://github.com/repo").error,
      "Protocol Not Allowed",
    );
  });

  it("should respect custom CDXGEN_SERVER_GIT_ALLOW_PROTOCOL configs", () => {
    process.env.CDXGEN_SERVER_GIT_ALLOW_PROTOCOL = "https:git";
    assert.deepStrictEqual(
      validateAndRejectGitSource("https://github.com/repo"),
      null,
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("git://github.com/repo"),
      null,
    );

    // http is no longer allowed
    const res = validateAndRejectGitSource("http://github.com/repo");
    assert.deepStrictEqual(res.error, "Protocol Not Allowed");
    assert.deepStrictEqual(
      res.details,
      "The protocol 'http:' is not permitted by GIT_ALLOW_PROTOCOL.",
    );
  });

  it("should reject remote helper syntax (::) inside valid schemes", () => {
    assert.deepStrictEqual(
      validateAndRejectGitSource("https://github.com/ext::sh -c id").error,
      "Invalid URL Syntax",
    );
    assert.deepStrictEqual(
      validateAndRejectGitSource("git://foo::bar/repo").error,
      "Invalid URL Format",
    );
  });

  it("should validate allowed hosts", () => {
    process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "github.com,gitlab.com";
    assert.deepStrictEqual(
      validateAndRejectGitSource("https://github.com/repo"),
      null,
    );

    const res = validateAndRejectGitSource("https://evil.com/repo");
    assert.deepStrictEqual(res.error, "Host Not Allowed");
    assert.deepStrictEqual(res.status, 403);
  });
});
it("should correctly normalize and validate various git@ (SCP-like) formats", () => {
  assert.deepStrictEqual(
    validateAndRejectGitSource("git@gitlab.com:group/project.git"),
    null,
  );
  assert.deepStrictEqual(
    validateAndRejectGitSource("git@bitbucket.org:workspace/repo:name.git"),
    null,
  );
  assert.deepStrictEqual(
    validateAndRejectGitSource("git@github.com/user/repo.git"),
    null,
  );
  assert.deepStrictEqual(
    validateAndRejectGitSource("ssh://git@github.com/user/repo.git"),
    null,
  );
  process.env.CDXGEN_SERVER_ALLOWED_HOSTS = "github.com,bitbucket.org";
  assert.deepStrictEqual(
    validateAndRejectGitSource("git@github.com:user/repo.git"),
    null,
  );
  assert.deepStrictEqual(
    validateAndRejectGitSource("git@bitbucket.org:workspace/repo.git"),
    null,
  );
  const deniedRes = validateAndRejectGitSource("git@evil.com:foo/bar.git");
  assert.deepStrictEqual(deniedRes.status, 403);
  assert.deepStrictEqual(deniedRes.error, "Host Not Allowed");
  delete process.env.CDXGEN_SERVER_ALLOWED_HOSTS;
});
