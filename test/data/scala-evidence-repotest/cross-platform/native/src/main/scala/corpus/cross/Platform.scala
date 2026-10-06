package corpus.cross

import scala.scalanative.unsafe._

@link("crypto")
@extern
object libcrypto {
  def SHA512(data: CString, len: CSize, out: Ptr[Byte]): Ptr[Byte] = extern // @expect crypto alg=SHA-512 kind=native-binding platforms=native
}

object Platform {
  def digestHex(body: String): String = Zone.acquire { implicit z =>
    val out = alloc[Byte](64)
    libcrypto.SHA512(toCString(body), scala.scalanative.unsigned.UnsignedRichInt(body.length).toCSize, out) // @expect crypto alg=SHA-512 kind=native-call platforms=native
    (0 until 64).map(i => f"${out(i)}%02x").mkString
  }
}
