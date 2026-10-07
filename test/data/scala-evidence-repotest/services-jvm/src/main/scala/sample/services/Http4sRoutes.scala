package sample.services

import cats.effect.IO
import org.http4s.HttpRoutes
import org.http4s.dsl.io._
import org.http4s.server.Router

object Http4sRoutes {
  val users: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "users" / IntVar(id) => Ok(s"user $id")
    case req @ POST -> Root / "users" => req.as[String].flatMap(body => Created(body))
    case DELETE -> Root / "users" / IntVar(_) => NoContent()
  }

  val app = Router("/api" -> users)

  val docs = "GET /not/a/route is only text"
}
