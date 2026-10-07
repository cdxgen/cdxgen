package sample.crypto

import java.security.MessageDigest

trait Hasher:
  def hash(bytes: Array[Byte]): Array[Byte]

object Scala3Crypto:
  inline val Sha512 = "SHA-512"

  given sha512Hasher: Hasher with
    def hash(bytes: Array[Byte]): Array[Byte] = MessageDigest.getInstance(Sha512).digest(bytes)

  extension (s: String) def sha384: Array[Byte] = MessageDigest.getInstance("SHA-384").digest(s.getBytes)

  def hashWith(bytes: Array[Byte])(using h: Hasher): Array[Byte] = h.hash(bytes)
