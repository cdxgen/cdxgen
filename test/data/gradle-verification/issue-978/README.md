# Gradle verification metadata from cdxgen issue 978

This directory reproduces the sample attached to
[cdxgen issue 978](https://github.com/CycloneDX/cdxgen/issues/978), a
`gradle/verification-metadata.xml` written by
`gradle --write-verification-metadata sha512` on a project that resolves
Jackson, Guava, Protobuf and gRPC dependencies.

The build files are a minimal reconstruction: the verification metadata was
produced by a larger project, so `build.gradle` and `settings.gradle` declare
only the plugins and dependencies the sample's Jackson entries correspond to.
They exist so cdxgen recognises the directory as a Gradle build; the
verification metadata itself is the attachment verbatim, unmodified.
