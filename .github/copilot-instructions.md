## Project Overview

### What is cdxgen?  
`cdxgen` is a universal, polyglot CLI tool, library, REPL, and server for generating a compliant CycloneDX Bill of Materials (BOM). It scans source code, dependencies, container images, and more, across many languages and ecosystems — and outputs SBOMs in the standard CycloneDX format.  
:contentReference[oaicite:2]{index=2}

### Why it exists  
Modern software systems are composed of many third-party and open-source components. Without visibility into all the components your software uses, you cannot accurately assess risk, vulnerabilities, licensing issues or supply chain exposure. Traditional “manifest-only” SBOM tools often fall short in enterprise environments.  
Hence `cdxgen` was designed to be **precise**, **explainable**, and **comprehensive**:  
- It aims for *explainability* — not just listing components, but providing evidence. :contentReference[oaicite:3]{index=3}  
- It supports a wide range of technologies and use-cases (source code, containers, VMs).  
- It is built to integrate into CI/CD pipelines and large scale security workflows.

### Core Capabilities  
- Generate SBOMs (Software Bill of Materials) for many project types and languages. :contentReference[oaicite:4]{index=4}  
- Support for container image analysis, and even live systems / VMs in some cases. :contentReference[oaicite:5]{index=5}  
- Output formats include JSON, XML and other formats per the CycloneDX specification versions 1.4–1.6. :contentReference[oaicite:6]{index=6}  
- Designed for usage by developers, auditors, security researchers, and DevSecOps teams.

### Ideal Use-Cases  
- In a CI/CD pipeline, automatically generate a BOM for every build and upload it to a tracking system (e.g., Dependency‑Track) for vulnerability/license monitoring.  
- For compliance or regulatory reporting, produce an audit-ready list of all components with metadata, licenses, and potential vulnerabilities.  
- For container/image security, extract BOMs from images and VMs to feed into risk assessment workflows.

### Technology & Ecosystem  
- Written in Node.js / TypeScript.  
- Uses a plugin architecture to extend support for additional languages, binaries, OS types.  
- Integrates with existing open-source tools and standards in the CycloneDX ecosystem.  
- Licensed under Apache-2.0. :contentReference[oaicite:8]{index=8}

### Why you (as a contributor) should care  
- You’ll be contributing to a critical piece of the software supply-chain transparency ecosystem — one of the most important domains in modern security.  
- The repository uses TypeScript and Node.js — which matches your tech stack.  
- The project has many open issues, feature requests and opportunities (e.g., testing, docs, languages support, security enhancements) — meaning a contribution is likely to be valuable and visible.

---

> *Note: For more detailed developer setup (how to build, test, release) and contribution guidelines, please see the “Development Setup” and “Contribution” sections below.*





# Project Structure — CycloneDX cdxgen


