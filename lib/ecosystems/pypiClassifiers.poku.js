import { strict as assert, describe, it } from "poku";

import { determinePackageType } from "../cli/bomAssembly.js";
import {
  applyPypiClassifierMetadata,
  applyPypiModuleNames,
  normalizePypiName,
  parsePypiClassifiers,
  pypiModulesForPackage,
} from "./pypiClassifiers.js";

function propertyValue(pkg, name) {
  return (pkg.properties || []).find((p) => p.name === name)?.value;
}

describe("normalizePypiName()", () => {
  it("applies PEP 503 normalization", () => {
    assert.equal(normalizePypiName("Flask-SQLAlchemy"), "flask-sqlalchemy");
    assert.equal(normalizePypiName("zope.interface"), "zope-interface");
    assert.equal(normalizePypiName("typing_extensions"), "typing-extensions");
    assert.equal(normalizePypiName("ruamel..yaml"), "ruamel-yaml");
    assert.equal(normalizePypiName("  Django  "), "django");
  });

  it("returns an empty string for unusable input", () => {
    assert.equal(normalizePypiName(""), "");
    assert.equal(normalizePypiName(undefined), "");
    assert.equal(normalizePypiName(null), "");
    assert.equal(normalizePypiName(42), "");
  });
});

describe("parsePypiClassifiers()", () => {
  it("reads the declared framework and drops the version segment", () => {
    const { frameworks, tags } = parsePypiClassifiers([
      "Framework :: Django",
      "Framework :: Django :: 5.0",
      "License :: OSI Approved :: MIT License",
    ]);
    assert.deepEqual(frameworks, ["django"]);
    assert.ok(tags.includes("django"));
    assert.ok(tags.includes("framework"));
  });

  it("withholds the generic framework tag for development tooling", () => {
    const { frameworks, tags } = parsePypiClassifiers(["Framework :: Pytest"]);
    // The declaration is still recorded - it is true - but a pytest plugin is not
    // something an application runs on, and tagging it `framework` would put that
    // tag on most of a project's dev dependencies.
    assert.deepEqual(frameworks, ["pytest"]);
    assert.ok(tags.includes("pytest"));
    assert.ok(!tags.includes("framework"));
  });

  it("withholds the generic framework tag for concurrency runtimes", () => {
    // Observed live: fastapi declares `Framework :: AsyncIO` and starlette
    // declares `Framework :: AnyIO`. A very large share of the async ecosystem
    // does the same, so promoting on these would make `framework` meaningless.
    for (const declared of ["Framework :: AsyncIO", "Framework :: AnyIO"]) {
      const { tags } = parsePypiClassifiers([declared]);
      assert.ok(!tags.includes("framework"), `${declared} must not promote`);
    }
  });

  it("maps Topic classifiers onto the component-tags vocabulary", () => {
    const { tags } = parsePypiClassifiers([
      "Topic :: Internet :: WWW/HTTP :: WSGI :: Application",
      "Topic :: Security :: Cryptography",
      "Topic :: Scientific/Engineering :: Artificial Intelligence",
    ]);
    for (const expected of [
      "web",
      "http",
      "wsgi",
      "crypto",
      "security",
      "ai",
      "ml",
    ]) {
      assert.ok(tags.includes(expected), `expected tag ${expected}`);
    }
  });

  it("treats the Application Frameworks topic as a framework declaration", () => {
    const { tags } = parsePypiClassifiers([
      "Topic :: Software Development :: Libraries :: Application Frameworks",
    ]);
    assert.ok(tags.includes("framework"));
  });

  it("matches a Topic prefix only on a segment boundary", () => {
    // "Topic :: Security" must not be reached by an unrelated deeper topic that
    // merely starts with the same characters.
    const { tags } = parsePypiClassifiers(["Topic :: Securityish :: Nope"]);
    assert.deepEqual(tags, []);
  });

  it("tolerates missing, empty and malformed input", () => {
    assert.deepEqual(parsePypiClassifiers(undefined), {
      frameworks: [],
      tags: [],
    });
    assert.deepEqual(parsePypiClassifiers([]), { frameworks: [], tags: [] });
    assert.deepEqual(parsePypiClassifiers([null, "", "Framework :: ", 7]), {
      frameworks: [],
      tags: [],
    });
  });
});

