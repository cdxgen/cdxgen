package sample.cross

import upickle.default._

final case class Envelope(id: String, digest: String) derives ReadWriter

object Envelope {
  def seal(id: String, body: String): String =
    write(Envelope(id, Platform.digestHex(body)))
}
