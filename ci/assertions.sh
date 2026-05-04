#!/usr/bin/env bash

readonly CDXGEN_TOOL_IDENTITY_JQ_DEFS=$(cat <<'EOF'
def metadata_tool_entries:
  if (.metadata.tools? | type) == "array" then
    .metadata.tools[]?
  else
    (.metadata.tools.components // [])[]?,
    (.metadata.tools.services // [])[]?
  end;
def identity_entries:
  .evidence.identity as $identity
  | if ($identity | type) == "array" then
      $identity[]?
    elif ($identity | type) == "object" then
      $identity
    else
      empty
    end;
EOF
)

assert_container_audit_bom() {
  local bom_file="$1"
  jq -e '[.annotations[]? | select((.text // "") | contains("cdx:audit:category | container-risk |"))] | length > 0' "$bom_file" >/dev/null || {
    echo "Expected container-risk audit findings in $bom_file"
    return 1
  }
  jq -e '[.components[]? | select((.properties // []) | any((.name == "cdx:gtfobins:matched" or .name == "cdx:container:matched") and .value == "true"))] | length > 0' "$bom_file" >/dev/null || {
    echo "Expected GTFOBins or container-risk enrichment properties in $bom_file"
    return 1
  }
}

assert_trivy_tool_identity_bom() {
  local bom_file="$1"
  jq -e --arg tool_name "trivy" "${CDXGEN_TOOL_IDENTITY_JQ_DEFS}
    def is_named_tool:
      .[\"bom-ref\"] != null and (
        ((.name // \"\") | ascii_downcase | contains(\$tool_name)) or
        ((.[\"bom-ref\"] // \"\") | ascii_downcase | contains(\$tool_name))
      );
    [metadata_tool_entries | select(is_named_tool)] | length > 0
  " "$bom_file" >/dev/null || {
    echo "Expected trivy tool metadata in $bom_file"
    return 1
  }
  jq -e --arg tool_name "trivy" "${CDXGEN_TOOL_IDENTITY_JQ_DEFS}
    def is_named_tool:
      .[\"bom-ref\"] != null and (
        ((.name // \"\") | ascii_downcase | contains(\$tool_name)) or
        ((.[\"bom-ref\"] // \"\") | ascii_downcase | contains(\$tool_name))
      );
    [metadata_tool_entries | select(.[\"bom-ref\"] != null) | .[\"bom-ref\"]] as \$toolRefs
    | [metadata_tool_entries | select(is_named_tool) | .[\"bom-ref\"]] as \$trivyToolRefs
    | (\$trivyToolRefs | length) > 0
      and any(.components[]?;
        any(identity_entries;
          (.tools // []) as \$identityTools
          | (\$identityTools | length) > 0
            and all(\$identityTools[]; \$toolRefs | index(.) != null)
            and any(\$identityTools[]; \$trivyToolRefs | index(.) != null)
        )
      )
  " "$bom_file" >/dev/null || {
    echo "Expected identity evidence tools in $bom_file to reference declared trivy metadata tools"
    return 1
  }
}

assert_non_cdxgen_tool_identity_bom() {
  local bom_file="$1"
  jq -e "${CDXGEN_TOOL_IDENTITY_JQ_DEFS}
    [metadata_tool_entries | select(.name != \"cdxgen\" and .[\"bom-ref\"] != null)] | length > 0
  " "$bom_file" >/dev/null || {
    echo "Expected non-cdxgen tool metadata in $bom_file"
    return 1
  }
  jq -e "${CDXGEN_TOOL_IDENTITY_JQ_DEFS}
    [metadata_tool_entries | select(.name != \"cdxgen\" and .[\"bom-ref\"] != null) | .[\"bom-ref\"]] as \$toolRefs
    | (\$toolRefs | length) > 0
      and any(.components[]?;
        any(identity_entries;
          (.tools // []) as \$identityTools
          | (\$identityTools | length) > 0
            and all(\$identityTools[]; \$toolRefs | index(.) != null)
        )
      )
  " "$bom_file" >/dev/null || {
    echo "Expected identity evidence tools in $bom_file to reference declared metadata tools"
    return 1
  }
}

container_audit_signature() {
  local bom_file="$1"
  jq -c '{
    containerRiskAnnotations: [.annotations[]? | select((.text // "") | contains("cdx:audit:category | container-risk |"))] | length,
    enrichedComponents: [.components[]? | select((.properties // []) | any((.name == "cdx:gtfobins:matched" or .name == "cdx:container:matched") and .value == "true"))] | length
  }' "$bom_file"
}

assert_same_container_audit_signature() {
  local expected actual
  expected=$(container_audit_signature "$1")
  actual=$(container_audit_signature "$2")
  if [ "$expected" != "$actual" ]; then
    echo "Expected matching container audit signature between $1 and $2"
    echo "expected=$expected"
    echo "actual=$actual"
    return 1
  fi
}
