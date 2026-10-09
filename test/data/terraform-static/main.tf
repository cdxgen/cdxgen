terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "6.10.0"
    }
  }
}

module "s3_bucket" {
  source  = "terraform-aws-modules/s3-bucket/aws"
  version = "= 4.2.1"
}

module "iam" {
  source  = "terraform-aws-modules/iam/aws"
  version = ">= 5.0, < 6.0"
}

module "consul" {
  source = "hashicorp/consul/aws//modules/consul-cluster"
}

module "network" {
  source = "git::ssh://git@example.com/platform/network.git//modules/vpc?ref=main"
}

module "dns" {
  source = "github.com/acme/terraform-modules//dns?ref=3d8f2c9a1b07e645f2c9ab8d0e1f23456789abcd"
}

module "vpc_archive" {
  source = "https://artifacts.example.com/modules/vpc-1.4.0.zip?checksum=sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
}

module "db" {
  source = "git::https://ci-bot:S3cr3tP4ss@git.example.com/infra/db.git?ref=v2.0.0&sshkey=U1NIS0VZ"
}

module "dynamic" {
  source = var.module_source
}

module "local_sub" {
  source = "./sub"
}
