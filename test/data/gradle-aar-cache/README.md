# Gradle AAR cache fixture

A slice of a real Gradle module cache (`modules-2/files-2.1`) holding Android
libraries published as `.aar` files, used by the tests in
`lib/inventory/deps.poku.js`. Every directory below an artifact's version is
named after the SHA-1 of the file it holds, as Gradle does, so the `.aar` and
its `.pom` sit in different hash directories.

| Artifact | Why it is here |
| --- | --- |
| `androidx.core:core:1.13.1` | Large real library (873 classes) whose `classes.jar` holds `androidx.core.content.ContextCompat`. |
| `androidx.core:core-ktx:1.13.1` | Same group, second artifact; its `classes.jar` holds `androidx.core.content.ContextKt`, the class that cannot be attributed to the right artifact without these lists. Its version directory also carries a `.module` file, as real caches do. |
| `com.android.support:support-v13:23.0.1` | Real AAR that ships a second jar, `libs/internal_impl-23.0.1.jar`, whose classes must be read as well. |

The files were fetched from Google's Maven repository with the commands below
and must be replaced only with bytes fetched the same way, so the SHA-1
directory names keep matching the files:

```sh
base=https://dl.google.com/android/maven2
curl -O "$base/androidx/core/core/1.13.1/core-1.13.1.aar"
curl -O "$base/androidx/core/core/1.13.1/core-1.13.1.pom"
curl -O "$base/androidx/core/core-ktx/1.13.1/core-ktx-1.13.1.aar"
curl -O "$base/androidx/core/core-ktx/1.13.1/core-ktx-1.13.1.pom"
curl -O "$base/androidx/core/core-ktx/1.13.1/core-ktx-1.13.1.module"
curl -O "$base/com/android/support/support-v13/23.0.1/support-v13-23.0.1.aar"
curl -O "$base/com/android/support/support-v13/23.0.1/support-v13-23.0.1.pom"
```
