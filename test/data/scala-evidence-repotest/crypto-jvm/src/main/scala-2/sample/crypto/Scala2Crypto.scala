package sample.crypto

import java.security.MessageDigest

trait Hasher {
  def hash(bytes: Array[Byte]): Array[Byte]
}

object Scala2Crypto {
  implicit val sha512Hasher: Hasher = new Hasher {
    def hash(bytes: Array[Byte]): Array[Byte] = MessageDigest.getInstance("SHA-512").digest(bytes)
  }

  implicit class StringDigest(val s: String) extends AnyVal {
    def sha384: Array[Byte] = MessageDigest.getInstance("SHA-384").digest(s.getBytes)
  }

  def hashWith(bytes: Array[Byte])(implicit h: Hasher): Array[Byte] = h.hash(bytes)
}
