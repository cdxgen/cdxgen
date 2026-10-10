terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

module "security_group" {
  source  = "terraform-aws-modules/security-group/aws"
  version = "5.2.0"
}
