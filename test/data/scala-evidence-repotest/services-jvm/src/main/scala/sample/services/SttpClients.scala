package sample.services

import sttp.client4._

object SttpClients {
  final val ConfigBase = "https://config.example.com"

  def github(): String = {
    val backend = DefaultSyncBackend()
    basicRequest.get(uri"https://api.github.com/repos/scala/scala3").send(backend).body.fold(e => e, b => b)
  }

  def settings(): String = {
    val backend = DefaultSyncBackend()
    basicRequest.get(uri"$ConfigBase/v1/settings").send(backend).body.fold(e => e, b => b)
  }
}
