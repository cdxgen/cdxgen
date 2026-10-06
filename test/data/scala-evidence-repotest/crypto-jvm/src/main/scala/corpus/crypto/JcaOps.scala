package corpus.crypto

import java.security.{KeyPairGenerator, KeyStore, MessageDigest, SecureRandom, Signature}
import java.security.spec.ECGenParameterSpec
import javax.crypto.{Cipher, KeyGenerator, Mac, SecretKeyFactory}
import javax.crypto.spec.{GCMParameterSpec, PBEKeySpec, SecretKeySpec}
import javax.net.ssl.SSLContext

object JcaOps {
  final val CbcTransform = "AES/CBC/PKCS5Padding"

  def aesGcmEncrypt(key: Array[Byte], iv: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding") // @expect crypto alg=AES/GCM/NoPadding
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv))
    cipher.doFinal(data)
  }

  def desEncrypt(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance("DES/ECB/PKCS5Padding") // @expect crypto alg=DES/ECB/PKCS5Padding weak=true
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "DES"))
    cipher.doFinal(data)
  }

  def cbcViaConstant(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val cipher = Cipher.getInstance(CbcTransform) // @expect crypto alg=AES/CBC/PKCS5Padding via=constant
    cipher.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"))
    cipher.doFinal(data)
  }

  def md5(data: Array[Byte]): Array[Byte] = MessageDigest.getInstance("MD5").digest(data) // @expect crypto alg=MD5 weak=true

  def sha256(data: Array[Byte]): Array[Byte] = MessageDigest.getInstance("SHA-256").digest(data) // @expect crypto alg=SHA-256

  def digestWith(alg: String, data: Array[Byte]): Array[Byte] = MessageDigest.getInstance(alg).digest(data)

  def legacyFingerprint(data: Array[Byte]): Array[Byte] = digestWith("SHA-1", data) // @expect crypto alg=SHA-1 via=argument weak=true

  // DEC-14 bound: a literal is followed across at most 4 call or local-val boundaries.
  private def hop1(alg: String, d: Array[Byte]): Array[Byte] = MessageDigest.getInstance(alg).digest(d)
  private def hop2(alg: String, d: Array[Byte]): Array[Byte] = hop1(alg, d)
  private def hop3(alg: String, d: Array[Byte]): Array[Byte] = hop2(alg, d)
  private def hop4(alg: String, d: Array[Byte]): Array[Byte] = hop3(alg, d)
  private def hop5(alg: String, d: Array[Byte]): Array[Byte] = hop4(alg, d)

  def viaLocalAndTwoCalls(d: Array[Byte]): Array[Byte] = {
    val alg = "SHA-512" // @expect crypto alg=SHA-512 via=argument depth=3
    hop2(alg, d)
  }

  def viaFourCalls(d: Array[Byte]): Array[Byte] = hop4("SHA-384", d) // @expect crypto alg=SHA-384 via=argument depth=4

  def viaFiveCalls(d: Array[Byte]): Array[Byte] = hop5("SHA-224", d) // @expect neg crypto alg=SHA-224

  def hmac(key: Array[Byte], data: Array[Byte]): Array[Byte] = {
    val mac = Mac.getInstance("HmacSHA256") // @expect crypto alg=HmacSHA256
    mac.init(new SecretKeySpec(key, "HmacSHA256"))
    mac.doFinal(data)
  }

  def rsaKeyPair(): java.security.KeyPair = {
    val kpg = KeyPairGenerator.getInstance("RSA") // @expect crypto alg=RSA keySize=2048
    kpg.initialize(2048)
    kpg.generateKeyPair()
  }

  def ecSign(data: Array[Byte]): Array[Byte] = {
    val kpg = KeyPairGenerator.getInstance("EC") // @expect crypto alg=EC curve=secp256r1
    kpg.initialize(new ECGenParameterSpec("secp256r1"))
    val pair = kpg.generateKeyPair()
    val signer = Signature.getInstance("SHA256withECDSA") // @expect crypto alg=SHA256withECDSA
    signer.initSign(pair.getPrivate)
    signer.update(data)
    signer.sign()
  }

  def pbkdf2(password: Array[Char], salt: Array[Byte]): Array[Byte] = {
    val factory = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256") // @expect crypto alg=PBKDF2WithHmacSHA256
    factory.generateSecret(new PBEKeySpec(password, salt, 310000, 256)).getEncoded
  }

  def newAesKey(): javax.crypto.SecretKey = {
    val gen = KeyGenerator.getInstance("AES") // @expect crypto alg=AES keySize=256
    gen.init(256)
    gen.generateKey()
  }

  def strongRandom(): SecureRandom = SecureRandom.getInstanceStrong() // @expect crypto alg=DRBG kind=rng

  def tls(): SSLContext = SSLContext.getInstance("TLSv1.3") // @expect crypto alg=TLSv1.3 kind=protocol

  def keystore(): KeyStore = KeyStore.getInstance("PKCS12") // @expect crypto alg=PKCS12 kind=keystore

  def describe(): String = "Data at rest uses AES and RSA" // @expect neg crypto alg=AES
}
