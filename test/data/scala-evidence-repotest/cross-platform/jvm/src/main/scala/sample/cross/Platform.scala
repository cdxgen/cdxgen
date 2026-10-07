package sample.cross

import java.security.MessageDigest

object Platform {
  def digestHex(body: String): String =
    MessageDigest.getInstance("SHA-256").digest(body.getBytes("UTF-8")).map("%02x".format(_)).mkString
}
