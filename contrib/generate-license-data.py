#!/usr/bin/env python3
import os
import json
import re
import urllib.request
from pathlib import Path

# Setup paths
WORKSPACE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = WORKSPACE_DIR / "data"

# The reference license toolkit checkout is located via the SCANCODE_DIR
# environment variable. Falls back to a sibling checkout next to this repo.
LICENSE_TOOLKIT_DIR_ENV = os.environ.get("SCANCODE_DIR")
if LICENSE_TOOLKIT_DIR_ENV:
    LICENSE_TOOLKIT_DIR = Path(LICENSE_TOOLKIT_DIR_ENV).resolve()
else:
    LICENSE_TOOLKIT_DIR = (WORKSPACE_DIR.parent / "scancode-toolkit").resolve()

if not (LICENSE_TOOLKIT_DIR / "src" / "licensedcode").exists():
    raise SystemExit(
        "Could not locate the reference license toolkit. "
        "Set the SCANCODE_DIR environment variable to a valid checkout."
    )

import sys
sys.path.insert(0, str(LICENSE_TOOLKIT_DIR / "src"))
from licensedcode.models import load_licenses

def normalize_key(name):
    if not name:
        return ""
    # Lowercase and remove all non-alphanumeric/plus characters
    return re.sub(r'[^a-z0-9+]', '', name.lower())

def fetch_spdx_data():
    print("Fetching SPDX licenses...")
    with urllib.request.urlopen("https://raw.githubusercontent.com/spdx/license-list-data/main/json/licenses.json") as response:
        spdx_licenses = json.loads(response.read().decode('utf-8'))
        
    print("Fetching SPDX exceptions...")
    with urllib.request.urlopen("https://raw.githubusercontent.com/spdx/license-list-data/main/json/exceptions.json") as response:
        spdx_exceptions = json.loads(response.read().decode('utf-8'))
        
    return spdx_licenses, spdx_exceptions

