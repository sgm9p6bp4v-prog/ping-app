.PHONY: help venv install install-dev run lock test lint format check clean

PY := python3
VENV := .venv
BIN := $(VENV)/bin

help:
	@echo "make venv         create .venv (Python $$($(PY) --version))"
	@echo "make install      install runtime deps (requirements.txt)"
	@echo "make install-dev  install dev deps (requirements-dev.txt)"
	@echo "make run          start dev server on http://127.0.0.1:8000"
	@echo "make lock         recompile lockfiles via pip-tools"
	@echo "make test         run pytest"
	@echo "make lint         run ruff lint"
	@echo "make format       run ruff format + black"
	@echo "make check        lint + test"
	@echo "make clean        remove venv + caches"

venv:
	$(PY) -m venv $(VENV)
	$(BIN)/pip install --upgrade pip

install: venv
	$(BIN)/pip install -r requirements.txt

install-dev: venv
	$(BIN)/pip install -r requirements-dev.txt

lock: venv
	$(BIN)/pip install pip-tools
	$(BIN)/pip-compile --output-file=requirements.txt requirements.in
	$(BIN)/pip-compile --output-file=requirements-dev.txt requirements-dev.in

test:
	$(BIN)/pytest

run:
	PYTHONPATH=src PING_BIND_HOST=127.0.0.1 PING_PORT=8000 \
	  $(BIN)/uvicorn netping.app:app --reload --app-dir src --host 127.0.0.1 --port 8000

lint:
	$(BIN)/ruff check .

format:
	$(BIN)/ruff check --fix .
	$(BIN)/ruff format .

check: lint test

clean:
	rm -rf $(VENV) .pytest_cache .ruff_cache **/__pycache__
