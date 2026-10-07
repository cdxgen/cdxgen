package sample.crypto

import java.security.{KeyPairGenerator, KeyStore, MessageDigest, SecureRandom, Signature}
import java.security.spec.ECGenParameterSpec
import javax.crypto.{Cipher, KeyGenerator, Mac, SecretKeyFactory}
import javax.crypto.spec.{GCMParameterSpec, PBEKeySpec, SecretKeySpec}
import javax.net.ssl.SSLContext

object JcaOps {
  final val CbcTransform = "AES/CBC/PKCS5Padding"

  def aesGcmEncrypt(key: Array[Byte], iv: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv))
    cipher.doFinal(data)
  }

  def desEncrypt(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance("DES/ECB/PKCS5Padding")
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "DES"))
    cipher.doFinal(data)
  }

  def cbcViaConstant(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance(CbcTransform)
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"))
    cipher.doFinal(data)
  }

  def md5(data: Array[Byte]): Array[Byte] = MessageDigest.getInstance("MD5").digest(data)

  def sha256(data: Array[Byte]): Array[Byte] = MessageDigest.getInstance("SHA-256").digest(data)

  def digestWith(alg: String, data: Array[Byte]): Array[Byte] = MessageDigest.getInstance(alg).digest(data)

  def legacyFingerprint(data: Array[Byte]): Array[Byte] = digestWith("SHA-1", data)

  // A literal is followed across at most four call or local value boundaries.
  private def hop1(alg: String, d: Array[Byte]): Array[Byte] = MessageDigest.getInstance(alg).digest(d)
  private def hop2(alg: String, d: Array[Byte]): Array[Byte] = hop1(alg, d)
  private def hop3(alg: String, d: Array[Byte]): Array[Byte] = hop2(alg, d)
  private def hop4(alg: String, d: Array[Byte]): Array[Byte] = hop3(alg, d)
  private def hop5(alg: String, d: Array[Byte]): Array[Byte] = hop4(alg, d)

  def viaLocalAndTwoCalls(d: Array[Byte]): Array[Byte] = {
    val alg = "SHA-512"
    hop2(alg, d)
  }

  def viaFourCalls(d: Array[Byte]): Array[Byte] = hop4("SHA-384", d)

  def viaFiveCalls(d: Array[Byte]): Array[Byte] = hop5("SHA-224", d)

  def hmac(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(new SecretKeySpec(key, "HmacSHA256"))
    mac.doFinal(data)
  }

  def rsaKeyPair(): java.security.KeyPair = {
    val kpg = KeyPairGenerator.getInstance("RSA")
    kpg.initialize(2048)
    kpg.generateKeyPair()
  }

  def ecSign(data: Array[Byte]): Array[Byte] = {
    val kpg = KeyPairGenerator.getInstance("EC")
    kpg.initialize(new ECGenParameterSpec("secp256r1"))
    val pair = kpg.generateKeyPair()
    val signer = Signature.getInstance("SHA256withECDSA")
    signer.initSign(pair.getPrivate)
    signer.update(data)
    signer.sign()
  }

  def pbkdf2(password: Array[Char], salt: Array[Byte]): Array[Byte] = {
    val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256")
    factory.generateSecret(new PBEKeySpec(password, salt, 310000, 256)).getEncoded
  }

  def newAesKey(): javax.crypto.SecretKey = {
    val gen = KeyGenerator.getInstance("AES")
    gen.init(256)
    gen.generateKey()
  }

  def strongRandom(): SecureRandom = SecureRandom.getInstanceStrong()

  def tls(): SSLContext = SSLContext.getInstance("TLSv1.3")

  def keystore(): KeyStore = KeyStore.getInstance("PKCS12")

  def describe(): String = "Data at rest uses AES and RSA"
}
