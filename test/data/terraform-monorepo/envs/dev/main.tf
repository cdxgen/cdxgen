terraform {
  required_version = ">= 1.5"
}

module "app" {
  source = "../../modules/app"
}
