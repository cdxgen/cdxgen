import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { assert, describe, it } from "poku";

import {
  _resetOsReleaseCache,
  canonicalDistroQualifier,
  getDistroInfo,
  isCleanDistroQualifier,
  OS_DISTRO_ALIAS,
  OS_NAMESPACE_ALIAS,
} from "./osinfo.js";

const AZURE_LINUX_3_OS_RELEASE = [
  'NAME="Microsoft Azure Linux"',
  'VERSION="3.0.20260809"',
  "ID=azurelinux",
  'VERSION_ID="3.0"',
  'PRETTY_NAME="Microsoft Azure Linux 3.0"',
  'ANSI_COLOR="1;34"',
  'HOME_URL="https://aka.ms/azurelinux"',
  'BUG_REPORT_URL="https://aka.ms/azurelinux"',
  'SUPPORT_URL="https://aka.ms/azurelinux"',
  "",
].join("\n");

const MARINER_2_OS_RELEASE = [
  'NAME="Common Base Linux Mariner"',
  'VERSION="2.0.20260304"',
  "ID=mariner",
  'VERSION_ID="2.0"',
  'PRETTY_NAME="CBL-Mariner/Linux"',
  'ANSI_COLOR="1;34"',
  'HOME_URL="https://aka.ms/cbl-mariner"',
  'BUG_REPORT_URL="https://aka.ms/cbl-mariner"',
  'SUPPORT_URL="https://aka.ms/cbl-mariner"',
  "",
].join("\n");

function osReleaseRoot(body, location = join("etc", "os-release")) {
  const root = mkdtempSync(join(tmpdir(), "cdxgen-osinfo-"));
  const osReleaseFile = join(root, location);
  mkdirSync(dirname(osReleaseFile), { recursive: true });
  writeFileSync(osReleaseFile, body);
  return root;
}

