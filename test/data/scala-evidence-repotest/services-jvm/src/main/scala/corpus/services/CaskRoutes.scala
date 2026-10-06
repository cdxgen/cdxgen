package corpus.services

object CaskRoutes extends cask.MainRoutes {
  @cask.get("/cask/hello/:name") // @expect endpoint method=GET path=/cask/hello/{name} fw=cask
  def hello(name: String): String = s"Hello $name"

  @cask.post("/cask/echo") // @expect endpoint method=POST path=/cask/echo fw=cask
  def echo(request: cask.Request): String = request.text()

  initialize()
}
