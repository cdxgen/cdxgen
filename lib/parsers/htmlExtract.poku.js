import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import esmock from "esmock";
import { describe, it } from "poku";
import sinon from "sinon";

import {
  decodeEntities,
  extractLicenseText,
  extractRepoUrl,
} from "./htmlExtract.js";

const FIXTURE_DIR = "./test/data/pkg-go-dev";
const gorillaLicenses = readFileSync(
  `${FIXTURE_DIR}/gorilla-mux-licenses.html`,
  "utf-8",
);
const awsLicenses = readFileSync(
  `${FIXTURE_DIR}/aws-sdk-go-v2-config-licenses.html`,
  "utf-8",
);
const gorillaUnit = readFileSync(
  `${FIXTURE_DIR}/gorilla-mux-unit-slice.html`,
  "utf-8",
);
const yamlLicenses = readFileSync(
  `${FIXTURE_DIR}/yaml-v3-licenses.html`,
  "utf-8",
);

describe("decodeEntities", () => {
  it("decodes named entities", () => {
    assert.strictEqual(decodeEntities("a &amp; b"), "a & b");
    assert.strictEqual(decodeEntities("&lt;&gt;&quot;&apos;"), "<>\"'");
    assert.strictEqual(decodeEntities("&nbsp;"), "\u00a0");
  });

  it("decodes numeric and hex entities", () => {
    assert.strictEqual(decodeEntities("&#39;"), "'");
    assert.strictEqual(decodeEntities("&#x27;"), "'");
    assert.strictEqual(decodeEntities("&#65;"), "A");
  });

  it("leaves unknown sequences and bare ampersands untouched", () => {
    assert.strictEqual(decodeEntities("&unknown;"), "&unknown;");
    assert.strictEqual(decodeEntities("Tom & Jerry"), "Tom & Jerry");
    assert.strictEqual(decodeEntities("a & b"), "a & b");
    assert.strictEqual(decodeEntities("&"), "&");
    assert.strictEqual(decodeEntities("&;"), "&;");
  });

  it("handles non-string input", () => {
    assert.strictEqual(decodeEntities(null), null);
  });
});

describe("extractLicenseText", () => {
  it("extracts a single licence from a real pkg.go.dev page", () => {
    assert.strictEqual(extractLicenseText(gorillaLicenses), "BSD-3-Clause");
    assert.strictEqual(extractLicenseText(awsLicenses), "Apache-2.0");
  });

  it("extracts a single licence from minimal markup", () => {
    assert.strictEqual(
      extractLicenseText('<section class="License"><h2>MIT</h2></section>'),
      "MIT",
    );
  });

  it("reads several licences from one heading on a real page", () => {
    // pkg.go.dev puts multiple SPDX identifiers in a single comma-separated
    // <h2>, which the caller splits on ", ".
    const text = extractLicenseText(yamlLicenses);
    assert.strictEqual(text, "Apache-2.0, MIT");
    assert.deepStrictEqual(text.split(", "), ["Apache-2.0", "MIT"]);
  });

  it("joins several licence sections so they split into separate licences", () => {
    // No pkg.go.dev page observed emits more than one section. If one ever
    // does, the headings have to be comma-joined: concatenating them would
    // fuse two licences into one identifier that matches nothing.
    const text = extractLicenseText(
      '<section class="License"><h2><div>MIT</div></h2></section>' +
        '<section class="License"><h2><div>Apache-2.0</div></h2></section>',
    );
    assert.strictEqual(text, "MIT, Apache-2.0");
    assert.deepStrictEqual(text.split(", "), ["MIT", "Apache-2.0"]);
  });

  it("matches a class token among several without matching substrings", () => {
    assert.strictEqual(
      extractLicenseText(
        '<section class="License Foo Bar"><h2>ISC</h2></section>',
      ),
      "ISC",
    );
    // "Licensed" must not match "License".
    assert.strictEqual(
      extractLicenseText('<section class="Licensed"><h2>NOPE</h2></section>'),
      "",
    );
  });

  it("decodes entities in licence text", () => {
    assert.strictEqual(
      extractLicenseText(
        '<section class="License"><h2>BSD &amp; Friends</h2></section>',
      ),
      "BSD & Friends",
    );
    assert.strictEqual(
      extractLicenseText(
        '<section class="License"><h2>A&#39;s &lt;tag&gt;</h2></section>',
      ),
      "A's <tag>",
    );
  });

  it("returns an empty string when nothing matches", () => {
    assert.strictEqual(extractLicenseText("<div><p>nothing</p></div>"), "");
    assert.strictEqual(extractLicenseText(""), "");
  });

  it("does not match headings nested inside other elements", () => {
    assert.strictEqual(
      extractLicenseText(
        '<section class="License"><div><h2>NO</h2></div></section>',
      ),
      "",
    );
  });

  it("uses the legacy #LICENSE container when present", () => {
    // Current pkg.go.dev markup has no id="LICENSE", but older markup did.
    assert.strictEqual(
      extractLicenseText('<div id="LICENSE"><h2>GPL-3.0</h2></div>'),
      "GPL-3.0",
    );
  });

  it("falls back to section.License when #LICENSE has no h2", () => {
    assert.strictEqual(
      extractLicenseText(
        '<div id="LICENSE"><p>x</p></div>' +
          '<section class="License"><h2>Fallback</h2></section>',
      ),
      "Fallback",
    );
  });

  it("tolerates truncated and malformed HTML", () => {
    assert.strictEqual(
      extractLicenseText('<section class="License"><h2>MIT</h2'),
      "MIT",
    );
    assert.strictEqual(
      extractLicenseText('<section class="License"><h2>MIT</h2>'),
      "MIT",
    );
  });

  it("never throws on adversarial input", () => {
    const adversarial = [
      null,
      undefined,
      123,
      "<",
      "<<<<<section",
      "<section class=",
      '<section class="License"><h2',
      "<!-- unclosed",
      "&;",
      "&#x;",
    ];
    for (const input of adversarial) {
      assert.doesNotThrow(() => extractLicenseText(input));
    }
  });

  it("treats a void element inside a heading as no text", () => {
    assert.strictEqual(
      extractLicenseText('<section class="License"><h2>A<br>B</h2></section>'),
      "AB",
    );
  });
});

