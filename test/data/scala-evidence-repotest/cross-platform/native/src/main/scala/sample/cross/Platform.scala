package sample.cross

import scala.scalanative.unsafe._

@link("crypto")
@extern
object libcrypto {
  def SHA512(data: CString, len: CSize, out: Ptr[Byte]): Ptr[Byte] = extern
}

object Platform {
  def digestHex(body: String): String = Zone.acquire { implicit z =>
    val out = alloc[Byte](64)
    libcrypto.SHA512(toCString(body), scala.scalanative.unsigned.UnsignedRichInt(body.length).toCSize, out)
    (0 until 64).map(i => f"${out(i)}%02x").mkString
  }
}
