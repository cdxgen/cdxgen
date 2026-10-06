package corpus.services

import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

object PekkoRoutes {
  val route: Route =
    pathPrefix("orders") {
      concat(
        path(LongNumber) { id => get { complete(s"order $id") } }, // @expect endpoint method=GET path=/orders/{id} fw=pekko-http
        pathEnd { post { entity(as[String]) { body => complete(body) } } } // @expect endpoint method=POST path=/orders fw=pekko-http
      )
    } ~ path("health") { get { complete("ok") } } // @expect endpoint method=GET path=/health fw=pekko-http
}
