import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, it } from "poku";

import {
  condaAttributedKeys,
  condaChannelAndSubdir,
  condaPurl,
  dropEnvYmlCondaDuplicates,
  parseCondaArtifactFilename,
  parseCondaMetaRecords,
  parseEnvironmentYmlFile,
  parsePixiLockFile,
  readDistInfoInstaller,
} from "./parsers-python.js";

const PIXI_V1_LOCK = "./test/data/pixi-workspace-repotest/pixi.lock";
const PIXI_V6_LOCK = "./test/data/pixi-lock-v6/pixi.lock";
const PIXI_V7_LOCK = "./test/data/pixi-lock-v7/pixi.lock";
const CONDA_META_DIR = "./test/data/conda-env-demo/conda-meta";
const ENVIRONMENT_YML = "./test/data/environment-docs-example.yml";

it("parses conda artifact filenames with hyphenated names and cpython builds", () => {
  // Every filename is a real conda-forge artifact name.
  assert.deepStrictEqual(
    parseCondaArtifactFilename("python-3.12.7-h9e4cc4f_0_cpython.conda"),
    {
      name: "python",
      version: "3.12.7",
      build: "h9e4cc4f_0_cpython",
      type: "conda",
    },
  );
  assert.deepStrictEqual(
    parseCondaArtifactFilename("python-flatbuffers-1.0-py312_0.conda"),
    {
      name: "python-flatbuffers",
      version: "1.0",
      build: "py312_0",
      type: "conda",
    },
  );
  assert.deepStrictEqual(
    parseCondaArtifactFilename("ca-certificates-2026.10.23-hbd8a1cb_0.conda"),
    {
      name: "ca-certificates",
      version: "2026.10.23",
      build: "hbd8a1cb_0",
      type: "conda",
    },
  );
  assert.deepStrictEqual(
    parseCondaArtifactFilename("python_abi-3.15-9_cp315.conda"),
    { name: "python_abi", version: "3.15", build: "9_cp315", type: "conda" },
  );
  assert.deepStrictEqual(
    parseCondaArtifactFilename("zlib-1.3.2-h25fd6f3_3.tar.bz2"),
    { name: "zlib", version: "1.3.2", build: "h25fd6f3_3", type: "tar.bz2" },
  );
  // A noarch package and a version that keeps a letter after its digits.
  assert.deepStrictEqual(
    parseCondaArtifactFilename("packaging-26.3-pyhc364b38_0.conda"),
    {
      name: "packaging",
      version: "26.3",
      build: "pyhc364b38_0",
      type: "conda",
    },
  );
  assert.deepStrictEqual(
    parseCondaArtifactFilename("tzdata-2026e-h5d301ff_0.conda"),
    { name: "tzdata", version: "2026e", build: "h5d301ff_0", type: "conda" },
  );
  // A name that never reaches a digit after a hyphen is not an artifact.
  assert.strictEqual(parseCondaArtifactFilename("not-a-filename"), undefined);
  assert.strictEqual(parseCondaArtifactFilename(""), undefined);
  assert.strictEqual(parseCondaArtifactFilename(undefined), undefined);
});

