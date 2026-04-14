# cdx: Custom Properties

This page documents the current `cdx:` custom properties emitted by cdxgen, the ecosystems they map to, and practical supply-chain security/assurance use cases.

## Scope

- Source of truth: non-test source files under `lib/**` (including `lib/helpers/utils.js` and `lib/helpers/ciParsers/*`).
- These are cdxgen-specific properties added to CycloneDX objects (components, workflows, tasks, metadata, and services).
- They are intended to enrich analysis and policy decisions; they are not CycloneDX core fields.

## Property families, ecosystems, and assurance use cases

| Family | Ecosystem / context | What it captures | Security & assurance use cases |
|---|---|---|---|
| `cdx:github:*`, `cdx:actions:*` | GitHub Actions workflows | Workflow/job/step metadata, action references, version pinning style, permission posture, triggers, runner context | Detect unpinned actions, flag workflows/jobs with write privileges, validate OIDC (`id-token`) usage boundaries, review exposure by trigger type and environment |
| `cdx:gitlab:*` | GitLab CI | Pipeline/job stage/image/environment/services/needs metadata | Review pipeline trust boundaries, identify risky service/image usage, validate stage/order dependency intent |
| `cdx:azure:*` | Azure Pipelines | Pipeline file, pool image, trigger branches, stage/job dependencies and conditions | Detect privileged runner pools, verify deployment gating/conditions, ensure branch-scoped execution policy |
| `cdx:circleci:*` | CircleCI | Config/workflow/job relationships, branch filters, orb/executor references | Verify job execution constraints (branch-only), inspect third-party orb use, map build graph for provenance review |
| `cdx:jenkins:*` | Jenkins declarative pipelines | Jenkinsfile source, agent selection, stage metadata (`when`, `parallel`) | Audit build agent trust model, identify conditional/parallel execution complexity and potential bypass paths |
| `cdx:npm:*`, `cdx:pnpm:alias` | Node.js (npm/pnpm) | Binary/script execution surfaces, native addon signals, lock/runtime mismatches, local/path/workspace/alias details | Prioritize packages with install-time execution risk, detect name/version spoofing indicators, identify non-registry or file-based dependencies |
| `cdx:pypi:*`, `cdx:pip:*`, `cdx:pyproject:*`, `cdx:python:*`, `cdx:pixi:*` | Python (pip/requirements, pyproject, lock formats, pixi) | Version constraints, extras, environment markers, registry origin, interpreter constraints, pixi build metadata | Enforce allowed index/registry policy, evaluate conditional dependency exposure by marker, detect drift from latest known version and unresolved naming |
| `cdx:gem:*` | RubyGems/Bundler | Gem platform/source/revision/tag/branch, ruby constraints, executable presence, prerelease/yanked status | Detect mutable VCS-sourced gems, platform-specific attack surface, and yanked/prerelease risk in resolved dependency sets |
| `cdx:cargo:*` | Rust crates.io | Crate metadata linkage (id/latest/rust version/features) | Validate Rust toolchain compatibility, flag feature-driven attack surface changes, monitor lag from newest upstream version |
| `cdx:go:*` | Go modules | Toolchain, indirect/deprecated/local replacement timing metadata | Detect local replacements/non-hermetic resolution, track deprecated modules, validate direct vs indirect risk posture |
| `cdx:dotnet:*` | .NET / NuGet / assemblies | Target framework, project guid, assembly identity/version, hint path, Azure Functions version | Verify framework support policy, detect assembly/package identity mismatches, analyze implicit GAC/hint-path sourced dependencies |
| `cdx:maven:*`, `cdx:gradle:*` | Java (Maven/Gradle) | Effective component scope, shaded namespace evidence, Gradle root path context | Identify shadowed/relocated classes (obfuscation or vendoring risk), enforce dependency-scope policy, track monorepo/root provenance |
| `cdx:nix:*` | Nix flakes | Input source URLs, lock revision/ref/hash/time, flake directory | Validate immutable lock intent, detect unexpected source URL changes, support reproducibility/provenance checks |
| `cdx:swift:*` | Swift Package Manager | Logical package naming and local checkout paths | Identify local checkout dependencies vs remote source dependencies; enforce source-origin controls |
| `cdx:pods:*` | CocoaPods | Podspec location, project directory, pod/subspec mapping | Distinguish local/path/git pod sourcing, trace subspec-enabled feature surface, improve provenance for iOS supply chains |
| `cdx:pub:*` | Dart pub | Non-default registry URL | Enforce approved package registry policy and detect mirror/private feed usage |
| `cdx:bom:*` | BOM-level metadata | Component type set, discovered namespaces, source manifest files | Measure BOM completeness, identify broad component diversity, and support attestable “evidence-of-origin” for manifest inputs |
| `cdx:build:versionSpecifiers` | Build/manifest parsing (e.g., C/C++ build metadata) | Non-exact version constraints captured from build descriptors | Highlight non-pinned dependency constraints and prioritize hardening toward deterministic builds |
| `cdx:osquery:category` | Host/package discovery via osquery | Query/source category for discovered packages | Separate inventory confidence by collection method and tune host-level evidence policies |
| `cdx:service:httpMethod` | OpenAPI/service evidence | HTTP method associated with discovered service endpoints | Support API exposure reviews (method-level attack surface and access-control assurance) |

