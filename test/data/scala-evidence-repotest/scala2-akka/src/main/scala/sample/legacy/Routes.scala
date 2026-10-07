package sample.legacy

import java.security.MessageDigest

import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.server.Route

object Routes {
  val route: Route =
    pathPrefix("legacy") {
      path("users" / Segment) { name =>
        get {
          complete(Store.find(name))
        }
      } ~
        path("hash") {
          post {
            entity(as[String]) { body =>
              complete(MessageDigest.getInstance("SHA-1").digest(body.getBytes).length.toString)
            }
          }
        }
    }
}
