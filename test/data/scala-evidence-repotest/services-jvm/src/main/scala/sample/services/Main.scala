package sample.services

object Main {
  def main(args: Array[String]): Unit = {
    println(Http4sRoutes.app)
    println(PekkoRoutes.route)
    println(TapirEndpoints.getItem.show)
    println(ZioRoutes.routes)
    println(SttpClients.github())
    println(DataStores.orders())
  }
}