describe("getDistroInfo() azure linux canonicalisation", () => {
  it("canonicalises azurelinux 3.0 to the azure-linux namespace", () => {
    _resetOsReleaseCache();
    const root = osReleaseRoot(AZURE_LINUX_3_OS_RELEASE);
    try {
      const info = getDistroInfo(root);
      assert.strictEqual(info.purlType, "rpm");
      assert.strictEqual(info.namespace, "azure-linux");
      assert.strictEqual(info.distroId, "azure-linux-3.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalises mariner 2.0 (cbl-mariner) to the azure-linux namespace", () => {
    _resetOsReleaseCache();
    const root = osReleaseRoot(MARINER_2_OS_RELEASE);
    try {
      const info = getDistroInfo(root);
      assert.strictEqual(info.purlType, "rpm");
      assert.strictEqual(info.namespace, "azure-linux");
      assert.strictEqual(info.distroId, "azure-linux-2.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("canonicalises the cbl-mariner spelling from usr/lib/os-release", () => {
    _resetOsReleaseCache();
    const root = osReleaseRoot(
      'ID=cbl-mariner\nVERSION_ID="2.0"\n',
      join("usr", "lib", "os-release"),
    );
    try {
      const info = getDistroInfo(root);
      assert.strictEqual(info.namespace, "azure-linux");
      assert.strictEqual(info.distroId, "azure-linux-2.0");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("getDistroInfo() vendor aliases", () => {
  const cases = [
    {
      title: "rhel -> redhat",
      body: 'ID=rhel\nVERSION_ID="9.4"\nNAME="Red Hat Enterprise Linux"\n',
      namespace: "redhat",
      distroId: "redhat-9.4",
      purlType: "rpm",
    },
    {
      title: "ol -> oracle",
      body: 'ID=ol\nVERSION_ID="9.8"\n',
      namespace: "oracle",
      distroId: "oracle-9.8",
      purlType: "rpm",
    },
    {
      title: "amzn -> amazon (the spelling the vulnerability feeds publish)",
      body: 'ID=amzn\nVERSION_ID="2023"\n',
      namespace: "amazon",
      distroId: "amazon-2023",
      purlType: "rpm",
    },
    {
      title: "opensuse-leap -> opensuse",
      body: 'ID=opensuse-leap\nVERSION_ID="15.6"\n',
      namespace: "opensuse",
      distroId: "opensuse-leap-15.6",
      purlType: "rpm",
    },
    {
      title: "ubuntu stays ubuntu with codename",
      body: 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME="jammy"\n',
      namespace: "ubuntu",
      distroId: "ubuntu-22.04",
      distroName: "jammy",
      purlType: "deb",
    },
    {
      title: "ubuntu without VERSION_CODENAME falls back to the alias map",
      body: 'ID=ubuntu\nVERSION_ID="26.04"\n',
      namespace: "ubuntu",
      distroId: "ubuntu-26.04",
      distroName: "resolute",
      purlType: "deb",
    },
    {
      title: "debian takes the codename from os-release",
      body: 'ID=debian\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n',
      namespace: "debian",
      distroId: "debian-13",
      distroName: "trixie",
      purlType: "deb",
    },
    {
      // The container scan stamps distro=alpine-3.24.3 and
      // distro_name=alpine-3.24 on every Alpine package, so a live host and
      // the image it was built from must give the same pair.
      title:
        "alpine keeps the full VERSION_ID in the distro id and names its release series",
      body: 'ID=alpine\nVERSION_ID="3.20.0"\n',
      namespace: "alpine",
      distroId: "alpine-3.20.0",
      distroName: "alpine-3.20",
      purlType: "apk",
    },
    {
      title: "alpine edge keeps its pre-release VERSION_ID",
      body: "ID=alpine\nVERSION_ID=3.25.0_alpha20260601\n",
      namespace: "alpine",
      distroId: "alpine-3.25.0_alpha20260601",
      distroName: "alpine-3.25",
      purlType: "apk",
    },
    {
      title: "alpaquita keeps its own vendor and release channel",
      body: 'ID=alpaquita\nID_LIKE=alpine\nVERSION_ID="stream"\n',
      namespace: "alpaquita",
      distroId: "alpaquita-stream",
      distroName: "",
      purlType: "apk",
    },
    {
      title: "wolfi is an apk distro with its own vendor",
      body: 'ID=wolfi\nNAME="Wolfi"\nVERSION_ID="20230201"\n',
      namespace: "wolfi",
      distroId: "wolfi-20230201",
      distroName: "",
      purlType: "apk",
    },
    {
      title: "chainguard is an apk distro with its own vendor",
      body: 'ID=chainguard\nNAME="Chainguard"\nVERSION_ID="20230214"\n',
      namespace: "chainguard",
      distroId: "chainguard-20230214",
      distroName: "",
      purlType: "apk",
    },
    {
      title: "arch is a pacman distro, not the rpm default (archlinux:latest)",
      body: 'NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\nVERSION_ID=20261018.0.612668\n',
      namespace: "arch",
      distroId: "arch-20261018.0.612668",
      distroName: "",
      purlType: "alpm",
    },
    {
      title: "manjaro keeps its own vendor and is a pacman distro",
      body: 'NAME="Manjaro Linux"\nID=manjaro\nID_LIKE=arch\nBUILD_ID=rolling\n',
      namespace: "manjaro",
      distroId: "manjaro",
      distroName: "",
      purlType: "alpm",
    },
    {
      title: "steamos is a pacman distro through ID_LIKE",
      body: 'NAME="SteamOS"\nID=steamos\nID_LIKE=arch\nVERSION_ID=3.7.13\n',
      namespace: "steamos",
      distroId: "steamos-3.7.13",
      distroName: "",
      purlType: "alpm",
    },
    {
      title: "an unknown derivative is a pacman distro when ID_LIKE lists arch",
      body: 'ID=garuda\nID_LIKE="arch"\nBUILD_ID=rolling\n',
      namespace: "garuda",
      distroId: "garuda",
      distroName: "",
      purlType: "alpm",
    },
    {
      title: "arch inside another ID_LIKE word does not make a pacman distro",
      body: 'ID=monarchos\nID_LIKE="monarch"\nVERSION_ID="1"\n',
      namespace: "monarchos",
      distroId: "monarchos-1",
      purlType: "rpm",
    },
  ];
  for (const testCase of cases) {
    it(testCase.title, () => {
      _resetOsReleaseCache();
      const root = osReleaseRoot(testCase.body);
      try {
        const info = getDistroInfo(root);
        assert.strictEqual(info.namespace, testCase.namespace);
        assert.strictEqual(info.distroId, testCase.distroId);
        assert.strictEqual(info.purlType, testCase.purlType);
        if ("distroName" in testCase) {
          assert.strictEqual(info.distroName, testCase.distroName);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("getDistroInfo() distro_name follows the container scan", () => {
  // The container scan only stamps a distro_name that is a release codename or
  // a token OS_DISTRO_ALIAS knows. A product display name such as "AlmaLinux"
  // or "Rocky Linux" is not one: RPM distros track packages flat, and a display
  // name there breaks vulnerability matching.
  const ALMALINUX_9_OS_RELEASE = [
    'NAME="AlmaLinux"',
    'VERSION="9.8 (Olive Jaguar)"',
    'ID="almalinux"',
    'ID_LIKE="rhel centos fedora"',
    'VERSION_ID="9.8"',
    'PLATFORM_ID="platform:el9"',
    'PRETTY_NAME="AlmaLinux 9.8 (Olive Jaguar)"',
    'ALMALINUX_MANTISBT_PROJECT="AlmaLinux-9"',
    'ALMALINUX_MANTISBT_PROJECT_VERSION="9.8"',
    'REDHAT_SUPPORT_PRODUCT="AlmaLinux"',
    'REDHAT_SUPPORT_PRODUCT_VERSION="9.8"',
    "",
  ].join("\n");
  const cases = [
    {
      title:
        "almalinux (os-release recorded from almalinux:9) has no distro_name",
      body: ALMALINUX_9_OS_RELEASE,
      distroId: "almalinux-9.8",
      distroName: "",
    },
    {
      title: "rocky has no distro_name",
      body: 'ID="rocky"\nVERSION_ID="9.5"\nREDHAT_SUPPORT_PRODUCT="Rocky Linux"\nREDHAT_BUGZILLA_PRODUCT="Rocky Linux 9"\n',
      distroId: "rocky-9.5",
      distroName: "",
    },
    {
      title: "centos stream has no distro_name",
      body: 'ID="centos"\nVERSION_ID="9"\nCENTOS_MANTISBT_PROJECT="CentOS-Stream-9"\n',
      distroId: "centos-9",
      distroName: "",
    },
    {
      title: "fedora has no distro_name",
      body: "ID=fedora\nVERSION_ID=41\nREDHAT_BUGZILLA_PRODUCT=Fedora\nREDHAT_SUPPORT_PRODUCT=Fedora\n",
      distroId: "fedora-41",
      distroName: "",
    },
    {
      title: "oracle linux has no distro_name",
      body: 'ID="ol"\nVERSION_ID="9.4"\nREDHAT_BUGZILLA_PRODUCT="Oracle Linux 9"\nREDHAT_SUPPORT_PRODUCT="Oracle Linux"\n',
      distroId: "oracle-9.4",
      distroName: "",
    },
    {
      title: "rhel keeps the token its product name resolves to",
      body: 'ID="rhel"\nVERSION_ID="9.4"\nREDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux"\n',
      distroId: "redhat-9.4",
      distroName: "rhel",
    },
    {
      title: "a VERSION_CODENAME wins over a product name",
      body: 'ID="sles"\nVERSION_ID="15.5"\nVERSION_CODENAME="Foo"\nREDHAT_SUPPORT_PRODUCT="Red Hat Enterprise Linux"\n',
      distroId: "sles-15.5",
      distroName: "foo",
    },
    {
      title: "the ubuntu alias wins over a VERSION_CODENAME that disagrees",
      body: 'ID=ubuntu\nVERSION_ID="24.04"\nVERSION_CODENAME=other\n',
      distroId: "ubuntu-24.04",
      distroName: "noble",
    },
    {
      title: "a rolling release without VERSION_ID has a bare distro id",
      body: "ID=debian\nVERSION_CODENAME=trixie\n",
      distroId: "debian",
      distroName: "trixie",
    },
  ];
  for (const testCase of cases) {
    it(testCase.title, () => {
      _resetOsReleaseCache();
      const root = osReleaseRoot(testCase.body);
      try {
        const info = getDistroInfo(root);
        assert.strictEqual(info.distroId, testCase.distroId);
        assert.strictEqual(info.distroName, testCase.distroName);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe("canonicalDistroQualifier()", () => {
  const cases = [
    ["azurelinux-3.0", "azure-linux-3.0"],
    ["cbl-mariner-2.0", "azure-linux-2.0"],
    ["mariner-2.0", "azure-linux-2.0"],
    ["rhel-9.8", "redhat-9.8"],
    ["ol-9.8", "oracle-9.8"],
    ["oracle-9.8", "oracle-9.8"],
    ["amzn-2023", "amazon-2023"],
    ["amazon-2023", "amazon-2023"],
    // SUSE is deliberately excluded: these values carry the release channel
    ["opensuse-leap-15.6", "opensuse-leap-15.6"],
    ["opensuse-tumbleweed-20260806", "opensuse-tumbleweed-20260806"],
    ["sles-15.6", "sles-15.6"],
    ["alpine-3.20", "alpine-3.20"],
    ["ubuntu-22.04", "ubuntu-22.04"],
  ];
  for (const [input, expected] of cases) {
    it(`${input} -> ${expected}`, () => {
      assert.strictEqual(canonicalDistroQualifier(input), expected);
    });
  }

  it("passes through empty and undefined values", () => {
    assert.strictEqual(canonicalDistroQualifier(""), "");
    assert.strictEqual(canonicalDistroQualifier(undefined), undefined);
  });

  it("does not rewrite a vendor that only contains an alias key as a substring", () => {
    assert.strictEqual(
      canonicalDistroQualifier("marinerish-1.0"),
      "marinerish-1.0",
    );
    assert.strictEqual(
      canonicalDistroQualifier("azurelinuxish-1"),
      "azurelinuxish-1",
    );
  });
});

describe("isCleanDistroQualifier()", () => {
  it("accepts the values real releases produce", () => {
    for (const qualifier of [
      "alpine-3.20.0",
      "alpine-3.25.0_alpha20260601",
      "opensuse-tumbleweed-20260806",
      "arch-20261018.0.612668",
      "azure-linux-3.0",
      "ubuntu-22.04",
      "jammy",
    ]) {
      assert.ok(isCleanDistroQualifier(qualifier), qualifier);
    }
  });

  it("rejects empty values and characters outside the purl qualifier charset", () => {
    assert.ok(!isCleanDistroQualifier(""));
    assert.ok(!isCleanDistroQualifier(undefined));
    assert.ok(
      !isCleanDistroQualifier("amazon-2023.12.20260727+(Amazon Linux)"),
    );
    assert.ok(!isCleanDistroQualifier("alpine 3.20"));
  });

  it("rejects a value longer than any release is named", () => {
    // os-release belongs to the scanned image, and the qualifier is stamped on
    // the purl of every OS package: an unbounded value would be multiplied by
    // the package count.
    assert.ok(isCleanDistroQualifier(`alpine-${"1".repeat(121)}`));
    assert.ok(!isCleanDistroQualifier(`alpine-${"1".repeat(122)}`));
    assert.ok(!isCleanDistroQualifier(`alpine-3.${"1".repeat(40000)}`));
  });
});

describe("OS_DISTRO_ALIAS", () => {
  // Debian's os-release only carries the major version, but trivy stamps the
  // distro qualifier from /etc/debian_version (e.g. "debian-12.6"), so every
  // shipped point release needs its own key.
  it("covers every shipped bookworm and trixie point release", () => {
    for (let minor = 1; minor <= 15; minor++) {
      // 12.3 was withdrawn before release; 12.4 shipped the next day
      if (minor === 3) {
        continue;
      }
      assert.strictEqual(OS_DISTRO_ALIAS[`debian-12.${minor}`], "bookworm");
    }
    for (let minor = 1; minor <= 7; minor++) {
      assert.strictEqual(OS_DISTRO_ALIAS[`debian-13.${minor}`], "trixie");
    }
  });

  it("maps the 26.x ubuntu releases", () => {
    assert.strictEqual(OS_DISTRO_ALIAS["ubuntu-26.04"], "resolute");
    assert.strictEqual(OS_DISTRO_ALIAS["ubuntu-26.10"], "stonking");
  });
});

describe("OS_NAMESPACE_ALIAS", () => {
  it("maps every azure linux spelling to azure-linux", () => {
    assert.strictEqual(OS_NAMESPACE_ALIAS.azurelinux, "azure-linux");
    assert.strictEqual(OS_NAMESPACE_ALIAS["cbl-mariner"], "azure-linux");
    assert.strictEqual(OS_NAMESPACE_ALIAS.mariner, "azure-linux");
  });

  it("keeps the historical aliases", () => {
    assert.strictEqual(OS_NAMESPACE_ALIAS.rhel, "redhat");
    assert.strictEqual(OS_NAMESPACE_ALIAS.ol, "oracle");
    // "amazon" is what the vulnerability feeds publish; "amazonlinux" matched
    // neither them nor trivy
    assert.strictEqual(OS_NAMESPACE_ALIAS.amzn, "amazon");
    assert.strictEqual(OS_NAMESPACE_ALIAS.amazonlinux, "amazon");
    assert.strictEqual(OS_NAMESPACE_ALIAS["opensuse-leap"], "opensuse");
    assert.strictEqual(OS_NAMESPACE_ALIAS["opensuse-tumbleweed"], "opensuse");
    assert.strictEqual(OS_NAMESPACE_ALIAS.alma, "almalinux");
    assert.strictEqual(OS_NAMESPACE_ALIAS["rocky-linux"], "rocky");
  });
});
