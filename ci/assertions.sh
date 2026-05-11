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

container_file_inventory_signature() {
  local bom_file="$1"
  jq -c '{
    metadataExecutableCount: (([.metadata.properties[]? | select(.name == "cdx:container:unpackagedExecutableCount") | (.value | tonumber?)] | first) // 0),
    metadataSharedLibraryCount: (([.metadata.properties[]? | select(.name == "cdx:container:unpackagedSharedLibraryCount") | (.value | tonumber?)] | first) // 0),
    actualExecutableCount: (([.components[]? | select(.type == "file" and ((.properties // []) | any(.name == "internal:is_executable" and .value == "true")))]) | length),
    actualSharedLibraryCount: (([.components[]? | select(.type == "file" and ((.properties // []) | any(.name == "internal:is_shared_library" and .value == "true")))]) | length)
  }' "$bom_file"
}

assert_container_file_inventory_bom() {
  local bom_file="$1"
  local signature
  signature="$(container_file_inventory_signature "$bom_file")"
  echo "$signature" | jq -e '
    .metadataExecutableCount == .actualExecutableCount
    and .metadataSharedLibraryCount == .actualSharedLibraryCount
  ' >/dev/null || {
    echo "Expected unpackaged file inventory counts to match component inventory in $bom_file"
    echo "signature=$signature"
    return 1
  }
}

assert_container_inventory_has_unpackaged_binaries() {
  local bom_file="$1"
  local signature
  signature="$(container_file_inventory_signature "$bom_file")"
  echo "$signature" | jq -e '
    .metadataExecutableCount > 0
    and .metadataSharedLibraryCount > 0
  ' >/dev/null || {
    echo "Expected unpackaged executables and shared libraries in $bom_file"
    echo "signature=$signature"
    return 1
  }
}

assert_same_container_file_inventory_signature() {
  local expected actual
  expected=$(container_file_inventory_signature "$1")
  actual=$(container_file_inventory_signature "$2")
  if [ "$expected" != "$actual" ]; then
    echo "Expected matching unpackaged file inventory signature between $1 and $2"
    echo "expected=$expected"
    echo "actual=$actual"
    return 1
  fi
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

os_repository_crypto_signature() {
  local bom_file="$1"
  jq -c '
    [.components[]? | select(.type == "data" and ((.properties // []) | any(.name == "cdx:os:repo:type"))) | .["bom-ref"]] as $repoRefs
    | [.components[]? | select(.type == "data" and ((.properties // []) | any(.name == "cdx:os:repo:type")) and ((.properties // []) | any(.name == "cdx:os:repo:signedBy" or .name == "cdx:os:repo:gpgkey"))) | .["bom-ref"]] as $repoRefsWithExplicitKeys
    | [.components[]? | select(.type == "cryptographic-asset" and (.cryptoProperties.assetType // "") == "related-crypto-material" and (.cryptoProperties.relatedCryptoMaterialProperties.type // "") == "public-key") | .["bom-ref"]] as $keyRefs
    | {
      repoSources: ($repoRefs | length),
      repoSourcesWithExplicitKeys: ($repoRefsWithExplicitKeys | length),
      trustedKeys: ($keyRefs | length),
      repoKeyEdges: [
        .dependencies[]?
        | .ref as $repoRef
        | select(($repoRefs | index($repoRef)) != null)
        | .dependsOn[]?
        | . as $depRef
        | select(($keyRefs | index($depRef)) != null)
      ] | length
    }
  ' "$bom_file"
}

assert_os_repository_crypto_bom() {
  local bom_file="$1"
  local signature
  signature="$(os_repository_crypto_signature "$bom_file")"
  echo "$signature" | jq -e '
    .repoSources > 0
    and .trustedKeys > 0
    and (.repoSourcesWithExplicitKeys == 0 or .repoKeyEdges > 0)
  ' >/dev/null || {
    echo "Expected OS repository source and trusted-key crypto coverage in $bom_file"
    echo "signature=$signature"
    return 1
  }
}

assert_same_os_repository_crypto_signature() {
  local expected actual
  expected=$(os_repository_crypto_signature "$1")
  actual=$(os_repository_crypto_signature "$2")
  if [ "$expected" != "$actual" ]; then
    echo "Expected matching OS repository/trusted-key signature between $1 and $2"
    echo "expected=$expected"
    echo "actual=$actual"
    return 1
  fi
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