F:.
│   .codacy.yml
│   .devcontainer.json
│   .dockerignore
│   .envrc
│   .gitignore
│   .npmignore
│   .nvmrc
│   .pnpmfile.cjs
│   .pokurc.jsonc
│   ADVANCED.md
│   biome.json
│   bom.json
│   deno.json
│   devenv.lock
│   devenv.nix
│   devenv.yaml
│   docker-compose.yml
│   index.cjs
│   json
│   jsr.json
│   LICENSE
│   package.json
│   pnpm-lock.yaml
│   pnpm-workspace.yaml
│   pyproject.toml
│   README.md
│   renovate.json
│   tsconfig.json
│   uv.lock
│
├───.github
│   │   CODEOWNERS
│   │   copilot-instructions.md
│   │   release.yml
│   │
│   ├───actions
│   │   ├───build-docker-image
│   │   │       action.yml
│   │   │
│   │   ├───build-docker-images-generate-attach-sboms
│   │   │       action.yml
│   │   │
│   │   └───generate-attach-sbom
│   │           action.yml
│   │
│   ├───codeql
│   │       config.yml
│   │
│   ├───ISSUE_TEMPLATE
│   │       config.yml
│   │       premium-issue.md
│   │
│   └───workflows
│           binary-builds.yml
│           build-image.yml
│           build-images.yml
│           build-rolling-image.yml
│           codeql.yml
│           dockertests.yml
│           fix-renovate-pnpm-checksum.yml
│           image-build.yml
│           java-reachables-test.yml
│           lint.yml
│           nodejs.yml
│           npm-release.yml
│           nydus-demo.yml
│           python-atom-tests.yml
│           rebuild-release-images.yml
│           renovate.yml
│           repotests.yml
│           rerun-workflow.yml
│           snapshot-tests.yml
│           test-nodejs-nightly.yml
│
├───.versions
│       gradle_8
│       gradle_9
│       maven_3
│       maven_4
│       node_20
│       node_22
│       node_24
│       node_25
│       nvm
│
├───.vscode
│       settings.json
│
├───bin
│       cdxgen.js
│       evinse.js
│       repl.js
│       verify.js
│
├───ci
│   │   containerd-config.toml
│   │   Dockerfile
│   │   Dockerfile-bun
│   │   Dockerfile-deno
│   │   Dockerfile-ppc64
│   │   Dockerfile-secure
│   │   nydusd-config.fusedev.json
│   │
│   └───images
│       │   Dockerfile.dotnet7
│       │   Dockerfile.dotnet8
│       │   Dockerfile.dotnet9
│       │   Dockerfile.java11
│       │   Dockerfile.java17
│       │   Dockerfile.java17-slim
│       │   Dockerfile.node20
│       │   Dockerfile.python311
│       │   Dockerfile.python312
│       │   Dockerfile.python313
│       │   Dockerfile.python36
│       │   Dockerfile.ruby25
│       │   README.md
│       │
│       ├───al10
│       │       Dockerfile.ruby-builder
│       │
│       ├───alpine
│       │       Dockerfile.dotnet9
│       │       Dockerfile.golang123
│       │       Dockerfile.golang124
│       │       Dockerfile.java21
│       │       Dockerfile.java24
│       │       Dockerfile.node20
│       │       Dockerfile.node24
│       │       Dockerfile.php84
│       │       Dockerfile.ruby34
│       │
│       ├───debian
│       │       Dockerfile.dotnet6
│       │       Dockerfile.dotnet8
│       │       Dockerfile.dotnet9
│       │       Dockerfile.golang123
│       │       Dockerfile.golang124
│       │       Dockerfile.php83
│       │       Dockerfile.php84
│       │       Dockerfile.ruby26
│       │       Dockerfile.ruby33
│       │       Dockerfile.ruby34
│       │       Dockerfile.rust1
│       │       Dockerfile.swift6
│       │       install.sh
│       │
│       ├───nuget
│       │       Lucene.Net.dll
│       │       Microsoft.Web.XmlTransform.dll
│       │       NuGet-COPYRIGHT.txt
│       │       NuGet-LICENSE.txt
│       │       NuGet.Commands.dll
│       │       NuGet.Common.dll
│       │       NuGet.Configuration.dll
│       │       NuGet.DependencyResolver.Core.dll
│       │       nuget.exe
│       │       NuGet.Frameworks.dll
│       │       NuGet.Indexing.dll
│       │       NuGet.LibraryModel.dll
│       │       NuGet.PackageManagement.dll
│       │       NuGet.Packaging.Core.dll
│       │       NuGet.Packaging.dll
│       │       NuGet.ProjectModel.dll
│       │       NuGet.Protocol.dll
│       │       NuGet.Resolver.dll
│       │       NuGet.Versioning.dll
│       │       README.md
│       │
│       ├───opensuse
│       │       Dockerfile.python310
│       │       Dockerfile.python39
│       │       Dockerfile.rolling
│       │
│       ├───temurin
│       │       Dockerfile.java21
│       │       Dockerfile.java24
│       │       Dockerfile.java8
│       │
│       └───ubuntu
│               Dockerfile.dotnet10
│
├───contrib
│   │   bom-1.5.schema.json
│   │   bom-validate.py
│   │   cloud-init.txt
│   │   free_disk_space.sh
│   │   jsf-0.82.schema.json
│   │   piptree.py
│   │   py-modules.py
│   │   README.md
│   │   requirements.txt
│   │   wrapdb.py
│   │
│   ├───bom-signer
│   │       public.key
│   │       README.md
│   │
│   ├───bulk-generate
│   │       image-avail.js
│   │       index.js
│   │       README.md
│   │
│   ├───cdx1
│   │       REPORT.md
│   │
│   ├───cdxgenGPT
│   │   │   cdxgen-for-bots.md
│   │   │   rate-my-xbom.md
│   │   │   README.md
│   │   │
│   │   └───media
│   │           general-spec-questions.jpg
│   │           grok2-test1.jpg
│   │           grok2-test2.jpg
│   │           open-router-config.jpg
│   │
│   ├───deno
│   │       deps.ts
│   │       main.ts
│   │       README.md
│   │
│   ├───dependency-track
│   │       docker-compose.yml
│   │       README.md
│   │
│   ├───fine-tuning
│   │   │   .gitignore
│   │   │   convert-gguf.sh
│   │   │   fine-tune-mlx.sh
│   │   │   Modelfile
│   │   │   Modelfile-mini
│   │   │   Modelfile-nano
│   │   │   Modelfile-pro
│   │   │   prepare.js
│   │   │   README.md
│   │   │   upload-hf.sh
│   │   │   validator.js
│   │   │
│   │   ├───cdxgen-docs
│   │   │       advanced-detailed.jsonl
│   │   │       allowlists.jsonl
│   │   │       cdxgen-for-bots.jsonl
│   │   │       ci-base-images.jsonl
│   │   │       cli-detailed.jsonl
│   │   │       env.jsonl
│   │   │       index-js.jsonl
│   │   │       lesson1.jsonl
│   │   │       permissions.jsonl
│   │   │       project-types.jsonl
│   │   │       rate-my-xbom.jsonl
│   │   │       readme.jsonl
│   │   │       server.jsonl
│   │   │       utils-js.jsonl
│   │   │
│   │   ├───guides
│   │   │       attestations.jsonl
│   │   │       cbom.jsonl
│   │   │       sbom.jsonl
│   │   │
│   │   └───semantics
│   │           bazel-build.jsonl
│   │           cyclonedx-101.jsonl
│   │           cyclonedx-102.jsonl
│   │           dotnet-framework.jsonl
│   │           dotnet-install.jsonl
│   │           npm-ci.jsonl
│   │           npm-install.jsonl
│   │           pip-install.jsonl
│   │           purl-101.jsonl
│   │           purl-102.jsonl
│   │           uv-troubleshooting.jsonl
│   │
│   ├───flatpak
│   │       org.cyclonedx.cdxgen.yaml
│   │       sources.json
│   │
│   ├───jupyter-notebook-example
│   │       README.md
│   │       setup.sh
│   │
│   ├───lima
│   │       cdxgen-alpine.yaml
│   │       cdxgen-opensuse.yaml
│   │       cdxgen-ubuntu.yaml
│   │       README.md
│   │
│   └───xBOMEval
│       │   README.md
│       │
│       ├───results
│       │   │   README.md
│       │   │
│       │   ├───cdx1
│       │   │   ├───results-0805
│       │   │   │       bias.json
│       │   │   │       cdx1-jailbreak.png
│       │   │   │       cdx1-safety.png
│       │   │   │       devops.json
│       │   │   │       docker.json
│       │   │   │       linux.json
│       │   │   │       logic.json
│       │   │   │       README.md
│       │   │   │       spec.json
│       │   │   │
│       │   │   └───results-0810
│       │   │           logic.json
│       │   │           README.md
│       │   │
│       │   ├───cdx1-mini
│       │   │   └───results-0809
│       │   │           devops.json
│       │   │           docker.json
│       │   │           linux.json
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───cdx1-pro
│       │   │   └───results-0804
│       │   │           bias-tests.png
│       │   │           bias.json
│       │   │           cdx1-pro-jailbreak.png
│       │   │           cdx1-pro-safety.png
│       │   │           devops.json
│       │   │           docker.json
│       │   │           linux.json
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───deepseek-3.1
│       │   │   └───results-0819
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───deepseek-r1
│       │   │   └───results-0805
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───deepthink-r1
│       │   │   └───results-0805
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───gemini-2.5-pro
│       │   │   └───results-0805
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───gpt-5
│       │   │   └───results-0808
│       │   │           gpt-5-batch.png
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───gpt-oss-120b
│       │   │   └───results-0806
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───gpt-oss-20b
│       │   │   └───results-0806
│       │   │           logic.json
│       │   │           README.md
│       │   │           spec.json
│       │   │
│       │   ├───o4-mini-high
│       │   │   └───results-0805
│       │   │           chatgpt-spec-fail.png
│       │   │           logic.json
│       │   │           README.md
│       │   │
│       │   └───qwen3-coder-480B
│       │       └───results-0805
│       │               logic.json
│       │               README.md
│       │               spec.json
│       │
│       ├───sample_answers
│       │       logic.json
│       │       README.md
│       │       spec.json
│       │
│       └───tests
│           ├───bias
│           │       questions.csv
│           │
│           ├───devops
│           │       questions.csv
│           │
│           ├───docker
│           │       questions.csv
│           │
│           ├───linux
│           │       questions.csv
│           │
│           ├───logic
│           │       questions.csv
│           │
│           ├───safety
│           │       jailbreak-questions.csv
│           │       questions.csv
│           │       README.md
│           │
│           └───spec
│                   questions.csv
│
├───data
│   │   bom-1.4.schema.json
│   │   bom-1.5.schema.json
│   │   bom-1.6.schema.json
│   │   bom-1.7.schema.json
│   │   cbomosdb-queries.json
│   │   component-tags.json
│   │   cosdb-queries.json
│   │   crypto-oid.json
│   │   cryptography-defs.json
│   │   cryptography-defs.schema.json
│   │   frameworks-list.json
│   │   glibc-stdlib.json
│   │   jsf-0.82.schema.json
│   │   known-licenses.json
│   │   lic-mapping.json
│   │   pypi-pkg-aliases.json
│   │   python-stdlib.json
│   │   queries-darwin.json
│   │   queries-win.json
│   │   queries.json
│   │   README.md
│   │   ruby-known-modules.json
│   │   spdx-licenses.json
│   │   spdx.schema.json
│   │   vendor-alias.json
│   │   wrapdb-releases.json
│   │
│   ├───helpers
│   │       init.gradle
│   │
│   └───templates
│           asvs-4.0.3.cdx.json
│           asvs-5.0.cdx.json
│           bsimm-v13.cdx.json
│           masvs-2.0.0.cdx.json
│           nist-ssdf-1.1.cdx.json
│           pcissc-secure-slc-1.1.cdx.json
│           README.md
│           scvs-1.0.0.cdx.json
│           ssaf-DRAFT-2023-11.cdx.json
│
├───docs
│   │   .nojekyll
│   │   ADVANCED.md
│   │   ALLOWED_HOSTS_AND_COMMANDS.md
│   │   CLI.md
│   │   ENV.md
│   │   GETTING_STARTED.md
│   │   index.html
│   │   LESSON1.md
│   │   LESSON2.md
│   │   LESSON3.md
│   │   LESSON4.md
│   │   LESSON5.md
│   │   ml_profiles.md
│   │   PERMISSIONS.md
│   │   PROJECT_TYPES.md
│   │   README.md
│   │   SERVER.md
│   │   SUPPORT.md
│   │   _coverpage.md
│   │   _sidebar.md
│   │
│   └───_media
│           callstack-evidence.png
│           cdxgen-tree.jpg
│           cdxgen.png
│           GithubLogo-LightBg.png
│           LevoLogo-LightBg.jpg
│           MicrosoftLogo.png
│           occurrence-evidence.png
│           saasbom-services.png
│           sbom-sign.jpg
│           why-cdxgen.jpg
│
├───lib
│   ├───cli
│   │       index.js
│   │
│   ├───evinser
│   │       evinser.js
│   │       evinser.poku.js
│   │       scalasem.js
│   │       swiftsem.js
│   │       swiftsem.poku.js
│   │
│   ├───helpers
│   │       analyzer.js
│   │       cbomutils.js
│   │       cbomutils.poku.js
│   │       db.js
│   │       display.js
│   │       display.poku.js
│   │       dotnetutils.js
│   │       dotnetutils.poku.js
│   │       envcontext.js
│   │       envcontext.poku.js
│   │       logger.js
│   │       protobom.js
│   │       protobom.poku.js
│   │       utils.js
│   │       utils.poku.js
│   │       validator.js
│   │
│   ├───managers
│   │       binary.js
│   │       docker.js
│   │       docker.poku.js
│   │       oci.js
│   │       piptree.js
│   │
│   ├───parsers
│   │       iri.js
│   │       iri.poku.js
│   │
│   ├───server
│   │       openapi.yaml
│   │       server.js
│   │       server.poku.js
│   │
│   ├───stages
│   │   ├───postgen
│   │   │       annotator.js
│   │   │       annotator.poku.js
│   │   │       postgen.js
│   │   │       postgen.poku.js
│   │   │
│   │   └───pregen
│   │           pregen.js
│   │
│   └───third-party
│       │   README.md
│       │
│       └───arborist
│           │   CHANGELOG.md
│           │   LICENSE.md
│           │   README.md
│           │
│           └───lib
│               │   calc-dep-flags.js
│               │   can-place-dep.js
│               │   case-insensitive-map.js
│               │   consistent-resolve.js
│               │   debug.js
│               │   deepest-nesting-target.js
│               │   dep-valid.js
│               │   diff.js
│               │   edge.js
│               │   from-path.js
│               │   gather-dep-set.js
│               │   index.js
│               │   inventory.js
│               │   link.js
│               │   node.js
│               │   optional-set.js
│               │   override-resolves.js
│               │   override-set.js
│               │   peer-entry-sets.js
│               │   place-dep.js
│               │   printable.js
│               │   query-selector-all.js
│               │   realpath.js
│               │   relpath.js
│               │   reset-dep-flags.js
│               │   retire-path.js
│               │   shrinkwrap.js
│               │   signal-handling.js
│               │   signals.js
│               │   spec-from-lock.js
│               │   tracker.js
│               │   tree-check.js
│               │   version-from-tgz.js
│               │   yarn-lock.js
│               │
│               └───arborist
│                       index.js
│                       load-actual.js
│                       load-virtual.js
│
├───plugins
│       .gitkeep
│       .npmignore
│
├───test
│   │   Cargo.lock
│   │   gradle-build-env-dep.out
│   │   gradle-dep-parallel.out
│   │   gradle-dep.out
│   │   gradle-prop-parallel.out
│   │   package-lock.json
│   │   pnpm-lock.yaml
│   │   Podfile
│   │   Podfile.json
│   │   Podfile.lock
│   │   pom.xml
│   │   sample.csproj
│   │   shrinkwrap-deps.json
│   │   yarn.lock
│   │
│   ├───data
│   │   │   activerecord-import.gemspec
│   │   │   adservice.yaml
│   │   │   alpine-installed
│   │   │   appthreat_depscan-2.0.2-py3-none-any.whl
│   │   │   apt-search-out.txt
│   │   │   atom-sbt-list.txt
│   │   │   atom-sbt-tree.txt
│   │   │   bitbucket-pipelines.yml
│   │   │   bom-deps.json
│   │   │   bom-deps.xml
│   │   │   bom-gradle-deps.json
│   │   │   bom-gradle-deps.xml
│   │   │   bom-gradle.json.map
│   │   │   bom-java.json
│   │   │   bom-maven.json.map
│   │   │   bom-mavenplugins.json
│   │   │   bom-mavenplugins.xml
│   │   │   bom-maventree.json
│   │   │   bom-maventree.xml
│   │   │   bom-postgen-test.json
│   │   │   bom-postgen-test2.json
│   │   │   bower.json
│   │   │   build.sbt.lock
│   │   │   bun.lockb
│   │   │   cabal-2.project.freeze
│   │   │   cabal.project.freeze
│   │   │   cargo-auditable.txt
│   │   │   Cargo1.toml
│   │   │   Cargo2.toml
│   │   │   Cargo3.toml
│   │   │   Cargom.lock
│   │   │   Chart.yaml
│   │   │   chen-science-requirements.txt
│   │   │   clj-tree.txt
│   │   │   cloudbuild.yaml
│   │   │   cmake-debug.txt
│   │   │   CMakeLists.txt
│   │   │   compile_commands.json
│   │   │   composer-2.json
│   │   │   composer-2.lock
│   │   │   composer-3.lock
│   │   │   composer-4.lock
│   │   │   composer.json
│   │   │   composer.lock
│   │   │   conan-v1.lock
│   │   │   conan-v2.lock
│   │   │   conan.with_custom_pkg_user_channel.lock
│   │   │   conanfile.txt
│   │   │   conanfile.with_custom_pkg_user_channel.txt
│   │   │   conda-list.json
│   │   │   conda.yml
│   │   │   ddc-sbom.json
│   │   │   ddc-sbom.xml
│   │   │   debian-status
│   │   │   deno-test.lock.json
│   │   │   deployment.yaml
│   │   │   deps.edn
│   │   │   deps.edn.1
│   │   │   deps.edn.2
│   │   │   df.json
│   │   │   docker-compose-cr.yml
│   │   │   docker-compose-mysql.yml
│   │   │   docker-compose-ng.yml
│   │   │   docker-compose.yml
│   │   │   Dockerfile
│   │   │   emailservice.yaml
│   │   │   extra-ml-requirements.txt
│   │   │   Gemfile-opt.lock
│   │   │   Gemfile.lock
│   │   │   Gemfile1.lock
│   │   │   Gemfile2.lock
│   │   │   Gemfile4.lock
│   │   │   Gemfile5.lock
│   │   │   Gemfile6.lock
│   │   │   github-actions-tj.yaml
│   │   │   go-dvwa.mod
│   │   │   go-syft.mod
│   │   │   golist-dep.txt
│   │   │   golist-dep2.txt
│   │   │   gomod-dvwa-graph.txt
│   │   │   gomod-graph.txt
│   │   │   gomod-graph2.txt
│   │   │   gomod-syft-graph.txt
│   │   │   gomodwhy.txt
│   │   │   gomodwhynot.txt
│   │   │   goversion.txt
│   │   │   goversion2.txt
│   │   │   gradle-android-app.dep
│   │   │   gradle-android-dep.out
│   │   │   gradle-android-jetify.dep
│   │   │   gradle-core.out
│   │   │   gradle-dependencies-559.txt
│   │   │   gradle-out-249.dep
│   │   │   gradle-out1.dep
│   │   │   gradle-projects.out
│   │   │   gradle-projects1.out
│   │   │   gradle-projects2.out
│   │   │   gradle-properties-559.txt
│   │   │   gradle-properties-android.txt
│   │   │   gradle-properties-elastic.txt
│   │   │   gradle-properties-single.txt
│   │   │   gradle-properties-single2.txt
│   │   │   gradle-properties-sm.txt
│   │   │   gradle-properties.txt
│   │   │   gradle-rich1.dep
│   │   │   gradle-rich2.dep
│   │   │   gradle-rich3.dep
│   │   │   gradle-rich4.dep
│   │   │   gradle-rich5.dep
│   │   │   gradle-s.out
│   │   │   gradle-service.out
│   │   │   gradle-single.out
│   │   │   gradle-sm.dep
│   │   │   ivy-2.11.0.xml
│   │   │   jquery.3.6.0.nupkg
│   │   │   jt-sbom.json
│   │   │   jt-sbom.xml
│   │   │   kustomization.yaml
│   │   │   lein-tree.txt
│   │   │   Logging.csproj
│   │   │   loofah-2.3.1.gemspec
│   │   │   mercurial-5.5.2-py3.8.egg-info
│   │   │   meson-1.build
│   │   │   meson.build
│   │   │   METADATA
│   │   │   Microsoft.Web.Infrastructure.1.0.0.0.nupkg
│   │   │   Microsoft.Web.Infrastructure.1.0.0.0.nuspec
│   │   │   mix.lock
│   │   │   mix.lock.1
│   │   │   modules.txt
│   │   │   msgpack.mk
│   │   │   multimodule-deep.mod
│   │   │   multimodule-root.mod
│   │   │   multimodule-sub.mod
│   │   │   mvn-dep-tree-simple.txt
│   │   │   mvn-metrics-tree.txt
│   │   │   mvn-p2-plugin.txt
│   │   │   mvn-sbstarter-tree.txt
│   │   │   nokogiri-1.10.10.gemspec
│   │   │   os-release
│   │   │   package-lock-v1.json
│   │   │   package-lock-v2.json
│   │   │   package-lock-v3.json
│   │   │   package-lock2.json
│   │   │   package-lock4.json
│   │   │   Package.resolved
│   │   │   Package2.resolved
│   │   │   packages.config
│   │   │   packages.lock.json
│   │   │   packages2.config
│   │   │   packages2.lock.json
│   │   │   packages3.lock.json
│   │   │   paket.lock
│   │   │   pdm.lock
│   │   │   Pipfile.lock
│   │   │   pnpm-lock.yaml
│   │   │   pnpm-lock2.yaml
│   │   │   pnpm-lock3.yaml
│   │   │   pnpm-lock4.yaml
│   │   │   pnpm-lock6.yaml
│   │   │   pnpm-lock6a.yaml
│   │   │   pnpm-lock6b.yaml
│   │   │   pnpm-lock9a.yaml
│   │   │   pnpm-lock9b.yaml
│   │   │   pnpm-lock9c.yaml
│   │   │   poetry-cpggen.lock
│   │   │   poetry.lock
│   │   │   poetry1.lock
│   │   │   pom-quarkus-modules.xml
│   │   │   pom-quarkus.xml
│   │   │   postgrescluster.yaml
│   │   │   privado.json
│   │   │   project.assets.json
│   │   │   project.assets1.json
│   │   │   project.clj
│   │   │   project.clj.1
│   │   │   project.clj.2
│   │   │   prometheus-community-index.yaml
│   │   │   pubspec.lock
│   │   │   pubspec.yaml
│   │   │   pyproject-author-comma.toml
│   │   │   pyproject.toml
│   │   │   pyproject_uv-workspace.toml
│   │   │   pyproject_uv.toml
│   │   │   pyproject_uv2.toml
│   │   │   pyproject_with_custom_poetry_source.toml
│   │   │   redis.yaml
│   │   │   requirements-lock.linux_py3.txt
│   │   │   requirements.comments.txt
│   │   │   requirements.complex.txt
│   │   │   requirements.freeze.txt
│   │   │   sample-dotnet.csproj
│   │   │   sample-mvn-tree.txt
│   │   │   sbt-dl.list
│   │   │   Server.csproj
│   │   │   service.yaml
│   │   │   setup-impacket.py
│   │   │   skaffold-ms.yaml
│   │   │   skaffold.yaml
│   │   │   swift-deps.json
│   │   │   swift-deps1.json
│   │   │   tekton-task.yml
│   │   │   test-flake.lock
│   │   │   test-flake.nix
│   │   │   tslite.dot
│   │   │   ubuntu-status
│   │   │   usages.json
│   │   │   uv-workspace.lock
│   │   │   uv.lock
│   │   │   vcpkg.json
│   │   │   vcpkg2.json
│   │   │   vuln-spring-1.5.bom.json
│   │   │   WindowsFormsApplication1.csproj
│   │   │   xmlrpc.gemspec
│   │   │   xunit.nuspec
│   │   │   xunit.runner.utility.nuspec
│   │   │   zstd_sys-dc50c4de2e4e7df8.d
│   │   │
│   │   ├───bazel
│   │   │       bazel-action-graph.txt
│   │   │       bazel-state.txt
│   │   │       BUILD
│   │   │
│   │   ├───cmakes
│   │   │       CMakeLists-tpl.txt
│   │   │       CMakeLists-version.txt
│   │   │       CMakeLists.txt
│   │   │       conanfile.txt
│   │   │       conanfile1.txt
│   │   │       DownloadPThreadPool.cmake
│   │   │       fbVersion.cmake
│   │   │       mongoc-config.cmake
│   │   │
│   │   ├───issue-2069
│   │   │       requirements.txt
│   │   │
│   │   ├───issue-2082
│   │   │       requirements.txt
│   │   │
│   │   ├───issue-2156
│   │   │       demo.csproj
│   │   │
│   │   ├───mill
│   │   │   └───out
│   │   │       ├───bar
│   │   │       │   │   ivyDepsTree.log
│   │   │       │   │
│   │   │       │   └───test
│   │   │       │           ivyDepsTree.log
│   │   │       │
│   │   │       └───foo
│   │   │           │   ivyDepsTree.log
│   │   │           │
│   │   │           └───test
│   │   │                   ivyDepsTree.log
│   │   │
│   │   ├───openapi
│   │   │       openapi-oai.yaml
│   │   │       openapi-spec.json
│   │   │
│   │   ├───package-json
│   │   │   ├───theia
│   │   │   │       package-lock.json
│   │   │   │
│   │   │   ├───v1
│   │   │   │       package-lock.json
│   │   │   │       package.json
│   │   │   │
│   │   │   ├───v2
│   │   │   │       package-lock.json
│   │   │   │       package.json
│   │   │   │
│   │   │   ├───v2-workspace
│   │   │   │   │   package-lock.json
│   │   │   │   │   package.json
│   │   │   │   │
│   │   │   │   ├───app
│   │   │   │   │       package.json
│   │   │   │   │
│   │   │   │   └───scripts
│   │   │   │           package.json
│   │   │   │
│   │   │   └───v3
│   │   │           package-lock.json
│   │   │           package.json
│   │   │
│   │   ├───pnpm_locks
│   │   │       bytemd-pnpm-lock.yaml
│   │   │       bytemd-pnpm-workspace.yaml
│   │   │       pnpm-workspace.yaml
│   │   │
│   │   ├───swiftsem
│   │   │       bom-hakit.json
│   │   │       output-file-map.json
│   │   │       package.swift-structure.json
│   │   │       semantics.slices.json
│   │   │       swift-build-output1.txt
│   │   │       swift-dump-package.json
│   │   │       swift-index-speech.json
│   │   │       swift-index-starscream.json
│   │   │       swift-index-starscream2.json
│   │   │       swift-module-info.json
│   │   │       swift-module-info2.json
│   │   │       swift-structure-grdb.json
│   │   │       swift-structure-speech.json
│   │   │       swift-structure-starscream.json
│   │   │       swift-structure-starscream2.json
│   │   │
│   │   ├───yarn-workspaces-same-version-demo
│   │   │   │   package.json
│   │   │   │   yarn.lock
│   │   │   │
│   │   │   └───packages
│   │   │       ├───app-a
│   │   │       │       index.js
│   │   │       │       package.json
│   │   │       │
│   │   │       └───app-b
│   │   │               index.js
│   │   │               package.json
│   │   │
│   │   └───yarn_locks
│   │           yarn-at.lock
│   │           yarn-light.lock
│   │           yarn-multi.lock
│   │           yarn.lock
│   │           yarn3.lock
│   │           yarn4.lock
│   │           yarn5.lock
│   │           yarn6.lock
│   │           yarn7.lock
│   │           yarnv1-empty.lock
│   │           yarnv1-fs.lock
│   │           yarnv2.lock
│   │           yarnv3.lock
│   │           yarnv4.1.lock
│   │           yarnv4.lock
│   │
│   ├───diff
│   │       container-tests-repos.csv
│   │       diff_tests.py
│   │       generate.py
│   │       README.md
│   │       repos.csv
│   │       requirements.txt
│   │
│   ├───gomod
│   │       go.mod
│   │       go.sum
│   │
│   └───gopkg
│           Gopkg.lock
│
├───tools_config
│       org.cyclonedx.cdxgen.appdata.xml
│
└───types
    ├───cli
    │       index.d.ts
    │       index.d.ts.map
    │
    ├───evinser
    │       scalasem.d.ts
    │       scalasem.d.ts.map
    │       swiftsem.d.ts
    │       swiftsem.d.ts.map
    │
    ├───helpers
    │       analyzer.d.ts
    │       analyzer.d.ts.map
    │       cbomutils.d.ts
    │       cbomutils.d.ts.map
    │       db.d.ts
    │       db.d.ts.map
    │       display.d.ts
    │       display.d.ts.map
    │       dotnetutils.d.ts
    │       dotnetutils.d.ts.map
    │       envcontext.d.ts
    │       envcontext.d.ts.map
    │       logger.d.ts
    │       logger.d.ts.map
    │       protobom.d.ts
    │       protobom.d.ts.map
    │       utils.d.ts
    │       utils.d.ts.map
    │       validator.d.ts
    │       validator.d.ts.map
    │
    ├───lib
    │   ├───cli
    │   │       index.d.ts
    │   │       index.d.ts.map
    │   │
    │   ├───evinser
    │   │       evinser.d.ts
    │   │       evinser.d.ts.map
    │   │       scalasem.d.ts
    │   │       scalasem.d.ts.map
    │   │       swiftsem.d.ts
    │   │       swiftsem.d.ts.map
    │   │
    │   ├───helpers
    │   │   │   analyzer.d.ts
    │   │   │   analyzer.d.ts.map
    │   │   │   cbomutils.d.ts
    │   │   │   cbomutils.d.ts.map
    │   │   │   db.d.ts
    │   │   │   db.d.ts.map
    │   │   │   display.d.ts
    │   │   │   display.d.ts.map
    │   │   │   dotnetutils.d.ts
    │   │   │   dotnetutils.d.ts.map
    │   │   │   envcontext.d.ts
    │   │   │   envcontext.d.ts.map
    │   │   │   logger.d.ts
    │   │   │   logger.d.ts.map
    │   │   │   protobom.d.ts
    │   │   │   protobom.d.ts.map
    │   │   │   utils.d.ts
    │   │   │   utils.d.ts.map
    │   │   │   validator.d.ts
    │   │   │   validator.d.ts.map
    │   │   │
    │   │   └───package_specific
    │   │           gradleutils.d.ts
    │   │           gradleutils.d.ts.map
    │   │
    │   ├───managers
    │   │       binary.d.ts
    │   │       binary.d.ts.map
    │   │       docker.d.ts
    │   │       docker.d.ts.map
    │   │       oci.d.ts
    │   │       oci.d.ts.map
    │   │       piptree.d.ts
    │   │       piptree.d.ts.map
    │   │
    │   ├───server
    │   │       server.d.ts
    │   │       server.d.ts.map
    │   │
    │   └───stages
    │       ├───postgen
    │       │       annotator.d.ts
    │       │       annotator.d.ts.map
    │       │       postgen.d.ts
    │       │       postgen.d.ts.map
    │       │
    │       └───pregen
    │               pregen.d.ts
    │               pregen.d.ts.map
    │
    ├───managers
    │       binary.d.ts
    │       binary.d.ts.map
    │       docker.d.ts
    │       docker.d.ts.map
    │       oci.d.ts
    │       oci.d.ts.map
    │       piptree.d.ts
    │       piptree.d.ts.map
    │
    ├───parsers
    │       iri.d.ts
    │       iri.d.ts.map
    │
    ├───server
    │       server.d.ts
    │       server.d.ts.map
    │
    ├───stages
    │   ├───postgen
    │   │       annotator.d.ts
    │   │       annotator.d.ts.map
    │   │       postgen.d.ts
    │   │       postgen.d.ts.map
    │   │
    │   └───pregen
    │           pregen.d.ts
    │           pregen.d.ts.map
    │
    └───third-party
        └───arborist
            └───lib
                │   calc-dep-flags.d.ts
                │   calc-dep-flags.d.ts.map
                │   can-place-dep.d.ts
                │   can-place-dep.d.ts.map
                │   case-insensitive-map.d.ts
                │   case-insensitive-map.d.ts.map
                │   consistent-resolve.d.ts
                │   consistent-resolve.d.ts.map
                │   debug.d.ts
                │   debug.d.ts.map
                │   deepest-nesting-target.d.ts
                │   deepest-nesting-target.d.ts.map
                │   dep-valid.d.ts
                │   dep-valid.d.ts.map
                │   diff.d.ts
                │   diff.d.ts.map
                │   edge.d.ts
                │   edge.d.ts.map
                │   from-path.d.ts
                │   from-path.d.ts.map
                │   gather-dep-set.d.ts
                │   gather-dep-set.d.ts.map
                │   index.d.ts
                │   index.d.ts.map
                │   inventory.d.ts
                │   inventory.d.ts.map
                │   link.d.ts
                │   link.d.ts.map
                │   node.d.ts
                │   node.d.ts.map
                │   optional-set.d.ts
                │   optional-set.d.ts.map
                │   override-resolves.d.ts
                │   override-resolves.d.ts.map
                │   override-set.d.ts
                │   override-set.d.ts.map
                │   peer-entry-sets.d.ts
                │   peer-entry-sets.d.ts.map
                │   place-dep.d.ts
                │   place-dep.d.ts.map
                │   printable.d.ts
                │   printable.d.ts.map
                │   query-selector-all.d.ts
                │   query-selector-all.d.ts.map
                │   realpath.d.ts
                │   realpath.d.ts.map
                │   relpath.d.ts
                │   relpath.d.ts.map
                │   reset-dep-flags.d.ts
                │   reset-dep-flags.d.ts.map
                │   retire-path.d.ts
                │   retire-path.d.ts.map
                │   shrinkwrap.d.ts
                │   shrinkwrap.d.ts.map
                │   signal-handling.d.ts
                │   signal-handling.d.ts.map
                │   signals.d.ts
                │   signals.d.ts.map
                │   spec-from-lock.d.ts
                │   spec-from-lock.d.ts.map
                │   tracker.d.ts
                │   tracker.d.ts.map
                │   tree-check.d.ts
                │   tree-check.d.ts.map
                │   version-from-tgz.d.ts
                │   version-from-tgz.d.ts.map
                │   yarn-lock.d.ts
                │   yarn-lock.d.ts.map
                │
                └───arborist
                        index.d.ts
                        index.d.ts.map
                        load-actual.d.ts
                        load-actual.d.ts.map
                        load-virtual.d.ts
                        load-virtual.d.ts.map




