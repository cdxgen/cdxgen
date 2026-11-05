# Gradle verification metadata with PGP verification

An excerpt of the `gradle/verification-metadata.xml` of the
[gradle/gradle](https://github.com/gradle/gradle) repository, taken from
commit `b56d32b745b11e405a7544773589a46b33c2a4a4`:

https://raw.githubusercontent.com/gradle/gradle/b56d32b745b11e405a7544773589a46b33c2a4a4/gradle/verification-metadata.xml

The file is licensed under the Apache License 2.0, and the license header of
the original is kept. The excerpt is trimmed to about a third of the original:
the configuration block keeps its trust rules and the first trusted keys,
including keys that scope their trust with nested `<trusting>` elements and
regular expressions, and the component list keeps 32 entries chosen to cover
artifacts verified by PGP only, by PGP and SHA-256, and by SHA-256 alone. The
original contains neither `also-trust` alternates nor `ignored-keys`, so no
such entry could be kept.

The build files exist only so cdxgen recognises the directory as a Gradle
build; they are not the Gradle project's own.
