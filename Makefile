IMAGE ?= ghcr.io/codemk8/chorus
TAG ?= latest
DOCKER ?= docker

.DEFAULT_GOAL := help

.PHONY: help build push build-push

help:
	@echo "Docker targets:"
	@echo "  make build                 Build $(IMAGE):$(TAG)"
	@echo "  make push                  Push $(IMAGE):$(TAG)"
	@echo "  make build-push            Build and push $(IMAGE):$(TAG)"
	@echo
	@echo "Override the destination with IMAGE and TAG:"
	@echo "  make build-push IMAGE=ghcr.io/owner/chorus TAG=v1.2.3"

build:
	$(DOCKER) build --tag "$(IMAGE):$(TAG)" .

push:
	$(DOCKER) push "$(IMAGE):$(TAG)"

build-push: build
	$(DOCKER) push "$(IMAGE):$(TAG)"
