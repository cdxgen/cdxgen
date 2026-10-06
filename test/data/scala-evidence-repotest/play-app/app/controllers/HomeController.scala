package controllers

import javax.inject._
import play.api.mvc._

@Singleton
class HomeController @Inject() (cc: ControllerComponents) extends AbstractController(cc) {
  def index(): Action[AnyContent] = Action { // @expect use lib=org.playframework:play
    Ok("home")
  }
}
