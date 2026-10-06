package corpus.legacy

import scala.concurrent.Await
import scala.concurrent.duration._

import akka.actor.ActorSystem
import akka.http.scaladsl.Http
import akka.http.scaladsl.model.HttpRequest
import slick.jdbc.PostgresProfile.api._

object Store {
  lazy val db = Database.forURL("jdbc:postgresql://legacy-db:5432/users", driver = "org.postgresql.Driver") // @expect datastore kind=postgresql url=jdbc:postgresql://legacy-db:5432/users

  def find(name: String): String =
    Await.result(db.run(sql"select email from users where name = $name".as[String].headOption), 5.seconds).getOrElse("") // @expect sink cs=akka-find lib=com.typesafe.slick:slick

  def audit(system: ActorSystem) =
    Http()(system).singleRequest(HttpRequest(uri = "https://audit.example.com/v1/events")) // @expect outbound url=https://audit.example.com/v1/events client=akka-http
}
