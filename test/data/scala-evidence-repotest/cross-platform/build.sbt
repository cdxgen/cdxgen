// Cross-platform ground-truth fixture: one shared module compiled for JVM, JS and Native,
// with a platform-specific digest implementation in each platform directory.
import sbtcrossproject.CrossPlugin.autoImport.{crossProject, CrossType}

ThisBuild / organization := "sample.scala"
ThisBuild / version := "0.1.0"
ThisBuild / scalaVersion := "3.3.7"

lazy val core = crossProject(JVMPlatform, JSPlatform, NativePlatform)
  .crossType(CrossType.Full)
  .in(file("."))
  .settings(
    name := "cross-core",
    libraryDependencies += "com.lihaoyi" %%% "upickle" % "4.4.3"
  )
  .jsSettings(libraryDependencies += "org.scala-js" %%% "scalajs-dom" % "2.8.1")
