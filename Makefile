.DEFAULT_GOAL := check

UV ?= uv

.PHONY: setup check generate

setup:
	$(UV) sync --locked

check:
	$(UV) run --locked python verify_contracts.py

generate:
	$(UV) run --locked python build_contracts.py
