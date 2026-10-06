package corpus.crypto

import at.favre.lib.crypto.bcrypt.BCrypt
import pdi.jwt.{Jwt, JwtAlgorithm, JwtClaim}

object TokenOps {
  def sign(secret: String): String =
    Jwt.encode(JwtClaim("{\"sub\":\"svc\"}"), secret, JwtAlgorithm.HS256) // @expect crypto alg=HS256 lib=com.github.jwt-scala:jwt-core

  def verify(token: String, secret: String): Boolean =
    Jwt.isValid(token, secret, Seq(JwtAlgorithm.HS512)) // @expect crypto alg=HS512 lib=com.github.jwt-scala:jwt-core

  def hashPassword(password: String): String =
    BCrypt.withDefaults().hashToString(12, password.toCharArray) // @expect crypto alg=bcrypt lib=at.favre.lib:bcrypt
}
