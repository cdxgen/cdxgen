package sample.services

import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object PekkoRoutes {
  val route: Route =
    pathPrefix("orders") {
      concat(
        path(LongNumber) { id => get { complete(s"order $id") } },
        pathEnd { post { entity(as[String]) { body => complete(body) } } }
      )
    } ~ path("health") { get { complete("ok") } }
}
