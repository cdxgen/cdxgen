# Tutorials - Auditing container escape and privilege risks

This lesson shows how to use cdxgen's container executable inventory together with the `container-risk` BOM audit rules to spot:

- container-escape helpers
- privileged GTFOBins execution primitives
- offensive toolkit binaries inspired by Peirates, CDK, and DEEPCE
- seccomp-sensitive namespace escape helpers
- exfiltration-capable binaries
- mutable-path remote execution tooling

## 1) Generate a container SBOM with executable collection and audit enabled

Use a container image reference or an exported OCI layout.

```bash
cdxgen -t container \
  --deep \
  --bom-audit \
  --bom-audit-categories container-risk \
  --bom-audit-fail-severity high \
  -o bom.json \
  docker.io/library/ubuntu:24.04
```

Why this matters:

- `--deep` enables richer binary collection for container images
- `--bom-audit` evaluates built-in audit rules immediately
- `container-risk` focuses the findings on container breakout and post-exploit tooling

## 2) Understand what the analyzer enriches

When cdxgen recognizes a collected executable from GTFOBins-derived data or curated container-tradecraft knowledge, it adds properties such as:

- `cdx:gtfobins:functions`
- `cdx:gtfobins:privilegedContexts`
- `cdx:gtfobins:riskTags`
- `cdx:gtfobins:reference`
- `cdx:container:attackTechniques`
- `cdx:container:offenseTools`
- `cdx:container:seccompBlockedSyscalls`

These properties let BOM audit distinguish between:

- ordinary package inventory
- known post-exploitation helpers
- binaries that become much riskier when setuid/setgid bits or capability-backed execution are present
- helpers that map to MITRE ATT&CK for Containers or offensive playbooks such as Peirates, CDK, and DEEPCE
- helpers that stay partially constrained only while the runtime keeps the default seccomp profile in place

## 3) Review findings and inspect matched binaries

Quickly list the matched audit findings:

```bash
jq '.annotations[]?.text // empty' bom.json
```

Inspect the enriched executable records:

```bash
jq '
  .components[]
  | select(
      (.properties // [])
      | any(.name == "cdx:gtfobins:matched" and .value == "true")
    )
  | {
      name,
      purl,
      srcFile: ((.properties // [])[] | select(.name == "SrcFile") | .value),
      functions: ((.properties // [])[] | select(.name == "cdx:gtfobins:functions") | .value),
      privilegedContexts: ((.properties // [])[] | select(.name == "cdx:gtfobins:privilegedContexts") | .value),
      riskTags: ((.properties // [])[] | select(.name == "cdx:gtfobins:riskTags") | .value),
      attackTechniques: ((.properties // [])[] | select(.name == "cdx:container:attackTechniques") | .value),
      offenseTools: ((.properties // [])[] | select(.name == "cdx:container:offenseTools") | .value),
      seccompBlockedSyscalls: ((.properties // [])[] | select(.name == "cdx:container:seccompBlockedSyscalls") | .value)
    }
' bom.json
```

## 4) What to fix first

Prioritize findings in this order:

1. `CTR-001` and `CTR-002` — setuid/setgid or container-escape helpers
2. `CTR-003` and `CTR-004` — privileged escalation, library-load, or exfiltration helpers
3. `CTR-005` and `CTR-006` — mutable-path helpers and dedicated offensive toolkits
4. `CTR-007` — seccomp-sensitive namespace escape helpers

Strong remediation patterns:

- move production workloads to distroless or minimal base images
- strip setuid/setgid bits from runtime images
- remove `docker`, `ctr`, `kubectl`, `nsenter`, and similar admin/debug tools from app images
- never ship `peirates`, `cdk`, `deepce`, or similar red-team binaries in production images
- keep debug or break-glass tooling in separate images
- block access to Docker/containerd sockets and avoid privileged containers
- keep the default seccomp profile unless you have a narrowly-scoped and reviewed exception

## 5) Where the extra context comes from

The current container enrichment combines four complementary knowledge sources:

- **MITRE ATT&CK for Containers** for tactic and technique IDs such as host escape, cluster discovery, and container administration
- **Peirates / CDK / DEEPCE** for practical cluster-pivot, service-account, runtime-socket, and breakout playbooks
- **Docker default seccomp guidance** for syscalls like `setns`, `unshare`, and `open_by_handle_at` that should stay blocked in most app workloads
- **GTFOBins** for executable-level abuse primitives and privileged execution context

## 6) Suggested CI gate

Use a high-severity fail gate for production images:

```bash
cdxgen -t container \
  --deep \
  --bom-audit \
  --bom-audit-categories container-risk \
  --bom-audit-fail-severity high \
  -o bom.json \
  your-registry.example.com/team/app:release
```

This keeps obviously dangerous helpers out of runtime images while still allowing lower-severity findings to flow into triage.
