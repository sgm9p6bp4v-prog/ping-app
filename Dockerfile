# Option for stricter reproducibility: pin the base image by digest
# (python:3.12-slim-bookworm@sha256:...) — deliberately not done yet, it
# couples builds to one registry snapshot and needs a refresh policy.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/src \
    PING_BIND_HOST=0.0.0.0 \
    PING_PORT=8000 \
    PING_DB_PATH=/var/lib/ping-app/ping.db

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        iproute2 \
        iputils-ping \
        libcap2-bin \
    && setcap cap_net_raw+ep /usr/bin/ping \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
# Pin pip itself — a floating `--upgrade pip` makes image builds drift.
RUN pip install --no-cache-dir 'pip==25.3' \
    && pip install --no-cache-dir -r requirements.txt

RUN addgroup --system ping-app \
    && adduser --system --ingroup ping-app --home /nonexistent --no-create-home ping-app \
    && mkdir -p /var/lib/ping-app \
    && chown -R ping-app:ping-app /var/lib/ping-app

COPY src ./src
COPY static ./static

USER ping-app

EXPOSE 8000

# `exec` makes uvicorn PID 1 so it receives SIGTERM directly on `docker stop`.
CMD ["sh", "-c", "exec uvicorn netping.app:app --host ${PING_BIND_HOST:-0.0.0.0} --port ${PING_PORT:-8000}"]
