// Scala 2.12-only fixture: Akka HTTP 10.2 routes and client, Slick, JCA. No TASTy is ever produced.
ThisBuild / organization := "sample.scala"
ThisBuild / version := "0.1.0"
ThisBuild / scalaVersion := "2.12.20"

lazy val root = (project in file("."))
  .settings(
    name := "scala2-akka",
    libraryDependencies ++= Seq(
      "com.typesafe.akka" %% "akka-http" % "10.2.10",
      "com.typesafe.akka" %% "akka-stream" % "2.6.20",
      "com.typesafe.slick" %% "slick" % "3.4.1",
      "org.postgresql" % "postgresql" % "42.7.13"
    )
  )
