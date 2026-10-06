package corpus.crypto

import java.security.MessageDigest

trait Hasher:
  def hash(bytes: Array[Byte]): Array[Byte]

object Scala3Crypto:
  inline val Sha512 = "SHA-512"

  given sha512Hasher: Hasher with
    def hash(bytes: Array[Byte]): Array[Byte] = MessageDigest.getInstance(Sha512).digest(bytes) // @expect crypto alg=SHA-512 via=inline

  extension (s: String) def sha384: Array[Byte] = MessageDigest.getInstance("SHA-384").digest(s.getBytes) // @expect crypto alg=SHA-384

  def hashWith(bytes: Array[Byte])(using h: Hasher): Array[Byte] = h.hash(bytes)
