plugins {
    `java-library`
}

repositories {
    mavenCentral()
}

dependencies {
    api("org.slf4j:slf4j-api:2.0.7")
    implementation("org.apache.commons:commons-lang3:3.14.0")
    implementation(project(":example-service-rest-api"))
}
