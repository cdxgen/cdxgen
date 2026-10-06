package corpus.services

import java.net.URI
import java.net.http.{HttpClient, HttpResponse, HttpRequest => JHttpRequest}

import scala.concurrent.Future

import org.apache.pekko.actor.ActorSystem
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.http.scaladsl.model.{HttpRequest => PHttpRequest, HttpResponse => PHttpResponse}

object OutboundClients {
  def token(): String = {
    val req = JHttpRequest.newBuilder(URI.create("https://auth.example.com/oauth/token")).GET().build() // @expect outbound url=https://auth.example.com/oauth/token client=java.net.http
    HttpClient.newHttpClient().send(req, HttpResponse.BodyHandlers.ofString()).body()
  }

  def stock(system: ActorSystem): Future[PHttpResponse] =
    Http()(system).singleRequest(PHttpRequest(uri = "https://inventory.example.com/api/stock")) // @expect outbound url=https://inventory.example.com/api/stock client=pekko-http
}
