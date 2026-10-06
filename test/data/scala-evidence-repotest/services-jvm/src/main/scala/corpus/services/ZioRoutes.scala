package corpus.services

import zio.http._

object ZioRoutes {
  val routes = Routes(
    Method.GET / "zio" / "health" -> handler(Response.text("ok")), // @expect endpoint method=GET path=/zio/health fw=zio-http
    Method.GET / "zio" / "users" / int("id") -> handler { (id: Int, _: Request) => Response.text(s"user $id") } // @expect endpoint method=GET path=/zio/users/{id} fw=zio-http
  )
}
