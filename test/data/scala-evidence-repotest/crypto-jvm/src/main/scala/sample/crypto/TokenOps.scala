package sample.crypto

import at.favre.lib.crypto.bcrypt.BCrypt
import pdi.jwt.{Jwt, JwtAlgorithm, JwtClaim}

object TokenOps {
  def sign(secret: String): String =
    Jwt.encode(JwtClaim("{\"sub\":\"svc\"}"), secret, JwtAlgorithm.HS256)

  def verify(token: String, secret: String): Boolean =
    Jwt.isValid(token, secret, Seq(JwtAlgorithm.HS512))

  def hashPassword(password: String): String =
    BCrypt.withDefaults().hashToString(12, password.toCharArray)
}
