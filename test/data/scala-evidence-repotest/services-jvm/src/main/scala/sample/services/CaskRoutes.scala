package sample.services

object CaskRoutes extends cask.MainRoutes {
  @cask.get("/cask/hello/:name")
  def hello(name: String): String = s"Hello $name"

  @cask.post("/cask/echo")
  def echo(request: cask.Request): String = request.text()

  initialize()
}
