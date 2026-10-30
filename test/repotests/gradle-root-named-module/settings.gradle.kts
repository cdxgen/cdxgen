// Issue #4695: the main module carries the root project's name and inherits
// its group and version, so the module and the root share one purl. The
// settings and the main module use the Kotlin DSL, as in the issue's build;
// the other modules use Groovy so the fixture covers both.
rootProject.name = "example-service"

include("example-service", "example-service-rest-api", "example-service-it")