## Current key inventory (grouped)

### CI/CD and workflow provenance

- **GitHub Actions:** `cdx:github:action:isShaPinned`, `cdx:github:action:uses`, `cdx:github:action:versionPinningType`, `cdx:github:job:environment`, `cdx:github:job:hasWritePermissions`, `cdx:github:job:name`, `cdx:github:job:needs`, `cdx:github:job:runner`, `cdx:github:job:services`, `cdx:github:job:timeoutMinutes`, `cdx:github:run:line`, `cdx:github:step:command`, `cdx:github:step:condition`, `cdx:github:step:continueOnError`, `cdx:github:step:name`, `cdx:github:step:timeout`, `cdx:github:step:type`, `cdx:github:workflow:concurrencyGroup`, `cdx:github:workflow:file`, `cdx:github:workflow:hasIdTokenWrite`, `cdx:github:workflow:hasWritePermissions`, `cdx:github:workflow:name`, `cdx:github:workflow:triggers`
- **GitHub action trust tags:** `cdx:actions:isOfficial`, `cdx:actions:isVerified`
- **GitLab CI:** `cdx:gitlab:config`, `cdx:gitlab:job:environment`, `cdx:gitlab:job:image`, `cdx:gitlab:job:name`, `cdx:gitlab:job:needs`, `cdx:gitlab:job:services`, `cdx:gitlab:job:stage`, `cdx:gitlab:stages`
- **Azure Pipelines:** `cdx:azure:config`, `cdx:azure:job:environment`, `cdx:azure:job:name`, `cdx:azure:job:pool:vmImage`, `cdx:azure:pool:vmImage`, `cdx:azure:stage:condition`, `cdx:azure:stage:dependsOn`, `cdx:azure:stage:name`, `cdx:azure:trigger:branches`
- **CircleCI:** `cdx:circleci:config`, `cdx:circleci:executor:name`, `cdx:circleci:job:branch:only`, `cdx:circleci:job:name`, `cdx:circleci:job:requires`, `cdx:circleci:orb:alias`, `cdx:circleci:workflow:name`
- **Jenkins:** `cdx:jenkins:agent`, `cdx:jenkins:agent:image`, `cdx:jenkins:file`, `cdx:jenkins:stage:name`, `cdx:jenkins:stage:parallel`, `cdx:jenkins:stage:when`

### Package manager and language ecosystems

