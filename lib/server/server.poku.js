import os from "node:os";
import path from "node:path";

import esmock from "esmock";
import { afterEach, assert, beforeEach, describe, it } from "poku";
import sinon from "sinon";

import {
  isAllowedHost,
  isAllowedPath,
  isAllowedWinPath,
  validateAndRejectGitSource,
} from "../helpers/source.js";
import { isWin } from "../helpers/utils.js";
import { getQueryParams, parseQueryString, parseValue } from "./server.js";

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
  checkEqual(validateAndRejectGitSource("git@github.com/user/repo.git"), null);
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

describe("gitClone() hardening tests", () => {
  it("passes core.hooksPath=/dev/null and --template= flags to git", async () => {
    const spawnStub = sinon.stub().returns({ status: 0, stderr: "" });
    const mkdtempStub = sinon
      .stub()
      .returns(path.join(os.tmpdir(), "fake-repo"));

    const { gitClone } = await esmock("../helpers/source.js", {
      "../helpers/utils.js": {
        safeSpawnSync: spawnStub,
        isSecureMode: false,
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

    const { gitClone } = await esmock("../helpers/source.js", {
      "../helpers/utils.js": {
        safeSpawnSync: spawnStub,
        isSecureMode: true,
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

      const { gitClone } = await esmock("../helpers/source.js", {
        "../helpers/utils.js": {
          safeSpawnSync: spawnStub,
          isSecureMode: secureMode,
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

    const { gitClone } = await esmock("../helpers/source.js", {
      "../helpers/utils.js": {
        safeSpawnSync: spawnStub,
        isSecureMode: false,
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

    const { gitClone } = await esmock("../helpers/source.js", {
      "../helpers/utils.js": {
        safeSpawnSync: spawnStub,
        isSecureMode: false,
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
});
