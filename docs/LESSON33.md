# Lesson 33 - Beyond the mainstream: SBOMs for Julia, R, Erlang, and friends

Most SBOM conversations revolve around the same handful of ecosystems. Node,
Python, Java, and Go are well served by every generator, which is exactly why
they tell you little about how a tool behaves once you leave the paved road.
This lesson walks through a set of ecosystems that arrived in cdxgen recently:
Julia, R with renv, Erlang with rebar3, OCaml with opam, Crystal with shards,
Nim with nimble, Lua with LuaRocks, Perl with Carton, Haskell with Stack, Spack
environments, and Terraform provider locks.

They make good study material for one reason: each one forces you to think
about what a lock file actually promises. Some carry a full dependency graph,
some carry only a flat closure, and some carry integrity hashes that do and do
not belong in the CycloneDX hashes array. Reading the differences will make
you better at judging SBOMs in any language.

## Goal

Pre-requisites: Node.js 24 or newer and `@cdxgen/cdxgen` installed globally.
No Julia, R, or Erlang toolchain is needed. Every parser in this lesson works
offline from the lock files alone, which is deliberate: a lock file that needs
a compiler to be read is a lock file CI cannot trust.

By the end of this lesson you should be able to:

1. Generate a BOM for each of the new ecosystems and find the right project
   type alias for it.
2. Predict which ecosystems give you a real dependency graph and which give
   you a flat closure, and explain why that distinction matters for
   vulnerability reachability.
3. Say where each ecosystem's integrity data lands: the `hashes` array, a
   custom property, or nowhere at all.
4. Read provider pins from a Terraform lock and know why their purls look
   generic.

## Step 1: Three lock files, three promises

Create three small projects or use any you already have: a Julia project with
`Project.toml` and `Manifest.toml`, an R project with `renv.lock`, and an
Erlang project with `rebar.lock`. Then run:

```shell
cdxgen -t julia -o julia-bom.json julia-project
cdxgen -t r -o r-bom.json r-project
cdxgen -t rebar3 -o erlang-bom.json erlang-project
```

Open each BOM and look at the `dependencies` array. The Julia manifest records
which packages each package depends on, so the BOM carries a real graph: the
root links only to the packages named in `Project.toml`, and everything else
hangs off its actual parent. Julia packages are identified with
`pkg:julia/JSON@0.21.4?uuid=...` purls because the Julia type requires the
package UUID, and that UUID is precisely what makes two same-named packages
from different registries distinguishable.

The renv lock sits in between. It lists every package in the project library
with exact versions, and each entry carries a Requirements list naming the
packages it was resolved against, so cdxgen rebuilds real edges between
packages. One requirement never becomes an edge: the R runtime itself, which
renv writes as `R (>= 3.6)` and which the lock pins separately under its own
version. Compare that with a rebar lock, which is a flat closure with one
pleasant exception. Hex publishes SHA-256 digests of every package tarball,
and rebar writes them into the lock, so those digests go straight into the
CycloneDX `hashes` array where scanners can use them.

Contrast that with the renv hash. It covers the package DESCRIPTION file, not
the artifact bytes, so it is recorded as a `cdx:renv:hash` property instead.
Two hashes, two purposes, two places. The `hashes` array is for content
integrity and nothing else.

## Step 2: Closures, pins, and standard libraries

The opam, shards, and Carton parsers all produce closure-level BOMs: every
resolved package with a version, all linked to the root. Carton snapshots add
one more layer. Each distribution in `cpanfile.snapshot` lists what it
provides and what it requires, so cdxgen can wire requirements to the
distributions that provide them and reconstruct a dependency graph the file
only implies. Distributions are identified with `pkg:cpan/<author>/<name>`
purls because the cpan type requires the PAUSE author id as a namespace, and
the author id is sitting right there in the archive pathname.

Standard libraries deserve attention too. Julia's manifest pins registry
packages with versions but lists standard libraries like `Dates` without one,
because they ship with the language. Those components are marked
`cdx:julia:stdlib=true` so a consumer can filter language runtime pieces out
of a vulnerability report rather than wondering why `Dates` has no version.
The Spack parser makes the opposite kind of distinction: it keeps the DAG
hash as a property, and in each component's bom-ref, because that hash is what
tells two builds of one version apart when they differ only in variants or
compiler. It is an identity, not a digest of any downloadable bytes.

