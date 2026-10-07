// Crypto ground-truth fixture: JCA, BouncyCastle, jwt-scala and favre bcrypt call sites.
// Every expected finding carries an inline `
ThisBuild / organization := "sample.scala"
ThisBuild / version := "0.1.0"
lazy val scala3 = "3.3.7"
lazy val scala213 = "2.13.18"
ThisBuild / scalaVersion := scala3
ThisBuild / crossScalaVersions := Seq(scala3, scala213)

lazy val root = (project in file("."))
  .settings(
    name := "crypto-jvm",
    libraryDependencies ++= Seq(
      "org.bouncycastle" % "bcprov-jdk18on" % "1.86",
      "com.github.jwt-scala" %% "jwt-core" % "11.0.4",
      "at.favre.lib" % "bcrypt" % "0.10.2"
    )
  )
