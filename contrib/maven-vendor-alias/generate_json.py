import json

INPUT_FILE = "eclipse_artifacts.txt"
OUTPUT_FILE = "vendor-alias.json"

def main():
    alias_map = {}

    # Pre-populate with manual overrides if needed
    alias_map["spring.boot"] = "org.springframework.boot"

    print(f"Reading {INPUT_FILE}...")

    with open(INPUT_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            parts = line.strip().split('|')
            if len(parts) != 2:
                continue

            group_id = parts[0]
            artifact_id = parts[1]

            # Logic: We want to map Artifact ID -> Group ID
            # ONLY if they are different.
            if "-" not in artifact_id or group_id == artifact_id or "docs" in artifact_id or "incubating" in artifact_id or "example" in group_id or "example" in artifact_id or "test" in group_id or artifact_id.lower() != artifact_id or "sample" in group_id or "sample" in artifact_id or "test" in artifact_id:
                continue

            # Check if this artifact ID is already mapped?
            # In Maven, artifact IDs are not globally unique (e.g. "core"),
            # but for Eclipse bundles, they usually are unique symbolic names.

            if artifact_id not in alias_map:
                alias_map[artifact_id] = group_id
            else:
                # Collision handling: (Optional)
                # If we have "core" -> "org.apache.commons", and now we see "core" -> "jackson",
                # we might have a problem.
                # For Eclipse/OSGi, the artifactId is usually a FQDN (org.eclipse.osgi), so collisions are rare.
                pass

    print(f"Generated {len(alias_map)} aliases.")

    with open(OUTPUT_FILE, 'w') as out:
        json.dump(alias_map, out, indent=2, sort_keys=True)
        print(f"Written to {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