describe("pypiModulesForPackage()", () => {
  it("uses the curated alias map for names the module cannot be derived from", () => {
    // The case the old `.replace("py", "")` heuristic in downstream consumers was
    // reaching for.
    assert.ok(pypiModulesForPackage("PyYAML").includes("yaml"));
    assert.ok(pypiModulesForPackage("absl-py").includes("absl"));
  });

  it("falls back to the name-derived module", () => {
    assert.deepEqual(pypiModulesForPackage("typing_extensions"), [
      "typing_extensions",
    ]);
    assert.deepEqual(pypiModulesForPackage("flask"), ["flask"]);
  });

  it("does not mangle names containing 'py'", () => {
    // Regression guard for the class of bug this data replaces: substring surgery
    // turned cryptography into crtography and numpy into num.
    for (const name of ["cryptography", "numpy", "scipy", "mypy"]) {
      assert.ok(
        pypiModulesForPackage(name).includes(name),
        `${name} should resolve to itself`,
      );
    }
  });

  it("returns an empty list for unusable input", () => {
    assert.deepEqual(pypiModulesForPackage(""), []);
    assert.deepEqual(pypiModulesForPackage(undefined), []);
  });
});

describe("applyPypiClassifierMetadata()", () => {
  it("merges tags rather than replacing pre-existing ones", () => {
    // lib/managers/binary.js sets tags: ["source"] as an identity marker.
    const pkg = { name: "flask", tags: ["source"] };
    applyPypiClassifierMetadata(pkg, ["Framework :: Flask"]);
    assert.ok(pkg.tags.includes("source"));
    assert.ok(pkg.tags.includes("flask"));
    assert.ok(pkg.tags.includes("framework"));
  });

  it("records the frameworks and the full classifier list as properties", () => {
    const pkg = { name: "flask-login" };
    applyPypiClassifierMetadata(pkg, [
      "Framework :: Flask",
      "Topic :: Internet :: WWW/HTTP :: Session",
    ]);
    assert.equal(propertyValue(pkg, "cdx:pypi:frameworks"), "flask");
    assert.equal(
      propertyValue(pkg, "cdx:pypi:classifiers"),
      "Framework :: Flask\nTopic :: Internet :: WWW/HTTP :: Session",
    );
  });

  it("is a no-op without classifiers", () => {
    const pkg = { name: "flask" };
    applyPypiClassifierMetadata(pkg, []);
    applyPypiClassifierMetadata(pkg, undefined);
    assert.equal(pkg.tags, undefined);
    assert.equal(pkg.properties, undefined);
  });
});

describe("applyPypiModuleNames()", () => {
  it("emits internal:Namespaces with provenance", () => {
    const pkg = { name: "PyYAML" };
    applyPypiModuleNames(pkg);
    assert.equal(propertyValue(pkg, "internal:Namespaces"), "yaml\npyyaml");
    assert.equal(
      propertyValue(pkg, "cdx:pypi:modulesFrom"),
      "alias-map,distribution-name",
    );
  });

  it("marks name-derived-only resolutions as such", () => {
    // `flask` has an alias-map entry, but it maps to the module the name already
    // implies, so the map contributed nothing and must not be claimed as a source.
    const pkg = { name: "flask" };
    applyPypiModuleNames(pkg);
    assert.equal(propertyValue(pkg, "internal:Namespaces"), "flask");
    assert.equal(
      propertyValue(pkg, "cdx:pypi:modulesFrom"),
      "distribution-name",
    );
  });

  it("strips extras and skips url-shaped names", () => {
    const withExtras = { name: "requests[security]" };
    applyPypiModuleNames(withExtras);
    assert.equal(propertyValue(withExtras, "internal:Namespaces"), "requests");

    const urlName = { name: "https://example.invalid/pkg.tar.gz" };
    applyPypiModuleNames(urlName);
    assert.equal(urlName.properties, undefined);
  });

  it("is idempotent", () => {
    const pkg = { name: "flask" };
    applyPypiModuleNames(pkg);
    applyPypiModuleNames(pkg);
    assert.equal(
      pkg.properties.filter((p) => p.name === "internal:Namespaces").length,
      1,
    );
  });
});

describe("classifier-derived framework tag reaches the component type", () => {
  it("promotes a package tagged framework to type framework", () => {
    // The wiring that makes the classifier work end to end: determinePackageType
    // already promotes any package carrying a `framework` tag.
    const pkg = {
      name: "flask-talisman",
      purl: "pkg:pypi/flask-talisman@1.1.0",
    };
    applyPypiClassifierMetadata(pkg, ["Framework :: Flask"]);
    assert.equal(determinePackageType(pkg), "framework");
  });

  it("leaves a pytest plugin as a library", () => {
    const pkg = { name: "pytest-cov", purl: "pkg:pypi/pytest-cov@5.0.0" };
    applyPypiClassifierMetadata(pkg, ["Framework :: Pytest"]);
    assert.equal(determinePackageType(pkg), "library");
  });
});
