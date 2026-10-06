package corpus.services

import cats.effect.IO
import org.http4s.ember.client.EmberClientBuilder
import org.http4s.implicits._

object Http4sClients {
  def charge(): IO[String] =
    EmberClientBuilder.default[IO].build.use(_.expect[String](uri"https://payments.example.com/v2/charges")) // @expect outbound url=https://payments.example.com/v2/charges client=http4s
}
