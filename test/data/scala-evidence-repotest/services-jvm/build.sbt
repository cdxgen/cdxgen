// Services ground-truth fixture: server routes (http4s, pekko-http, tapir, zio-http, cask),
// outbound HTTP clients (sttp, http4s ember, java.net.http, pekko-http) and data stores (JDBC, Kafka).
ThisBuild / organization := "corpus.scala"
ThisBuild / version := "0.1.0"
lazy val scala3 = "3.3.7"
lazy val scala213 = "2.13.18"
ThisBuild / scalaVersion := scala3
ThisBuild / crossScalaVersions := Seq(scala3, scala213)

lazy val root = (project in file("."))
  .settings(
    name := "services-jvm",
    libraryDependencies ++= Seq(
      "org.http4s" %% "http4s-ember-server" % "0.23.30",
      "org.http4s" %% "http4s-ember-client" % "0.23.30",
      "org.http4s" %% "http4s-dsl" % "0.23.30",
      "org.apache.pekko" %% "pekko-http" % "1.1.0",
      "org.apache.pekko" %% "pekko-stream" % "1.1.3",
      "com.softwaremill.sttp.tapir" %% "tapir-core" % "1.11.50",
      "com.softwaremill.sttp.client4" %% "core" % "4.0.9",
      "dev.zio" %% "zio-http" % "3.0.1",
      "com.lihaoyi" %% "cask" % "0.11.3",
      "org.postgresql" % "postgresql" % "42.7.13",
      "org.apache.kafka" % "kafka-clients" % "3.9.0"
    )
  )