- **npm/pnpm:** `cdx:npm:bin`, `cdx:npm:binPaths`, `cdx:npm:cpu`, `cdx:npm:deprecated`, `cdx:npm:deprecation_notice`, `cdx:npm:gypfile`, `cdx:npm:hasInstallScript`, `cdx:npm:has_binary`, `cdx:npm:inBundle`, `cdx:npm:inDepBundle`, `cdx:npm:installLinks`, `cdx:npm:isLink`, `cdx:npm:isRegistryDependency`, `cdx:npm:isWorkspace`, `cdx:npm:is_workspace`, `cdx:npm:libc`, `cdx:npm:nameMismatchError`, `cdx:npm:native_addon`, `cdx:npm:native_deps`, `cdx:npm:os`, `cdx:npm:package_json`, `cdx:npm:resolvedPath`, `cdx:npm:risky_scripts`, `cdx:npm:scripts`, `cdx:npm:versionMismatchError`, `cdx:pnpm:alias`
- **Python:** `cdx:pip:markers`, `cdx:pip:structuredMarkers`, `cdx:pypi:extras`, `cdx:pypi:latest_version`, `cdx:pypi:registry`, `cdx:pypi:requiresPython`, `cdx:pypi:resolved_from`, `cdx:pypi:versionSpecifiers`, `cdx:pyproject:group`, `cdx:python:requires_python`, `cdx:pixi:build`, `cdx:pixi:build_number`, `cdx:pixi:operating_system`
- **Ruby:** `cdx:gem:executables`, `cdx:gem:gemUri`, `cdx:gem:platform`, `cdx:gem:prerelease`, `cdx:gem:remote`, `cdx:gem:remoteBranch`, `cdx:gem:remoteRevision`, `cdx:gem:remoteTag`, `cdx:gem:rubyVersionSpecifiers`, `cdx:gem:versionSpecifiers`, `cdx:gem:yanked`
- **Rust:** `cdx:cargo:crate_id`, `cdx:cargo:features`, `cdx:cargo:latest_version`, `cdx:cargo:rust_version`
- **Go:** `cdx:go:creation_time`, `cdx:go:deprecated`, `cdx:go:indirect`, `cdx:go:local_dir`, `cdx:go:toolchain`
- **.NET:** `cdx:dotnet:assembly_name`, `cdx:dotnet:assembly_version`, `cdx:dotnet:azure_functions_version`, `cdx:dotnet:hint_path`, `cdx:dotnet:project_guid`, `cdx:dotnet:target_framework`
- **Java:** `cdx:maven:component_scope`, `cdx:maven:shaded`, `cdx:maven:unshadedNamespaces`, `cdx:gradle:GradleRootPath`
- **Nix:** `cdx:nix:flake_dir`, `cdx:nix:input_url`, `cdx:nix:last_modified`, `cdx:nix:nar_hash`, `cdx:nix:ref`, `cdx:nix:revision`
- **Swift:** `cdx:swift:localCheckoutPath`, `cdx:swift:packageName`
- **CocoaPods:** `cdx:pods:PodName`, `cdx:pods:Subspec`, `cdx:pods:podspecLocation`, `cdx:pods:projectDir`
- **Dart pub:** `cdx:pub:registry`

### Cross-cutting BOM/service/build metadata

- `cdx:bom:componentNamespaces`
- `cdx:bom:componentSrcFiles`
- `cdx:bom:componentTypes`
- `cdx:build:versionSpecifiers`
- `cdx:osquery:category`
- `cdx:service:httpMethod`

## Notes for policy authors

- Prefer evaluating these as **context enrichers** rather than strict truth assertions.
- Treat workspace/local path indicators (`isLink`, `resolvedPath`, `localCheckoutPath`, `projectDir`, `flake_dir`) as provenance signals that may require stronger trust controls.
- Treat execution-related indicators (`risky_scripts`, `hasInstallScript`, CI write permissions, action pinning type) as high-priority triage fields for software supply chain risk.
