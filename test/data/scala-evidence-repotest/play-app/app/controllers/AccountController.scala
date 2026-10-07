package controllers

import javax.inject._

import scala.concurrent.ExecutionContext

import play.api.libs.json.Json
import play.api.mvc._
import services.PaymentsClient

@Singleton
class AccountController @Inject() (cc: ControllerComponents, payments: PaymentsClient)(implicit ec: ExecutionContext)
    extends AbstractController(cc) {

  def show(id: Long): Action[AnyContent] = Action {
    Ok(Json.obj("id" -> id))
  }

  def create(): Action[AnyContent] = Action.async { request =>
    payments.charge(request.body.asText.getOrElse("")).map(r => Created(r))
  }

  def file(path: String): Action[AnyContent] = Action {
    Ok.sendFile(new java.io.File("/srv/files", path))
  }
}

@Singleton
class AdminController @Inject() (cc: ControllerComponents) extends AbstractController(cc) {
  def stats(): Action[AnyContent] = Action(Ok("stats"))
}
