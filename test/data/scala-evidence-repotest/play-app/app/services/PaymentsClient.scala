package services

import java.security.MessageDigest
import javax.inject._

import scala.concurrent.{ExecutionContext, Future}

import play.api.Configuration
import play.api.libs.ws.WSClient
import play.api.libs.ws.DefaultBodyWritables._

@Singleton
class PaymentsClient @Inject() (ws: WSClient, config: Configuration)(implicit ec: ExecutionContext) {
  private val endpoint = config.get[String]("payments.url")

  def charge(body: String): Future[String] = {
    val idempotency = MessageDigest.getInstance("SHA-1").digest(body.getBytes).map("%02x".format(_)).mkString // @expect crypto alg=SHA-1 weak=true
    ws.url(endpoint).addHttpHeaders("Idempotency-Key" -> idempotency).post(body).map(_.body) // @expect sink cs=play-create lib=org.playframework:play-ws-standalone
  }

  def health(): Future[Int] = ws.url("https://status.stripe.com/api/v2/status.json").get().map(_.status) // @expect outbound url=https://status.stripe.com/api/v2/status.json client=play-ws
}
