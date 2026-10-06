package corpus.crypto

import java.security.Security
import org.bouncycastle.crypto.digests.SHA3Digest
import org.bouncycastle.crypto.generators.Argon2BytesGenerator
import org.bouncycastle.crypto.params.Argon2Parameters
import org.bouncycastle.jce.provider.BouncyCastleProvider

object BouncyCastleOps {
  def register(): Unit = Security.addProvider(new BouncyCastleProvider()) // @expect use lib=org.bouncycastle:bcprov-jdk18on

  def sha3(data: Array[Byte]): Array[Byte] = {
    val digest = new SHA3Digest(256) // @expect crypto alg=SHA3-256 lib=org.bouncycastle:bcprov-jdk18on
    digest.update(data, 0, data.length)
    val out = new Array[Byte](32)
    digest.doFinal(out, 0)
    out
  }

  def argon2(password: Array[Byte], salt: Array[Byte]): Array[Byte] = {
    val params = new Argon2Parameters.Builder(Argon2Parameters.ARGON2_id).withSalt(salt).withIterations(3).build() // @expect crypto alg=Argon2id lib=org.bouncycastle:bcprov-jdk18on
    val generator = new Argon2BytesGenerator() // @expect use lib=org.bouncycastle:bcprov-jdk18on
    generator.init(params)
    val out = new Array[Byte](32)
    generator.generateBytes(password, out)
    out
  }

  def chacha(): javax.crypto.Cipher = javax.crypto.Cipher.getInstance("ChaCha20-Poly1305", "BC") // @expect crypto alg=ChaCha20-Poly1305
}