it("derives the channel name and subdir from a repository url", () => {
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://conda.anaconda.org/conda-forge/osx-arm64/numpy-2.5.4-py315h39cfc7d_0.conda",
    ),
    { channel: "conda-forge", subdir: "osx-arm64" },
  );
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://conda.anaconda.org/conda-forge/noarch/tzdata-2026e-h5d301ff_0.conda",
    ),
    { channel: "conda-forge", subdir: "noarch" },
  );
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://repo.anaconda.com/pkgs/main/linux-64/python-3.12.0-h2628c8c_0_cpython.conda",
    ),
    { channel: "main", subdir: "linux-64" },
  );
  // The access token of a private channel never reaches the qualifiers.
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://conda.anaconda.org/t/tok123/conda-forge/linux-64/alsa-lib-1.2.11-h31becfc_1.conda",
    ),
    { channel: "conda-forge", subdir: "linux-64" },
  );
  // A subdir the known list does not hold is still a subdir: the NVIDIA
  // channel serves linux-cos7-64.
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://conda.anaconda.org/nvidia/linux-cos7-64/gcc-14.2.0-h77fa8b48_7.conda",
    ),
    { channel: "nvidia", subdir: "linux-cos7-64" },
  );
  // A url whose only segment carries no digit is a channel without a
  // subdir, and a file path carries neither field.
  assert.deepStrictEqual(
    condaChannelAndSubdir(
      "https://conda.anaconda.org/conda-forge/numpy-2.5.4-py_0.conda",
    ),
    { channel: "conda-forge", subdir: undefined },
  );
  assert.deepStrictEqual(
    condaChannelAndSubdir("./pkgs/numpy-2.5.4-py_0.conda"),
    {
      channel: undefined,
      subdir: undefined,
    },
  );
});

it("builds conda purls with the qualifiers of the purl-spec definition", () => {
  assert.strictEqual(
    condaPurl({
      name: "absl-py",
      version: "0.4.1",
      build: "py36h06a4308_0",
      channel: "main",
      subdir: "linux-64",
      type: "tar.bz2",
    }),
    "pkg:conda/absl-py@0.4.1?build=py36h06a4308_0&channel=main&subdir=linux-64&type=tar.bz2",
  );
  // The pixi-sbom expectation for the same rule.
  assert.strictEqual(
    condaPurl({
      name: "zlib",
      version: "1.3.2",
      build: "h25fd6f3_3",
      channel: "conda-forge",
      subdir: "linux-64",
      type: "conda",
    }),
    "pkg:conda/zlib@1.3.2?build=h25fd6f3_3&channel=conda-forge&subdir=linux-64&type=conda",
  );
  // The version is optional, and so is every qualifier.
  assert.strictEqual(condaPurl({ name: "numpy" }), "pkg:conda/numpy");
  assert.strictEqual(
    condaPurl({ name: "numpy", channel: "conda-forge" }),
    "pkg:conda/numpy?channel=conda-forge",
  );
});

it("parses a pixi.lock version 7 into conda and pypi components", () => {
  const { pkgList, dependenciesList } = parsePixiLockFile(
    PIXI_V7_LOCK,
    "./test/data/pixi-lock-v7",
  );
  const byPurl = Object.fromEntries(
    pkgList.filter((p) => p.purl).map((p) => [p.purl, p]),
  );
  // A v7 conda record carries no name, version or build of its own; all
  // three come from the artifact url.
  assert.ok(
    byPurl[
      "pkg:conda/numpy@2.5.4?build=py315h39cfc7d_0&channel=conda-forge&subdir=osx-arm64&type=conda"
    ],
  );
  assert.ok(
    byPurl[
      "pkg:conda/python@3.15.2?build=h2e4dbab_100_cp315&channel=conda-forge&subdir=osx-arm64&type=conda"
    ],
  );
  assert.ok(
    byPurl[
      "pkg:conda/ca-certificates@2026.10.23?build=hbd8a1cb_0&channel=conda-forge&subdir=noarch&type=conda"
    ],
  );
  // The pypi entries of the same lock keep their pkg:pypi purls.
  assert.ok(byPurl["pkg:pypi/requests@2.34.2"]);
  assert.ok(byPurl["pkg:pypi/charset-normalizer@3.5.2"]);
  const numpy =
    byPurl[
      "pkg:conda/numpy@2.5.4?build=py315h39cfc7d_0&channel=conda-forge&subdir=osx-arm64&type=conda"
    ];
  assert.deepStrictEqual(numpy.hashes, [
    {
      alg: "SHA-256",
      content:
        "43db9a7bbd3fa594a97938e9cc403677dae3fde96a84d873803020f4a7c49f7c",
    },
    { alg: "MD5", content: "4ad37db97303242c1cdf6f271c8b7df5" },
  ]);
  assert.deepStrictEqual(numpy.licenses, [{ expression: "BSD-3-Clause" }]);
  // The lock's own purls field holds PyPI mapping purls and is never copied.
  assert.ok(
    pkgList.every((p) => !p.purl?.includes("source=compressed-mapping")),
  );
  // The dependency graph follows depends, resolved by conda package name.
  const numpyDependencies = dependenciesList.find((d) =>
    d.ref.startsWith("pkg:conda/numpy@"),
  );
  assert.ok(numpyDependencies);
  assert.ok(
    numpyDependencies.dependsOn.some((ref) =>
      ref.startsWith("pkg:conda/python@"),
    ),
  );
});

