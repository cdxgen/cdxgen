package corpus.crypto

object Main {
  def main(args: Array[String]): Unit = {
    val data = args.mkString.getBytes
    BouncyCastleOps.register()
    println(JcaOps.sha256(data).length + BouncyCastleOps.sha3(data).length)
    println(TokenOps.sign("secret-from-env"))
  }
}
