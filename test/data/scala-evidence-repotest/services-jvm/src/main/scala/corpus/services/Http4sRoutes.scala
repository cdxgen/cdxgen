package corpus.services

import cats.effect.IO
import org.http4s.HttpRoutes
import org.http4s.dsl.io._
import org.http4s.server.Router

object Http4sRoutes {
  val users: HttpRoutes[IO] = HttpRoutes.of[IO] {
    case GET -> Root / "users" / IntVar(id) => Ok(s"user $id") // @expect endpoint method=GET path=/api/users/{id} fw=http4s
    case req @ POST -> Root / "users" => req.as[String].flatMap(body => Created(body)) // @expect endpoint method=POST path=/api/users fw=http4s
    case DELETE -> Root / "users" / IntVar(_) => NoContent() // @expect endpoint method=DELETE path=/api/users/{id} fw=http4s
  }

  val app = Router("/api" -> users)

  val docs = "GET /not/a/route is only text" // @expect neg endpoint path=/not/a/route
}
