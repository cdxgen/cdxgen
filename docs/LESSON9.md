# Tutorials - Auditing container escape and privilege risks

This lesson shows how to use cdxgen's container executable inventory together with the `container-risk` BOM audit rules to spot:

- container-escape helpers
- privileged GTFOBins execution primitives
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

When cdxgen recognizes a collected executable from GTFOBins-derived data, it adds properties such as:

- `cdx:gtfobins:functions`
- `cdx:gtfobins:privilegedContexts`
- `cdx:gtfobins:riskTags`
- `cdx:gtfobins:reference`

These properties let BOM audit distinguish between:

- ordinary package inventory
- known post-exploitation helpers
- binaries that become much riskier when setuid/setgid bits or capability-backed execution are present

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
      riskTags: ((.properties // [])[] | select(.name == "cdx:gtfobins:riskTags") | .value)
    }
' bom.json
```

## 4) What to fix first

Prioritize findings in this order:

1. `CTR-001` and `CTR-002` — setuid/setgid or container-escape helpers
2. `CTR-003` and `CTR-004` — privileged escalation, library-load, or exfiltration helpers
3. `CTR-005` — mutable-path remote-execution tooling

Strong remediation patterns:

- move production workloads to distroless or minimal base images
- strip setuid/setgid bits from runtime images
- remove `docker`, `ctr`, `kubectl`, `nsenter`, and similar admin/debug tools from app images
- keep debug or break-glass tooling in separate images
- block access to Docker/containerd sockets and avoid privileged containers

## 5) Suggested CI gate

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
