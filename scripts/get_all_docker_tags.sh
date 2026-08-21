#!/bin/bash
REGISTRY="image-local.int.shaut.us"
IMAGE_NAME="homelab-backstage"

curl -s "https://${REGISTRY}/v2/${IMAGE_NAME}/tags/list" | jq .
