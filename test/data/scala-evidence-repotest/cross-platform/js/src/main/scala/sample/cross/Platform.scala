package sample.cross

import scala.scalajs.js

object Platform {
  def digestHex(body: String): String = {
    val crypto = js.Dynamic.global.require("crypto")
    crypto.createHash("sha1").update(body).digest("hex").asInstanceOf[String]
  }
}
