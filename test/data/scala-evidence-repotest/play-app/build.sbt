// Play ground-truth fixture: conf/routes (including a `->` sub-router), controllers, WS client, signed cookies.
ThisBuild / organization := "corpus.scala"
ThisBuild / version := "0.1.0"
lazy val scala3 = "3.3.7"
lazy val scala213 = "2.13.18"

lazy val root = (project in file("."))
  .enablePlugins(PlayScala)
  .settings(
    name := "play-app",
    scalaVersion := scala3,
    crossScalaVersions := Seq(scala3, scala213),
    libraryDependencies ++= Seq(guice, ws)
  )