it("parses a pixi.lock version 6 whose records are keyed by location", () => {
  const { pkgList, dependenciesList } = parsePixiLockFile(
    PIXI_V6_LOCK,
    "./test/data/pixi-lock-v6",
  );
  const purls = pkgList.filter((p) => p.purl).map((p) => p.purl);
  // Both environments of the lock are selected, so the tar.bz2 artifact of
  // the second one is present with its own type qualifier.
  assert.ok(
    purls.includes(
      "pkg:conda/python-flatbuffers@1.0?build=py312_0&channel=conda-forge&subdir=linux-64&type=conda",
    ),
  );
  assert.ok(
    purls.includes(
      "pkg:conda/zlib@1.3.2?build=h25fd6f3_3&channel=conda-forge&subdir=linux-64&type=tar.bz2",
    ),
  );
  assert.ok(
    purls.includes(
      "pkg:conda/packaging@24.2?build=pyh99b14a1_1&channel=conda-forge&subdir=noarch&type=conda",
    ),
  );
  assert.ok(purls.includes("pkg:pypi/requests@2.32.3"));
  // A record no environment references, and a source record the lock spells
  // no name for, produce no component.
  assert.strictEqual(pkgList.length, 4);
  assert.ok(purls.every((purl) => !purl.includes("ca-certificates")));
  // A depends entry the lock holds no record for is dropped, not invented.
  const flatbuffers = dependenciesList.find((d) =>
    d.ref.includes("python-flatbuffers"),
  );
  assert.deepStrictEqual(flatbuffers, {
    ref: "pkg:conda/python-flatbuffers@1.0?build=py312_0&channel=conda-forge&subdir=linux-64&type=conda",
    dependsOn: [],
  });
});

it("keeps the flat package records of the oldest pixi.lock working", () => {
  const { pkgList } = parsePixiLockFile(
    PIXI_V1_LOCK,
    "./test/data/pixi-workspace-repotest",
  );
  assert.deepStrictEqual(pkgList, [
    {
      name: "python",
      version: "3.12.7",
      type: "library",
      evidence: {
        identity: {
          field: "purl",
          confidence: 1,
          methods: [
            {
              technique: "instrumentation",
              confidence: 1,
              value: "./test/data/pixi-workspace-repotest/.pixi/envs/default",
            },
          ],
        },
      },
      distribution: {
        url: "https://conda.anaconda.org/conda-forge/linux-64/python-3.12.7-h9e4cc4f_0_cpython.conda",
      },
      hashes: [
        {
          alg: "SHA-256",
          content:
            "130782395f0ec68fd4c6aa0a9756fbb79344f9d6869fc0c544b61343f74f65f6",
        },
        { alg: "MD5", content: "2e6af3d2cd1746aa0bb4f9919cb0ed5f" },
      ],
      properties: [
        { name: "cdx:pixi:operating_system", value: "linux-64" },
        { name: "cdx:pixi:build_number", value: "0" },
        { name: "cdx:pixi:build", value: "h9e4cc4f_0_cpython" },
      ],
      purl: "pkg:conda/python@3.12.7?build=h9e4cc4f_0_cpython&channel=conda-forge&subdir=linux-64&type=conda",
      "bom-ref":
        "pkg:conda/python@3.12.7?build=h9e4cc4f_0_cpython&channel=conda-forge&subdir=linux-64&type=conda",
    },
  ]);
});