Stack draws a boundary of its own. `stack.yaml.lock` completes only the
`extra-deps` a project declares; everything taken from the snapshot is already
pinned by the snapshot's own url and digest, so those packages are not listed
at all. The parser records the snapshot on the parent component and marks each
locked entry `cdx:stack:dependency=extra-dep`, which is the honest reading of
that file: it is not the project's full package set.

## Step 3: Terraform providers and friends without a purl type

Infrastructure code has lock files too. `terraform init` writes
`.terraform.lock.hcl` with one block per provider: the exact version, the
constraint that produced it, and a list of digests. Try it:

```shell
cdxgen -t terraform -o tf-bom.json terraform-project
```

Provider addresses such as `registry.terraform.io/hashicorp/aws` become
`pkg:generic/registry.terraform.io/hashicorp/aws@5.80.0` purls with a
`cdx:purl:proposedType=terraform-provider` property. No Terraform purl type
is registered in the package-url spec, and cdxgen does not squat on one that
vulnerability databases would not recognise. This is the same convention the
nix, zig, and gleam parsers established earlier, and crystal, nim, spack, and
xmake follow it now as well.

The digests are worth a closer look, because the two schemes in that list do
not mean the same thing. A `zh:` entry is a SHA-256 of a published provider
zip, so it is a checksum a consumer can actually verify an artifact against,
and it goes into `hashes[]`. An `h1:` entry hashes the _contents_ of the
package rather than the archive, which is what lets Terraform verify an
unpacked directory — and what makes it useless as an artifact checksum. Decode
it and label it SHA-256 and you have handed the consumer a digest that will
never match the file they downloaded. It is kept as `cdx:tf:h1` instead.

Modules complete the picture, and they are deliberately not in the lock
file — Terraform only locks providers. Module identity comes from the `source`
argument: registry shorthand becomes
`pkg:generic/<host>/<namespace>/<name>/<system>@<version>` (the whole address
is the purl path, with `cdx:purl:proposedType=terraform-module`), git and
mercurial sources reuse the `.gitmodules` convention (`pkg:github` for GitHub,
otherwise `pkg:generic` with a sanitized `vcs_url`), and archive URLs become
generic purls with a `download_url` qualifier. When `terraform init` has run,
`.terraform/modules/modules.json` supplies the resolved versions and the
installed commits, and each module package's `LICENSE` file resolves the
license offline; without it, the `module` blocks in the `*.tf` files still
declare the graph, marked `installed=false`. The BOM then carries the edges
the lock file cannot express: every module to the providers its own files
require, and the root to everything else. With `FETCH_LICENSE`, components
that have no license file are looked up in the OpenTofu registry docs API and
then the GitHub license API; GitHub answers for the default branch, so treat a
`cdx:tf:licenseSource=github` license as a hint about the pinned tag, not a
statement of it.

Two small footnotes. A Gradle version catalog (`gradle/libs.versions.toml`) is
only consulted when Gradle itself produced no dependency information, and the
resulting components carry `cdx:gradle:catalog=true` so nobody mistakes a
declared catalog for a resolved graph. And on the vcpkg side, the manifest's
`builtin-baseline` is now recorded as `cdx:vcpkg:baseline` on the parent
component, which names the port set the declaration resolves against even
though the manifest carries no versions.

## Step 4: what to expect in the output

A short checklist you can apply to any BOM from this lesson. Packages should
carry a purl of the correct type, or a generic purl plus a proposedType
property. Content digests belong in `hashes`, provenance markers belong in
properties, and neither belongs in a component description. Direct versus
transitive should appear as a property when the lock supports the
distinction, and should be absent rather than guessed when it does not.
Every component carries an `internal:SrcFile` property naming the file it
was parsed from, which is your fastest route back to the source of any
surprise.

## Recap

A lock file is a contract, and each ecosystem writes a different one. Julia,
renv, and Spack sell you a graph, opam and rebar sell you a flat closure,
Stack sells you its extra-deps and nothing else, and Terraform sells you
provider pins with registry addresses but no purl type to put them in. cdxgen now reads all of
them offline, with no toolchain required, and keeps each kind of promise in
the CycloneDX field built for it. The next time a generator hands you a BOM
for an unfamiliar language, ask which promises the lock file actually made.
The answer tells you how far to trust the graph.
