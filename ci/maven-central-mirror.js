#!/usr/bin/env node

/**
 * ci/maven-central-mirror.js: route a CI job's Maven Central traffic through
 * Google's mirror of Maven Central.
 *
 * Maven Central answers HTTP 429 to busy hosts, and CI runners share theirs,
 * so builds under test fail to resolve at random. The mirror serves the same
 * artifacts. Only Central-bound traffic moves; other repositories are left
 * alone.
 *
 * - Maven: a settings profile in ~/.m2/settings.xml that redefines the
 *   `central` repository. Keeping the id keeps a warm local repository valid.
 * - Maven wrapper: MVNW_REPOURL, for the Maven distribution it downloads.
 * - Gradle: an init script that rewrites Central and puts the mirror in front
 *   of the plugin portal, which redirects plain dependencies to Central.
 * - sbt, Mill and scala-cli: COURSIER_MIRRORS. Coursier then caches under the
 *   mirror's host, so sbt purls in these jobs carry the mirror as their
 *   repository_url.
 *
 * Runs on GitHub-hosted runners only. A self-hosted runner keeps its home
 * directory between jobs, and its own configuration stays in charge there.
 *
 * Usage: node ci/maven-central-mirror.js
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const MIRROR = "https://maven-central.storage-download.googleapis.com/maven2";
const CENTRAL_URLS = [
  "https://repo1.maven.org/maven2",
  "https://repo.maven.apache.org/maven2",
];
const PROFILE_ID = "ci-maven-central-mirror";

const MAVEN_PROFILE = `<profile>
      <id>${PROFILE_ID}</id>
      <repositories>
        <repository><id>central</id><url>${MIRROR}</url><snapshots><enabled>false</enabled></snapshots></repository>
      </repositories>
      <pluginRepositories>
        <pluginRepository><id>central</id><url>${MIRROR}</url><snapshots><enabled>false</enabled></snapshots></pluginRepository>
      </pluginRepositories>
    </profile>`;

const GRADLE_INIT_SCRIPT = `// Written by cdxgen's ci/maven-central-mirror.js for this CI job.
def mirror = "${MIRROR}"
def centralUrls = ${JSON.stringify(CENTRAL_URLS)} as Set
def mirrorName = "ciMavenCentralMirror"
def isCentral = { r ->
    r instanceof MavenArtifactRepository && centralUrls.contains(r.url.toString().replaceAll('/+$', ''))
}
def isPortal = { r -> r instanceof MavenArtifactRepository && r.url.host == "plugins.gradle.org" }
// getCredentials() creates credentials as a side effect, so only read what is configured.
def hasCredentials = { r ->
    r.hasProperty("configuredCredentials") && r.configuredCredentials.isPresent()
}
def rewrite = { RepositoryHandler repos ->
    repos.configureEach { r ->
        if (isCentral(r) && !hasCredentials(r)) {
            r.url = mirror
        }
    }
}
// The plugin portal answers non-plugin coordinates with a 303 to Central, so
// the mirror has to sit in front of it.
def frontPortal = { RepositoryHandler repos ->
    repos.whenObjectAdded { r ->
        if (isPortal(r) && repos.findByName(mirrorName) == null) {
            def m = repos.maven { name = mirrorName; url = mirror }
            repos.remove(m)
            repos.addFirst(m)
        }
    }
}
beforeSettings { settings ->
    rewrite(settings.buildscript.repositories)
    rewrite(settings.pluginManagement.repositories)
    rewrite(settings.dependencyResolutionManagement.repositories)
    frontPortal(settings.pluginManagement.repositories)
}
settingsEvaluated { settings ->
    // An empty list means the implicit portal; declare it so frontPortal fires.
    if (settings.pluginManagement.repositories.isEmpty()) {
        settings.pluginManagement.repositories.gradlePluginPortal()
    }
}
allprojects { p ->
    rewrite(p.buildscript.repositories)
    rewrite(p.repositories)
}
`;

/**
 * Insert the mirror profile into a Maven settings document, keeping what is
 * there (setup-java writes its server entries into the same file).
 *
 * @param {string} xml Existing settings.xml content, or an empty string.
 * @returns {string} Settings with the profile defined and active.
 */
export function withMirrorProfile(xml) {
  let settings = xml?.includes("</settings>")
    ? xml
    : '<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">\n</settings>\n';
  if (settings.includes(`<id>${PROFILE_ID}</id>`)) {
    return settings;
  }
  const insertBefore = (text, marker, addition) => {
    const at = text.lastIndexOf(marker);
    return `${text.slice(0, at)}${addition}${text.slice(at)}`;
  };
  settings = settings.includes("</profiles>")
    ? insertBefore(settings, "</profiles>", `  ${MAVEN_PROFILE}\n  `)
    : insertBefore(
        settings,
        "</settings>",
        `  <profiles>\n    ${MAVEN_PROFILE}\n  </profiles>\n`,
      );
  const active = `<activeProfile>${PROFILE_ID}</activeProfile>`;
  settings = settings.includes("</activeProfiles>")
    ? insertBefore(settings, "</activeProfiles>", `  ${active}\n  `)
    : insertBefore(
        settings,
        "</settings>",
        `  <activeProfiles>\n    ${active}\n  </activeProfiles>\n`,
      );
  return settings;
}

function main() {
  if (process.env.RUNNER_ENVIRONMENT !== "github-hosted") {
    console.log(
      "Not a GitHub-hosted runner; Maven Central traffic is left as configured.",
    );
    return;
  }
  const home = homedir();
  const m2 = join(home, ".m2");
  mkdirSync(m2, { recursive: true });
  const settingsFile = join(m2, "settings.xml");
  let existing = "";
  try {
    existing = readFileSync(settingsFile, "utf-8");
  } catch {
    // no settings yet
  }
  writeFileSync(settingsFile, withMirrorProfile(existing));

  const initDir = join(home, ".gradle", "init.d");
  mkdirSync(initDir, { recursive: true });
  writeFileSync(
    join(initDir, "ci-maven-central-mirror.gradle"),
    GRADLE_INIT_SCRIPT,
  );

  const stateDir = join(
    process.env.RUNNER_TEMP || home,
    "maven-central-mirror",
  );
  mkdirSync(stateDir, { recursive: true });
  // Coursier reads a semicolon-separated `from` list; a comma list is ignored.
  const coursierMirrors = join(stateDir, "mirror.properties");
  writeFileSync(
    coursierMirrors,
    `central.from=${CENTRAL_URLS.join(";")}\ncentral.to=${MIRROR}\n`,
  );
  const exports = {
    MVNW_REPOURL: MIRROR,
    COURSIER_MIRRORS: coursierMirrors,
  };
  if (process.env.GITHUB_ENV) {
    appendFileSync(
      process.env.GITHUB_ENV,
      Object.entries(exports)
        .map(([name, value]) => `${name}=${value}\n`)
        .join(""),
    );
  }
  console.log(`Maven Central traffic of this job goes through ${MIRROR}.`);
}

if (process.argv[1]?.endsWith("maven-central-mirror.js")) {
  main();
}