---

### 📁 Key Highlights

- **`lib/`** → Core logic for parsing, analysis, and SBOM generation.  
- **`contrib/`** → Optional tools, fine-tuning data, and AI-driven utilities.  
- **`ci/`** → Docker build and CI/CD configurations.  
- **`data/`** → Schemas and mappings for components, licenses, and templates.  
- **`docs/`** → Documentation for CLI usage, environment setup, and API details.  
- **`test/`** → Test data across multiple ecosystems (npm, Maven, Gradle, etc.).  
- **`types/`** → TypeScript definitions for internal and external modules.  

---





## 🧰 Core Technologies — CycloneDX cdxgen

### 1. Programming Languages & Runtime
- **Node.js** – Primary runtime environment.
- **JavaScript (ESM)** – Core implementation language.
- **TypeScript (Type Definitions)** – Provides `.d.ts` type files for static typing and IDE support.

### 2. Core Purpose
- **SBOM Generation** – Generates **Software Bill of Materials (SBOMs)** compliant with the **CycloneDX** specification (versions 1.4–1.7).
- **Multi-Ecosystem Support** – Parses and analyzes dependencies from:
  - Node.js (npm, pnpm, yarn)
  - Python (requirements, poetry, pip)
  - Java (Maven, Gradle)
  - .NET (NuGet)
  - Ruby (Gems)
  - Go, Swift, Rust, and others