describe("extractRepoUrl", () => {
  it("extracts the repository URL from a real pkg.go.dev page", () => {
    assert.strictEqual(
      extractRepoUrl(gorillaUnit),
      "https://github.com/gorilla/mux",
    );
  });

  it("extracts from minimal markup", () => {
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repo"><a href="https://github.com/a/b">x</a></div>',
      ),
      "https://github.com/a/b",
    );
  });

  it("returns undefined when the container has no anchor", () => {
    assert.strictEqual(
      extractRepoUrl('<div class="UnitMeta-repo"><span>nope</span></div>'),
      undefined,
    );
  });

  it("returns undefined when the container is absent", () => {
    assert.strictEqual(
      extractRepoUrl('<div><a href="x">y</a></div>'),
      undefined,
    );
  });

  it("ignores anchors nested inside other elements (direct child only)", () => {
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repo"><span><a href="nested">y</a></span></div>',
      ),
      undefined,
    );
  });

  it("matches the class token among several without matching substrings", () => {
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repo Foo"><a href="https://r">x</a></div>',
      ),
      "https://r",
    );
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repository"><a href="nope">x</a></div>',
      ),
      undefined,
    );
  });

  it("returns the first direct anchor's href", () => {
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repo"><a href="first">1</a><a href="second">2</a></div>',
      ),
      "first",
    );
  });

  it("decodes entities in the href", () => {
    assert.strictEqual(
      extractRepoUrl(
        '<div class="UnitMeta-repo"><a href="https://x?a=1&amp;b=2">x</a></div>',
      ),
      "https://x?a=1&b=2",
    );
  });

  it("returns undefined for a missing href attribute", () => {
    assert.strictEqual(
      extractRepoUrl('<div class="UnitMeta-repo"><a>x</a></div>'),
      undefined,
    );
  });

  it("never throws on adversarial input", () => {
    const adversarial = [
      null,
      undefined,
      "",
      "<",
      '<div class="UnitMeta-repo"><a hr',
      "<<<&&&>>>",
    ];
    for (const input of adversarial) {
      assert.doesNotThrow(() => extractRepoUrl(input));
    }
  });
});

describe("getGoPkgLicense shape contract", () => {
  it("returns {id} for SPDX ids without spaces and {name} otherwise", async () => {
    const getStub = sinon.stub().resolves({ body: gorillaLicenses });
    const { getGoPkgLicense } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    // BSD-3-Clause has no spaces -> {id}.
    const single = await getGoPkgLicense({
      group: "github.com/gorilla",
      name: "mux",
    });
    assert.deepStrictEqual(single, [
      {
        id: "BSD-3-Clause",
        url: "https://pkg.go.dev/github.com/gorilla/mux?tab=licenses",
      },
    ]);
    assert.ok(getStub.calledOnce);
  });

  it("maps a comma-separated licence name with spaces to {name}", async () => {
    const body =
      '<section class="License"><h2>Some Custom License, MIT</h2></section>';
    const getStub = sinon.stub().resolves({ body });
    const { getGoPkgLicense } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    const result = await getGoPkgLicense({
      group: "example.com",
      name: "multi",
    });
    // "Some Custom License" contains a space -> {name}; "MIT" -> {id}.
    assert.deepStrictEqual(result, [
      {
        name: "Some Custom License",
        url: "https://pkg.go.dev/example.com/multi?tab=licenses",
      },
      { id: "MIT", url: "https://pkg.go.dev/example.com/multi?tab=licenses" },
    ]);
  });

  it("returns an empty list when the page has no licence selector", async () => {
    const getStub = sinon.stub().resolves({ body: "<html>nope</html>" });
    const { getGoPkgLicense } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    const result = await getGoPkgLicense({
      group: "example.com",
      name: "nolicense",
    });
    assert.deepStrictEqual(result, []);
  });
});

describe("getGoPkgVCSUrl shape contract", () => {
  it("returns the repository href from the page", async () => {
    const getStub = sinon.stub().resolves({ body: gorillaUnit });
    const { getGoPkgVCSUrl } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    const url = await getGoPkgVCSUrl("bitbucket.org", "somepkg");
    assert.strictEqual(url, "https://github.com/gorilla/mux");
  });

  it("returns undefined when the container has no anchor", async () => {
    const getStub = sinon.stub().resolves({
      body: '<div class="UnitMeta-repo"><span>none</span></div>',
    });
    const { getGoPkgVCSUrl } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    const url = await getGoPkgVCSUrl("bitbucket.org", "somepkg");
    assert.strictEqual(url, undefined);
  });

  it("short-circuits github.com/gitlab.com groups without a request", async () => {
    const getStub = sinon.stub();
    const { getGoPkgVCSUrl } = await esmock("../ecosystems/ecosystems.js", {
      "../core/activity.js": { cdxgenAgent: { get: getStub } },
      "../inventory/fetchBatch.js": {
        gatedGet: (url, options) => getStub(url, options),
      },
    });
    const url = await getGoPkgVCSUrl("github.com", "gorilla/mux");
    assert.strictEqual(url, "https://github.com/gorilla/mux");
    assert.strictEqual(getStub.callCount, 0);
  });
});
