package controllers

import javax.inject._

import scala.concurrent.ExecutionContext

import play.api.libs.json.Json
import play.api.mvc._
import services.PaymentsClient

@Singleton
class AccountController @Inject() (cc: ControllerComponents, payments: PaymentsClient)(implicit ec: ExecutionContext)
    extends AbstractController(cc) {

  def show(id: Long): Action[AnyContent] = Action { // @expect frame cs=play-show n=1
    Ok(Json.obj("id" -> id)) // @expect sink cs=play-show lib=org.playframework:play-json
  }

  def create(): Action[AnyContent] = Action.async { request =>
    payments.charge(request.body.asText.getOrElse("")).map(r => Created(r)) // @expect frame cs=play-create n=1
  }

  def file(path: String): Action[AnyContent] = Action {
    Ok.sendFile(new java.io.File("/srv/files", path))
  }
}

@Singleton
class AdminController @Inject() (cc: ControllerComponents) extends AbstractController(cc) {
  def stats(): Action[AnyContent] = Action(Ok("stats"))
}
