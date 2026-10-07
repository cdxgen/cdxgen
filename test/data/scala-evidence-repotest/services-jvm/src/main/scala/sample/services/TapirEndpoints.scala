package sample.services

import sttp.tapir._

object TapirEndpoints {
  val getItem = endpoint.get.in("api" / "v1" / "items" / path[Long]("id")).out(stringBody)
  val createItem = endpoint.post.in("api" / "v1" / "items").in(stringBody).out(stringBody)
}