- **Container & OS Analysis** – Supports Docker and OCI image SBOM generation.

### 3. Execution Modes
- **CLI Tool** – Command-line interface (`cdxgen`) for local or CI/CD usage.
- **Library** – Importable Node.js/TypeScript module.
- **Server Mode** – HTTP API server for remote SBOM generation.

### 4. Supporting Technologies
- **pnpm** – Package manager used for workspace management.
- **ESM Modules** – Modern module syntax (`import/export`).
- **JSON & JSON Schema** – Output format for CycloneDX BOMs.
- **Docker** – Used for container builds and environment setup.
- **GitHub Actions** – Continuous Integration and SBOM publishing workflows.

### 5. Security & Compliance Features
- **CycloneDX Standard** – Core SBOM schema maintained by the CycloneDX project.
- **Signature & Attestation Support** – Enables signed and verifiable SBOMs.
- **Dependency-Track Integration** – Supports direct submission to Dependency-Track or other SBOM management systems.

---

### 📄 Summary
> **cdxgen** is a Node.js-based, cross-ecosystem SBOM generator built around the **CycloneDX** standard.  
> It provides CLI, library, and server modes, supports dozens of build ecosystems, and outputs verifiable, security-compliant SBOMs in JSON format.




## 🧩 Build and Test Commands

