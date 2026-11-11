import hashlib
import json

import requests


def compute_digest(payload):
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def read_config(path):
    with open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def process_record(payload):
    digest = compute_digest(payload)
    return digest


def check_url(url):
    response = requests.get(url, timeout=5)
    return response.status_code == 200
