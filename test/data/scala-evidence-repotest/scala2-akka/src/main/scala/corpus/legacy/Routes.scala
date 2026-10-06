package corpus.legacy

import java.security.MessageDigest

import akka.http.scaladsl.server.Directives._
import akka.http.scaladsl.server.Route

object Routes {
  val route: Route =
    pathPrefix("legacy") {
      path("users" / Segment) { name => // @expect endpoint method=GET path=/legacy/users/{name} fw=akka-http
        get {
          complete(Store.find(name)) // @expect frame cs=akka-find n=1
        }
      } ~
        path("hash") { // @expect endpoint method=POST path=/legacy/hash fw=akka-http
          post {
            entity(as[String]) { body =>
              complete(MessageDigest.getInstance("SHA-1").digest(body.getBytes).length.toString) // @expect crypto alg=SHA-1 weak=true
            }
          }
        }
    }
}