def main():
    spdx_raw_licenses, spdx_raw_exceptions = fetch_spdx_data()
    
    # 1. Build spdx-license-list.json
    spdx_license_list = {
        "licenses": {},
        "exceptions": {}
    }
    
    for lic in spdx_raw_licenses.get("licenses", []):
        spdx_license_list["licenses"][lic["licenseId"]] = {
            "name": lic["name"],
            "isDeprecated": lic.get("isDeprecatedLicenseId", False),
            "isOsiApproved": lic.get("isOsiApproved", False),
            "isFsfLibre": lic.get("isFsfLibre", False),
            "seeAlso": lic.get("seeAlso", [])
        }
        
    for exc in spdx_raw_exceptions.get("exceptions", []):
        spdx_license_list["exceptions"][exc["licenseExceptionId"]] = {
            "name": exc["name"],
            "isDeprecated": exc.get("isDeprecatedLicenseId", False),
            "seeAlso": exc.get("seeAlso", [])
        }
        
    spdx_list_path = DATA_DIR / "spdx-license-list.json"
    with open(spdx_list_path, "w") as f:
        json.dump(spdx_license_list, f, indent=2)
    print(f"Wrote {spdx_list_path}")
    
    # Load ScanCode licenses
    print("Loading ScanCode licenses...")
    scancode_licenses = load_licenses(with_deprecated=True)
    
    # 2. Build license-db.json
    license_db = {}
    for key, lic in scancode_licenses.items():
        ref = lic.to_reference()
        
        # Determine canonical SPDX ID or fallback
        canonical_spdx = ref.get("spdx_license_key")
        if not canonical_spdx or canonical_spdx.startswith("LicenseRef-scancode-"):
            canonical_spdx = f"LicenseRef-scancode-{key}"
            
        license_db[key] = {
            "key": key,
            "spdx_license_key": canonical_spdx,
            "other_spdx_license_keys": ref.get("other_spdx_license_keys", []),
            "key_aliases": ref.get("key_aliases", []),
            "short_name": ref.get("short_name"),
            "name": ref.get("name"),
            "category": ref.get("category", "Unstated License"),
            "is_exception": ref.get("is_exception", False),
            "is_deprecated": lic.is_deprecated,
            "replaced_by": lic.replaced_by or [],
            "osi_url": ref.get("osi_url"),
            "homepage_url": ref.get("homepage_url")
        }
        
    db_path = DATA_DIR / "license-db.json"
    with open(db_path, "w") as f:
        json.dump(license_db, f, indent=2)
    print(f"Wrote {db_path}")
    
    # 3. Build license-aliases.json
    license_aliases = {}
    
    # Load existing lic-mapping.json if present
    lic_mapping_path = DATA_DIR / "lic-mapping.json"
    if lic_mapping_path.exists():
        with open(lic_mapping_path, "r") as f:
            lic_mapping = json.load(f)
            for entry in lic_mapping:
                exp = entry.get("exp")
                if exp:
                    for name in entry.get("names", []):
                        norm = normalize_key(name)
                        if norm:
                            license_aliases[norm] = exp
                            
    # Add SPDX licenses and exceptions
    for lic_id, meta in spdx_license_list["licenses"].items():
        license_aliases[normalize_key(lic_id)] = lic_id
        license_aliases[normalize_key(meta["name"])] = lic_id
        
    for exc_id, meta in spdx_license_list["exceptions"].items():
        license_aliases[normalize_key(exc_id)] = exc_id
        license_aliases[normalize_key(meta["name"])] = exc_id
        
    # Add ScanCode keys and aliases
    for key, lic_info in license_db.items():
        canonical = lic_info["spdx_license_key"]
        
        # Add key itself
        license_aliases[normalize_key(key)] = canonical
        # Add names
        if lic_info.get("name"):
            license_aliases[normalize_key(lic_info["name"])] = canonical
        if lic_info.get("short_name"):
            license_aliases[normalize_key(lic_info["short_name"])] = canonical
            
        # Add key_aliases
        for alias in lic_info.get("key_aliases", []):
            license_aliases[normalize_key(alias)] = canonical
            
        # Add other_spdx_license_keys
        for other_spdx in lic_info.get("other_spdx_license_keys", []):
            license_aliases[normalize_key(other_spdx)] = canonical
            
    aliases_path = DATA_DIR / "license-aliases.json"
    with open(aliases_path, "w") as f:
        json.dump(license_aliases, f, indent=2)
    print(f"Wrote {aliases_path}")
    
    # 4. Build license-deprecations.json
    license_deprecations = {}
    
    # Standard GNU/SPDX deprecation rules
    gnu_licenses = ["GPL-1.0", "GPL-2.0", "GPL-3.0", "LGPL-2.0", "LGPL-2.1", "LGPL-3.0", "AGPL-1.0", "AGPL-3.0", "GFDL-1.1", "GFDL-1.2", "GFDL-1.3"]
    for base in gnu_licenses:
        # Without '+' is deprecated in favor of '-only'
        license_deprecations[base] = f"{base}-only"
        # With '+' is deprecated in favor of '-or-later'
        license_deprecations[f"{base}+"] = f"{base}-or-later"
        
    # ScanCode replaced_by mappings
    for key, lic_info in license_db.items():
        if lic_info["is_deprecated"] and lic_info["replaced_by"]:
            canonical = lic_info["spdx_license_key"]
            repls = []
            for r in lic_info["replaced_by"]:
                # Check if r is already a complex expression, else resolve key to spdx_license_key
                if " " in r or "WITH" in r or "AND" in r or "OR" in r:
                    # It's an expression. Let's try to map scancode keys inside it
                    # Tokenize by word and replace known scancode keys
                    words = re.split(r'(\s+|\b)', r)
                    mapped_words = []
                    for w in words:
                        w_lower = w.lower()
                        if w_lower in license_db:
                            mapped_words.append(license_db[w_lower]["spdx_license_key"])
                        else:
                            mapped_words.append(w)
                    repls.append("".join(mapped_words))
                else:
                    r_lower = r.lower()
                    if r_lower in license_db:
                        repls.append(license_db[r_lower]["spdx_license_key"])
                    else:
                        repls.append(r)
            if repls:
                # Combine multiple replacements with OR
                expr = " OR ".join(repls) if len(repls) > 1 else repls[0]
                license_deprecations[canonical] = expr
                # Also index by key
                license_deprecations[key] = expr

    deprecations_path = DATA_DIR / "license-deprecations.json"
    with open(deprecations_path, "w") as f:
        json.dump(license_deprecations, f, indent=2)
    print(f"Wrote {deprecations_path}")

if __name__ == "__main__":
    main()