Before contributing or creating a pull request, make sure to set up the project correctly and verify that all tests pass.

### 🏗️ Build Setup

```bash
# Enable pnpm (comes with Node.js via Corepack)
corepack enable pnpm

# Install dependencies with frozen lockfile
pnpm install:frozen

# Generate type definitions from JSDoc syntax
pnpm run gen-types

# Run the BiomeJS formatter and linter with autofix
pnpm run lint














## ⚙️ Configuration Files in CycloneDX cdxgen

The cdxgen project includes aseveral key configuration and setup files that control its behavior, build process, and tooling integrations.  
Below is an overview of the most relevant configuration files and their purposes.

---

### 🧩 Root-Level Configuration Files

| File | Purpose |
|------|----------|
| **`package.json`** | Defines project metadata, dependencies, scripts, and CLI entry points. |
| **`pnpm-workspace.yaml`** | Manages pnpm workspace configuration for multi-package structure. |
| **`tsconfig.json`** | TypeScript configuration file for type checking and compilation options. |
| **`biome.json`** | Configuration for Biome (linter, formatter, and code quality checks). |
| **`renovate.json`** | Configuration for dependency update automation (via Renovate bot). |
| **`.nvmrc`** | Specifies the Node.js version to ensure environment consistency. |
| **`.codacy.yml`** | Configures Codacy code quality analysis. |
| **`.dockerignore`** | Specifies files and directories to exclude from Docker builds. |
| **`.npmignore`** | Defines which files are excluded when publishing to npm. |
| **`.gitignore`** | Specifies files ignored by Git. |
| **`.devcontainer.json`** | Dev Container setup for VS Code Remote Development. |
| **`.envrc`** | Defines environment variables (used by direnv for shell setup). |

---

### 🧠 Application & CLI Configuration

| File | Location | Purpose |
|------|-----------|----------|
| **`bin/cdxgen.js`** | `bin/` | Primary CLI entry point — executes SBOM generation logic. |
| **`lib/helpers/config.js`** | `lib/helpers/` | Contains configuration logic used internally by cdxgen. |
| **`lib/server/server.js`** | `lib/server/` | Starts the server when running `cdxgen --server`. |
| **`lib/cli/index.js`** | `lib/cli/` | Parses command-line arguments and triggers corresponding operations. |
| **`ci/Dockerfile`** | `ci/` | Defines build process for Docker-based CI/CD images. |

---

### 🧪 Test & Validation Configuration

| File | Purpose |
|------|----------|
| **`jest.config.js`** *(if present)* | Configures the Jest testing framework. |
| **`pyproject.toml`** | Defines Python-related tooling for dependency or schema validation. |
| **`docker-compose.yml`** | Used to spin up local test environments (for SBOM server mode). |

---

### 📁 Supporting Configs

| Directory | Purpose |
|------------|----------|
| **`.github/workflows/`** | Contains GitHub Actions CI/CD workflow files (linting, tests, releases). |
| **`ci/images/`** | Holds Docker image definitions for multiple languages and environments. |
| **`tools_config/`** | Contains additional XML or YAML tool metadata (e.g., `org.cyclonedx.cdxgen.appdata.xml`). |

---

### 🔍 Notable Runtime/Execution Files

| File | Purpose |
|------|----------|
| **`index.cjs`** | Entry file for CommonJS environments (loads main functionality). |
| **`cdxgen.js`** *(in `bin/`)* | Core command-line executable logic for generating SBOMs. |
| **`verify.js`** | Verifies signed SBOMs (`cdx-verify` command). |

---

### 🧾 Summary

> Most configurations live at the root level for build, lint, and packaging.  
> Runtime logic and tool behavior are defined under `bin/` and `lib/`, while CI/CD configurations are under `.github/` and `ci/`.

---

**Reference:**  
[Official CycloneDX cdxgen Repository](https://github.com/CycloneDX/cdxgen)
