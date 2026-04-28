import { assert, it } from "poku";

import { extractTags, textualMetadata } from "./annotator.js";

it("textualMetadata tests", () => {
  assert.deepStrictEqual(textualMetadata({}), undefined);
  assert.deepStrictEqual(
    textualMetadata({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:fbef273d-0bce-4931-a748-0bf547cf7575",
      version: 1,
      metadata: {
        timestamp: "2024-10-24T09:21:23Z",
        tools: {
          components: [
            {
              group: "@cyclonedx",
              name: "cdxgen",
              version: "10.11.0",
              purl: "pkg:npm/%40cyclonedx/cdxgen@10.11.0",
              type: "application",
              "bom-ref": "pkg:npm/@cyclonedx/cdxgen@10.11.0",
              publisher: "OWASP Foundation",
              authors: [
                {
                  name: "OWASP Foundation",
                },
              ],
            },
          ],
        },
        authors: [
          {
            name: "OWASP Foundation",
          },
        ],
        lifecycles: [
          {
            phase: "build",
          },
        ],
        component: {
          group: "sec",
          name: "java-sec-code",
          version: "1.0.0",
          properties: [
            {
              name: "SrcFile",
              value: "/Volumes/Work/sandbox/java-sec-code/pom.xml",
            },
          ],
          purl: "pkg:maven/sec/java-sec-code@1.0.0?type=jar",
          "bom-ref": "pkg:maven/sec/java-sec-code@1.0.0?type=jar",
          type: "application",
        },
        properties: [
          {
            name: "cdx:bom:componentTypes",
            value: "maven",
          },
          {
            name: "cdx:bom:componentNamespaces",
            value:
              "antlr\\naopalliance\\nasm\\ncglib\\nch.qos.logback\\ncn.hutool\\ncom.alibaba\\ncom.auth0\\ncom.fasterxml\\ncom.fasterxml.jackson.core\\ncom.fasterxml.uuid\\ncom.google.code.findbugs\\ncom.google.code.gson\\ncom.google.errorprone\\ncom.google.guava\\ncom.google.inject\\ncom.google.inject.extensions\\ncom.google.j2objc\\ncom.google.protobuf\\ncom.googlecode.json-simple\\ncom.h2database\\ncom.ibm.db2\\ncom.ibm.icu\\ncom.jayway.jsonpath\\ncom.monitorjbl\\ncom.netflix.archaius\\ncom.netflix.eureka\\ncom.netflix.governator\\ncom.netflix.hystrix\\ncom.netflix.netflix-commons\\ncom.netflix.ribbon\\ncom.netflix.servo\\ncom.rackspace.apache\\ncom.rackspace.eclipse.webtools.sourceediting\\ncom.squareup.okhttp\\ncom.squareup.okio\\ncom.sun.jersey\\ncom.sun.jersey.contribs\\ncom.thoughtworks.xstream\\ncommons-beanutils\\ncommons-codec\\ncommons-collections\\ncommons-configuration\\ncommons-httpclient\\ncommons-io\\ncommons-jxpath\\ncommons-lang\\ncommons-logging\\ncommons-net\\ndom4j\\nedu.princeton.cup\\nio.github.x-stream\\nio.jsonwebtoken\\nio.netty\\nio.reactivex\\nio.springfox\\nio.swagger\\njavax.inject\\njavax.validation\\njavax.ws.rs\\njavax.xml.stream\\njaxen\\njoda-time\\njunit\\nmysql\\nnet.bytebuddy\\nnet.minidev\\nnz.net.ultraq.thymeleaf\\nognl\\norg.antlr\\norg.apache.commons\\norg.apache.httpcomponents\\norg.apache.logging.log4j\\norg.apache.poi\\norg.apache.shiro\\norg.apache.tomcat\\norg.apache.tomcat.embed\\norg.apache.velocity\\norg.apache.xmlbeans\\norg.bouncycastle\\norg.checkerframework\\norg.codehaus.groovy\\norg.codehaus.jettison\\norg.codehaus.mojo\\norg.codehaus.woodstox\\norg.dom4j\\norg.hamcrest\\norg.hdrhistogram\\norg.hibernate\\norg.javassist\\norg.jboss.logging\\norg.jdom\\norg.jolokia\\norg.jsecurity\\norg.jsoup\\norg.mapstruct\\norg.mybatis\\norg.mybatis.spring.boot\\norg.ow2.asm\\norg.postgresql\\norg.projectlombok\\norg.slf4j\\norg.springframework\\norg.springframework.boot\\norg.springframework.cloud\\norg.springframework.data\\norg.springframework.plugin\\norg.springframework.security\\norg.thymeleaf\\norg.unbescape\\norg.xmlbeam\\norg.yaml\\nstax\\nxml-apis\\nxml-resolver\\nxmlpull",
          },
        ],
      },
    }),
    "This Software Bill-of-Materials (SBOM) document was created on Thursday, October 24, 2024 with cdxgen. The data was captured during the build lifecycle phase. The document describes an application named 'java-sec-code' with version '1.0.0'. BOM file is empty without components. The package type in this SBOM is maven with 116 purl namespaces described under components.",
  );
  assert.deepStrictEqual(
    textualMetadata({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:6b21a46c-c637-4558-8e85-c72c78a771dd",
      version: 1,
      metadata: {
        timestamp: "2024-11-11T20:54:35Z",
        tools: {
          components: [
            {
              group: "@cyclonedx",
              name: "cdxgen",
              version: "11.0.0",
              purl: "pkg:npm/%40cyclonedx/cdxgen@11.0.0",
              type: "application",
              "bom-ref": "pkg:npm/@cyclonedx/cdxgen@11.0.0",
              publisher: "OWASP Foundation",
              authors: [
                {
                  name: "OWASP Foundation",
                },
              ],
            },
          ],
        },
        authors: [
          {
            name: "OWASP Foundation",
          },
        ],
        lifecycles: [
          {
            phase: "pre-build",
          },
          {
            phase: "post-build",
          },
        ],
        component: {
          name: "ghcr.io/owasp-dep-scan/depscan",
          version: "v5.5.0",
          type: "container",
          purl: "pkg:oci/ghcr.io/owasp-dep-scan/depscan@sha256:134b031d8d21a4769eb30adea61778fd6f9c6d9fc3af5d8f6a10c12ee1c22357",
          "bom-ref":
            "pkg:oci/ghcr.io/owasp-dep-scan/depscan@sha256:134b031d8d21a4769eb30adea61778fd6f9c6d9fc3af5d8f6a10c12ee1c22357",
          components: [
            {
              group: "",
              name: "depscan:v5.5.0",
              version: "latest",
              purl: "pkg:pypi/depscan:v5.5.0@latest",
              type: "application",
              "bom-ref": "pkg:pypi/depscan:v5.5.0@latest",
            },
            {
              group: "",
              name: "depscan:v5.5.0",
              version: "latest",
              purl: "pkg:maven/depscan:v5.5.0@latest",
              type: "application",
              "bom-ref": "pkg:maven/depscan:v5.5.0@latest",
            },
          ],
        },
        properties: [
          {
            name: "oci:image:Id",
            value:
              "sha256:2079f928de9d98ff1694b6eb1656dd34f99db9977f3bd54d269c3acf3985f0df",
          },
          {
            name: "oci:image:RepoTag",
            value: "ghcr.io/owasp-dep-scan/depscan:v5.5.0",
          },
          {
            name: "oci:image:RepoDigest",
            value:
              "ghcr.io/owasp-dep-scan/depscan@sha256:134b031d8d21a4769eb30adea61778fd6f9c6d9fc3af5d8f6a10c12ee1c22357",
          },
          {
            name: "oci:image:Created",
            value: "2024-11-10T23:25:53.617358464Z",
          },
          {
            name: "oci:image:Architecture",
            value: "amd64",
          },
          {
            name: "oci:image:Os",
            value: "linux",
          },
          {
            name: "oci:image:manifest:Config",
            value:
              "blobs/sha256/2079f928de9d98ff1694b6eb1656dd34f99db9977f3bd54d269c3acf3985f0df",
          },
          {
            name: "oci:image:manifest:Layers",
            value:
              "blobs/sha256/5b4dc115a0a19ca21e26ddcd2ca859cdc815b649ebcba074f6ffdefe0073236c\\nblobs/sha256/8c1783c0465ad957c2659e4db49fdea0e28e09ceaedc0f936a1bc84a61ebaa48\\nblobs/sha256/329da318288186d1d8884386331b1927799a1dfc7849dd2a9a9f97b2bb82de41",
          },
          {
            name: "oci:image:componentTypes",
            value: "alma\\nalmalinux\\nalmalinux-9.4\\nrpm",
          },
          {
            name: "cdx:bom:componentTypes",
            value: "generic\\ngolang\\nmaven\\nnpm\\npypi\\nrpm",
          },
          {
            name: "cdx:bom:componentNamespaces",
            value:
              "@appthreat\\n@babel\\n@bufbuild\\n@cyclonedx\\n@gar\\n@isaacs\\n@jridgewell\\n@npmcli\\n@pkgjs\\n@sec-ant\\n@sigstore\\n@sindresorhus\\n@szmarczak\\n@tootallnate\\n@tufjs\\n@types\\nalma\\naopalliance\\ncom.amazonaws\\ncom.beust\\ncom.esotericsoftware.minlog\\ncom.esotericsoftware.reflectasm\\ncom.fasterxml.jackson.core\\ncom.github.javaparser\\ncom.github.mwiede\\ncom.google.api-client\\ncom.google.apis\\ncom.google.code.findbugs\\ncom.google.code.gson\\ncom.google.errorprone\\ncom.google.guava\\ncom.google.http-client\\ncom.google.inject\\ncom.google.oauth-client\\ncom.googlecode.jatl\\ncom.googlecode.plist\\ncom.thoughtworks.qdox\\ncommons-cli\\ncommons-codec\\ncommons-io\\ncommons-lang\\nfile-events-0.22-milestone\\nfile-events-linux-aarch64-0.22-milestone\\nfile-events-linux-amd64-0.22-milestone\\nfile-events-osx-aarch64-0.22-milestone\\nfile-events-osx-amd64-0.22-milestone\\nfile-events-windows-amd64-0.22-milestone\\nfile-events-windows-amd64-min-0.22-milestone\\nfile-events-windows-i386-0.22-milestone\\nfile-events-windows-i386-min-0.22-milestone\\ngithub.com/aliyun\\ngithub.com/aws\\ngithub.com/aws/aws-sdk-go-v2\\ngithub.com/aws/aws-sdk-go-v2/aws/protocol\\ngithub.com/aws/aws-sdk-go-v2/feature/ec2\\ngithub.com/aws/aws-sdk-go-v2/feature/s3\\ngithub.com/aws/aws-sdk-go-v2/internal\\ngithub.com/aws/aws-sdk-go-v2/internal/endpoints\\ngithub.com/aws/aws-sdk-go-v2/service\\ngithub.com/aws/aws-sdk-go-v2/service/internal\\ngithub.com/cilium\\ngithub.com/containerd\\ngithub.com/containerd/stargz-snapshotter\\ngithub.com/containerd/typeurl\\ngithub.com/containernetworking\\ngithub.com/containers\\ngithub.com/coreos/go-systemd\\ngithub.com/cpuguy83/go-md2man\\ngithub.com/docker\\ngithub.com/dragonflyoss/image-service/contrib\\ngithub.com/dustin\\ngithub.com/go-logr\\ngithub.com/godbus/dbus\\ngithub.com/gogo\\ngithub.com/goharbor\\ngithub.com/golang\\ngithub.com/google\\ngithub.com/ianlancetaylor\\ngithub.com/jmespath\\ngithub.com/klauspost\\ngithub.com/microsoft\\ngithub.com/mmcloughlin\\ngithub.com/moby\\ngithub.com/moby/sys\\ngithub.com/opencontainers\\ngithub.com/pelletier\\ngithub.com/pkg\\ngithub.com/russross/blackfriday\\ngithub.com/shurcool\\ngithub.com/sirupsen\\ngithub.com/stefanberger\\ngithub.com/urfave\\ngithub.com/urfave/cli\\ngithub.com/vbatts\\ngithub.com/xrash\\ngo.etcd.io\\ngo.mozilla.org\\ngo.opentelemetry.io\\ngo.opentelemetry.io/otel\\ngolang.org/x\\ngoogle.golang.org\\ngopkg.in\\ngopkg.in/square\\ngradle-antlr\\ngradle-api-metadata\\ngradle-base-asm\\ngradle-base-ide-plugins\\ngradle-base-services\\ngradle-base-services-groovy\\ngradle-bean-serialization-services\\ngradle-build-cache\\ngradle-build-cache-base\\ngradle-build-cache-http\\ngradle-build-cache-local\\ngradle-build-cache-packaging\\ngradle-build-cache-spi\\ngradle-build-configuration\\ngradle-build-events\\ngradle-build-init\\ngradle-build-operations\\ngradle-build-option\\ngradle-build-process-services\\ngradle-build-profile\\ngradle-build-state\\ngradle-cli\\ngradle-client-services\\ngradle-code-quality\\ngradle-composite-builds\\ngradle-concurrent\\ngradle-configuration-cache\\ngradle-configuration-cache-base\\ngradle-configuration-problems-base\\ngradle-core\\ngradle-core-api\\ngradle-core-kotlin-extensions\\ngradle-core-serialization-codecs\\ngradle-daemon-main\\ngradle-daemon-protocol\\ngradle-daemon-server\\ngradle-daemon-services\\ngradle-declarative-dsl-api\\ngradle-declarative-dsl-core\\ngradle-declarative-dsl-evaluator\\ngradle-declarative-dsl-provider\\ngradle-declarative-dsl-tooling-builders\\ngradle-declarative-dsl-tooling-models\\ngradle-dependency-management\\ngradle-dependency-management-serialization-codecs\\ngradle-diagnostics\\ngradle-ear\\ngradle-encryption-services\\ngradle-enterprise\\ngradle-enterprise-logging\\ngradle-enterprise-operations\\ngradle-enterprise-workers\\ngradle-execution\\ngradle-file-collections\\ngradle-file-temp\\ngradle-file-watching\\ngradle-files\\ngradle-flow-services\\ngradle-functional\\ngradle-gradle-cli\\ngradle-gradle-cli-main\\ngradle-graph-serialization\\ngradle-guava-serialization-codecs\\ngradle-hashing\\ngradle-ide\\ngradle-ide-native\\ngradle-ide-plugins\\ngradle-input-tracking\\ngradle-installation-beacon\\ngradle-instrumentation-agent\\ngradle-instrumentation-agent-services\\ngradle-instrumentation-declarations\\ngradle-internal-instrumentation-api\\ngradle-io\\ngradle-ivy\\ngradle-jacoco\\ngradle-java-api-extractor\\ngradle-java-compiler-plugin\\ngradle-java-platform\\ngradle-jvm-services\\ngradle-kotlin-dsl\\ngradle-kotlin-dsl-extensions\\ngradle-kotlin-dsl-provider-plugins\\ngradle-kotlin-dsl-shared-runtime\\ngradle-kotlin-dsl-tooling-builders\\ngradle-kotlin-dsl-tooling-models\\ngradle-language-groovy\\ngradle-language-java\\ngradle-language-jvm\\ngradle-language-native\\ngradle-launcher\\ngradle-logging\\ngradle-logging-api\\ngradle-maven\\ngradle-messaging\\ngradle-model-core\\ngradle-model-groovy\\ngradle-native\\ngradle-normalization-java\\ngradle-persistent-cache\\ngradle-platform-base\\ngradle-platform-jvm\\ngradle-platform-native\\ngradle-plugin-development\\ngradle-plugin-use\\ngradle-plugins-application\\ngradle-plugins-distribution\\ngradle-plugins-groovy\\ngradle-plugins-java\\ngradle-plugins-java-base\\ngradle-plugins-java-library\\ngradle-plugins-jvm-test-fixtures\\ngradle-plugins-jvm-test-suite\\ngradle-plugins-test-report-aggregation\\ngradle-plugins-version-catalog\\ngradle-problems\\ngradle-problems-api\\ngradle-process-services\\ngradle-publish\\ngradle-reporting\\ngradle-resources\\ngradle-resources-gcs\\ngradle-resources-http\\ngradle-resources-s3\\ngradle-resources-sftp\\ngradle-runtime-api-info\\ngradle-scala\\ngradle-security\\ngradle-serialization\\ngradle-service-lookup\\ngradle-service-provider\\ngradle-service-registry-builder\\ngradle-service-registry-impl\\ngradle-signing\\ngradle-snapshots\\ngradle-stdlib-java-extensions\\ngradle-stdlib-kotlin-extensions\\ngradle-stdlib-serialization-codecs\\ngradle-test-kit\\ngradle-test-suites-base\\ngradle-testing-base\\ngradle-testing-base-infrastructure\\ngradle-testing-junit-platform\\ngradle-testing-jvm\\ngradle-testing-jvm-infrastructure\\ngradle-testing-native\\ngradle-time\\ngradle-toolchains-jvm\\ngradle-toolchains-jvm-shared\\ngradle-tooling-api\\ngradle-tooling-api-builders\\ngradle-tooling-api-provider\\ngradle-tooling-native\\ngradle-unit-test-fixtures\\ngradle-version-control\\ngradle-war\\ngradle-worker-main\\ngradle-workers\\ngradle-wrapper-main\\ngradle-wrapper-shared\\nio.grpc\\nio.opencensus\\nit.unimi.dsi.fastutil\\njavax.annotation\\njavax.inject\\njcifs\\njoda-time\\njrt-fs\\njunit\\nkotlinx-serialization-json-jvm\\nlukechampine.com\\nnative-platform-0.22-milestone\\nnative-platform-freebsd-amd64-libcpp-0.22-milestone\\nnative-platform-linux-aarch64-0.22-milestone\\nnative-platform-linux-aarch64-ncurses5-0.22-milestone\\nnative-platform-linux-aarch64-ncurses6-0.22-milestone\\nnative-platform-linux-amd64-0.22-milestone\\nnative-platform-linux-amd64-ncurses5-0.22-milestone\\nnative-platform-linux-amd64-ncurses6-0.22-milestone\\nnative-platform-osx-aarch64-0.22-milestone\\nnative-platform-osx-amd64-0.22-milestone\\nnative-platform-windows-amd64-0.22-milestone\\nnative-platform-windows-amd64-min-0.22-milestone\\nnative-platform-windows-i386-0.22-milestone\\nnative-platform-windows-i386-min-0.22-milestone\\nnet.i2p.crypto\\norg.antlr\\norg.apache-extras.beanshell\\norg.apache.ant\\norg.apache.commons\\norg.apache.httpcomponents\\norg.apache.ivy\\norg.apache.maven\\norg.apache.maven.resolver\\norg.apache.maven.shared\\norg.apache.maven.wagon\\norg.apache.sshd\\norg.bouncycastle\\norg.codehaus.groovy\\norg.codehaus.plexus\\norg.eclipse.jgit\\norg.eclipse.sisu\\norg.fusesource.jansi\\norg.hamcrest\\norg.jetbrains\\norg.jetbrains.intellij.deps\\norg.jetbrains.kotlin\\norg.jetbrains.kotlinx\\norg.jsoup\\norg.junit.platform\\norg.objenesis\\norg.opentest4j\\norg.ow2.asm\\norg.scala-sbt\\norg.slf4j\\norg.testng\\norg.tomlj\\norg.yaml\\nxml-apis",
          },
        ],
      },
    }),
    "This Software Bill-of-Materials (SBOM) document was created on Monday, November 11, 2024 with cdxgen. The lifecycles phases represented are: pre-build and post-build. The document describes a container named 'ghcr.io/owasp-dep-scan/depscan' with version 'v5.5.0'. The container also has 2 child modules/components. BOM file is empty without components. The linux image uses the amd64 architecture and has the registry tag ghcr.io/owasp-dep-scan/depscan:v5.5.0. The OS components are of types alma, almalinux, almalinux-9.4, and rpm. 6 package type(s) and 322 purl namespaces are described in the document under components.",
  );

  assert.deepStrictEqual(
    textualMetadata({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      serialNumber: "urn:uuid:bfbbd0b7-4901-4fa3-8edd-275cf777d56e",
      version: 1,
      metadata: {
        timestamp: "2024-11-11T22:50:24Z",
        tools: {
          components: [
            {
              group: "@cyclonedx",
              name: "cdxgen",
              version: "11.0.0",
              purl: "pkg:npm/%40cyclonedx/cdxgen@11.0.0",
              type: "application",
              "bom-ref": "pkg:npm/@cyclonedx/cdxgen@11.0.0",
              publisher: "OWASP Foundation",
              authors: [
                {
                  name: "OWASP Foundation",
                },
              ],
            },
          ],
        },
        authors: [
          {
            name: "OWASP Foundation",
          },
        ],
        lifecycles: [
          {
            phase: "pre-build",
          },
          {
            phase: "operations",
          },
        ],
        component: {
          name: "Microsoft+Windows+11+Pro",
          group: "",
          version: "22H2",
          description: "",
          publisher: "Microsoft",
          "bom-ref": "pkg:swid/Microsoft+Windows+11+Pro@22H2",
          purl: "pkg:swid/Microsoft%2BWindows%2B11%2BPro@22H2",
          type: "operating-system",
          properties: [
            {
              name: "cdx:osquery:category",
              value: "win_version",
            },
            {
              name: "arch",
              value: "x64",
            },
            {
              name: "build_version",
              value: "10.0.22621",
            },
          ],
        },
        properties: [
          {
            name: "cdx:bom:componentTypes",
            value: "npm\\npypi\\nswid",
          },
        ],
      },
    }),
    "This Operations Bill-of-Materials (OBOM) document was created on Monday, November 11, 2024 with cdxgen. The lifecycles phases represented are: pre-build and operations. The document describes an operating system named 'Microsoft Windows 11 Pro' with version '22H2'. BOM file is empty without components. The OS uses the x64 architecture and has the build version '10.0.22621'.",
  );

  assert.ok(
    textualMetadata({
      metadata: {
        component: {
          name: "trusted-demo",
          type: "application",
          version: "1.0.0",
        },
        timestamp: "2026-01-01T00:00:00Z",
        tools: {
          components: [{ name: "cdxgen" }],
        },
      },
      components: [
        {
          name: "left-pad",
          properties: [
            {
              name: "cdx:npm:trustedPublishing",
              value: "true",
            },
          ],
          type: "library",
        },
        {
          name: "requests",
          properties: [
            {
              name: "cdx:pypi:trustedPublishing",
              value: "true",
            },
          ],
          type: "library",
        },
      ],
    }).includes(
      "Trusted publishing metadata is present for 1 npm component(s) and 1 PyPI component(s).",
    ),
  );
});

it("extractTags tests", () => {
  assert.deepStrictEqual(extractTags({ name: "container-selinux" }, "obom"), [
    "container",
    "security",
  ]);
});
