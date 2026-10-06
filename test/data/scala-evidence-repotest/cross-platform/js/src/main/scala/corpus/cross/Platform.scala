package corpus.cross

import scala.scalajs.js

object Platform {
  def digestHex(body: String): String = {
    val crypto = js.Dynamic.global.require("crypto")
    crypto.createHash("sha1").update(body).digest("hex").asInstanceOf[String] // @expect crypto alg=SHA-1 platforms=js weak=true
  }
}