it("parses conda-meta records into conda components with hashes and licenses", () => {
  const { pkgList, dependenciesList, envKeys } = parseCondaMetaRecords([
    join(CONDA_META_DIR, "numpy-2.5.4-py312hff34920_0.json"),
    join(CONDA_META_DIR, "python-3.12.16-hd05a0c4_0_cpython.json"),
    join(CONDA_META_DIR, "tzdata-2026e-h5d301ff_0.json"),
    join(CONDA_META_DIR, "wheel-0.48.0-pyhd8ed1ab_0.json"),
    join(CONDA_META_DIR, "biopython-1.83-py312ha1d0cf0_0.json"),
  ]);
  const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));
  // The numpy record is a real micromamba PrefixRecord of this environment.
  assert.strictEqual(
    byName.numpy.purl,
    "pkg:conda/numpy@2.5.4?build=py312hff34920_0&channel=conda-forge&subdir=osx-arm64&type=conda",
  );
  assert.deepStrictEqual(byName.numpy.hashes, [
    {
      alg: "SHA-256",
      content:
        "7a72f5345e7e9f2ed8385986de8d96e321301726dfd6c1a7d0a0d2106ccf204b",
    },
  ]);
  assert.deepStrictEqual(byName.numpy.licenses, [
    { expression: "BSD-3-Clause" },
  ]);
  assert.strictEqual(
    byName.tzdata.purl,
    "pkg:conda/tzdata@2026e?build=h5d301ff_0&channel=conda-forge&subdir=noarch&type=conda",
  );
  // A record whose channel field is a url holds the canonical name only.
  assert.strictEqual(
    byName.biopython.purl,
    "pkg:conda/biopython@1.83?build=py312ha1d0cf0_0&channel=bioconda&subdir=osx-arm64&type=conda",
  );
  // The depends lists feed the graph, and the records key their environment.
  const numpyDependencies = dependenciesList.find((d) =>
    d.ref.startsWith("pkg:conda/numpy@"),
  );
  assert.ok(
    numpyDependencies.dependsOn.some((ref) =>
      ref.startsWith("pkg:conda/python@"),
    ),
  );
  assert.strictEqual(envKeys.size, 1);
  assert.ok(
    [...envKeys.values()][0].has("numpy@2.5.4"),
    "the records key their own environment",
  );
});

