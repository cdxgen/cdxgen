package sample.services

import zio.http._

object ZioRoutes {
  val routes = Routes(
    Method.GET / "zio" / "health" -> handler(Response.text("ok")),
    Method.GET / "zio" / "users" / int("id") -> handler { (id: Int, _: Request) => Response.text(s"user $id") }
  )
}
