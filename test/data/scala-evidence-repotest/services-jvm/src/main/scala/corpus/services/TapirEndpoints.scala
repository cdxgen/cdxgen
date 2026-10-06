package corpus.services

import sttp.tapir._

object TapirEndpoints {
  val getItem = endpoint.get.in("api" / "v1" / "items" / path[Long]("id")).out(stringBody) // @expect endpoint method=GET path=/api/v1/items/{id} fw=tapir
  val createItem = endpoint.post.in("api" / "v1" / "items").in(stringBody).out(stringBody) // @expect endpoint method=POST path=/api/v1/items fw=tapir
}