it("attributes site-packages distributions to their conda records by INSTALLER", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-conda-installer-"));
  const sitePackages = join(
    tempDir,
    "env",
    "lib",
    "python3.12",
    "site-packages",
  );
  const dists = [
    {
      dir: "numpy-2.5.4.dist-info",
      name: "numpy",
      version: "2.5.4",
      installer: "conda",
    },
    {
      dir: "flask-3.1.3.dist-info",
      name: "flask",
      version: "3.1.3",
      installer: "pip",
    },
    {
      dir: "wheel-0.48.0.dist-info",
      name: "wheel",
      version: "0.48.0",
      installer: undefined,
    },
    {
      dir: join("setuptools", "_vendor", "wheel-0.46.3.dist-info"),
      name: "wheel",
      version: "0.46.3",
      installer: "conda",
    },
  ];
  const outsideDir = join(
    tempDir,
    "other",
    "lib",
    "python3.12",
    "site-packages",
    "numpy-2.5.4.dist-info",
  );
  const metadataFiles = [];
  const installedLists = [];
  try {
    for (const dist of dists) {
      const distInfo = join(sitePackages, dist.dir);
      mkdirSync(distInfo, { recursive: true });
      writeFileSync(
        join(distInfo, "METADATA"),
        `Metadata-Version: 2.1\nName: ${dist.name}\nVersion: ${dist.version}\n`,
      );
      if (dist.installer !== undefined) {
        writeFileSync(join(distInfo, "INSTALLER"), `${dist.installer}\n`);
      }
      metadataFiles.push(join(distInfo, "METADATA"));
      installedLists.push([{ name: dist.name, version: dist.version }]);
    }
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(
      join(outsideDir, "METADATA"),
      "Metadata-Version: 2.1\nName: numpy\nVersion: 2.5.4\n",
    );
    writeFileSync(join(outsideDir, "INSTALLER"), "conda\n");
    metadataFiles.push(join(outsideDir, "METADATA"));
    installedLists.push([{ name: "numpy", version: "2.5.4" }]);

    // The environment holds conda records for numpy, flask and wheel 0.48.0
    // only; the vendored wheel 0.46.3 belongs to no record even though its
    // INSTALLER was written at conda-build time.
    const envKeys = new Map([
      [
        join(tempDir, "env"),
        new Set(["numpy@2.5.4", "flask@3.1.3", "wheel@0.48.0"]),
      ],
    ]);
    const claimed = condaAttributedKeys(metadataFiles, installedLists, envKeys);
    assert.ok(claimed.has("numpy@2.5.4"), "conda INSTALLER claims its record");
    assert.ok(!claimed.has("flask@3.1.3"), "a pip INSTALLER survives as pypi");
    assert.ok(
      claimed.has("wheel@0.48.0"),
      "a missing INSTALLER with a matching record is the conda artifact",
    );
    assert.ok(
      !claimed.has("wheel@0.46.3"),
      "a conda INSTALLER without a record stays pypi",
    );
    // The numpy dist-info outside the environment prefix is a different
    // installation and stays pypi whatever its INSTALLER says.
    assert.strictEqual(claimed.size, 2);

    // Without conda records nothing is claimed, so plain python and venv
    // scans keep every installed distribution.
    assert.strictEqual(
      condaAttributedKeys(metadataFiles, installedLists, new Map()).size,
      0,
    );
    assert.strictEqual(readDistInfoInstaller(sitePackages), undefined);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("parses environment.yml conda dependencies and the nested pip list", async () => {
  const { pkgList } = await parseEnvironmentYmlFile(ENVIRONMENT_YML);
  const byName = Object.fromEntries(pkgList.map((p) => [p.name, p]));
  // The single channels entry feeds the channel qualifier.
  assert.strictEqual(
    byName.python.purl,
    "pkg:conda/python@3.9?channel=conda-forge",
  );
  // A channel-prefixed wildcard dep keeps its own channel, omits the version
  // and records the whole spec.
  assert.strictEqual(byName.numpy.purl, "pkg:conda/numpy?channel=conda-forge");
  assert.strictEqual(byName.numpy.version, undefined);
  assert.ok(
    byName.numpy.properties.some(
      (property) =>
        property.name === "cdx:conda:spec" &&
        property.value === "conda-forge::numpy=1.21.*",
    ),
  );
  // A range is not a pin either.
  assert.ok(
    byName.scipy.properties.some(
      (property) =>
        property.name === "cdx:conda:spec" &&
        property.value === "scipy>=1.7,<1.10",
    ),
  );
  // `==` pins exactly like `=`, and a version=build spec sets the qualifier.
  assert.strictEqual(
    byName.pandas.purl,
    "pkg:conda/pandas@1.4.4?channel=conda-forge",
  );
  assert.strictEqual(
    byName.zlib.purl,
    "pkg:conda/zlib@1.3.1?build=hcb275e0_0&channel=conda-forge",
  );
  // pip as a conda dependency is the conda package pip.
  assert.strictEqual(byName.pip.purl, "pkg:conda/pip?channel=conda-forge");
  // The nested pip list keeps the requirements rules; its url, editable and
  // path entries are skipped rather than given invented names.
  const pipComponents = pkgList.filter(
    (p) => p.name === "Flask-Testing" || p.name === "django",
  );
  assert.strictEqual(pipComponents.length, 2);
  assert.strictEqual(pkgList.length, 8);
});

it("reads the INSTALLER of a dist-info directory", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "cdxgen-conda-read-"));
  try {
    const distInfo = join(tempDir, "flask-3.1.3.dist-info");
    mkdirSync(distInfo, { recursive: true });
    assert.strictEqual(readDistInfoInstaller(distInfo), undefined);
    writeFileSync(join(distInfo, "INSTALLER"), "uv-pixi\n");
    assert.strictEqual(readDistInfoInstaller(distInfo), "uv-pixi");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

it("does not advertise a licence named None from a pixi.lock record", () => {
  // pixi.lock v5 files stringify an absent license as the literal "None";
  // a licence object named None must not reach the component.
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-pixi-none-"));
  try {
    const lockFile = join(workDir, "pixi.lock");
    writeFileSync(
      lockFile,
      [
        "version: 6",
        "environments:",
        "  default:",
        "    packages:",
        "      linux-64:",
        "      - conda: https://conda.anaconda.org/conda-forge/linux-64/libgcc-ng-14.2.0-h7748a38_0.conda",
        "packages:",
        "- conda: https://conda.anaconda.org/conda-forge/linux-64/libgcc-ng-14.2.0-h7748a38_0.conda",
        "  sha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "  license: 'None'",
      ].join("\n"),
    );
    const { pkgList } = parsePixiLockFile(lockFile, workDir);
    assert.strictEqual(pkgList.length, 1);
    assert.strictEqual(pkgList[0].licenses, undefined);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("skips bare path entries in an environment file pip list", async () => {
  // A wheel path without a ./ prefix carries a separator and no scheme, and
  // the requirements parser would invent a component named after its first
  // directory.
  const workDir = mkdtempSync(join(tmpdir(), "cdxgen-envyml-path-"));
  try {
    const envFile = join(workDir, "environment.yml");
    writeFileSync(
      envFile,
      [
        "name: pathdemo",
        "dependencies:",
        "  - pip",
        "  - pip:",
        "      - flask",
        "      - dist/local-wheel-1.0-py3-none-any.whl",
      ].join("\n"),
    );
    const { pkgList } = await parseEnvironmentYmlFile(envFile);
    // A versionless requirement keeps no purl, so the pip list is identified
    // by what survived next to the conda pip package.
    assert.deepStrictEqual(
      pkgList.filter((p) => p.name !== "pip").map((p) => p.name),
      ["flask"],
    );
    assert.ok(pkgList.every((p) => p.name !== "dist"));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

it("drops an environment file declaration shadowed by a conda-meta record", () => {
  // The record carries the build, hashes and license, so it wins over the
  // same name and version declared in environment.yml, whether the
  // declaration pinned the version or not.
  const declared = [
    {
      name: "numpy",
      version: "2.5.4",
      purl: "pkg:conda/numpy@2.5.4?channel=conda-forge",
      properties: [{ name: "internal:SrcFile", value: "/ws/environment.yml" }],
    },
    {
      name: "scipy",
      purl: "pkg:conda/scipy?channel=conda-forge",
      properties: [{ name: "internal:SrcFile", value: "/ws/environment.yml" }],
    },
    {
      name: "flask",
      version: "3.1.3",
      purl: "pkg:pypi/flask@3.1.3",
      properties: [{ name: "internal:SrcFile", value: "/ws/environment.yml" }],
    },
  ];
  const installed = [
    {
      name: "numpy",
      version: "2.5.4",
      purl: "pkg:conda/numpy@2.5.4?build=py312hff34920_0&channel=conda-forge&subdir=osx-arm64&type=conda",
      properties: [
        {
          name: "internal:SrcFile",
          value: "/ws/envs/demo/conda-meta/numpy-2.5.4-py312hff34920_0.json",
        },
      ],
    },
  ];
  const kept = dropEnvYmlCondaDuplicates(declared, installed, [
    "/ws/environment.yml",
  ]);
  assert.deepStrictEqual(kept.map((p) => p.name).sort(), ["flask", "scipy"]);
  // A declared package the environment did not record stays.
  const keptUnrelated = dropEnvYmlCondaDuplicates(
    declared,
    [],
    ["/ws/environment.yml"],
  );
  assert.strictEqual(keptUnrelated.length, 3);
});
