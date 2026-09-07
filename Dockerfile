# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS web
WORKDIR /build/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run lint && npm run build

FROM ghcr.io/astral-sh/uv:0.11.24 AS uv
FROM python:3.14-slim-bookworm AS dependencies
COPY --from=uv /uv /usr/local/bin/uv
WORKDIR /build
COPY pyproject.toml uv.lock ./
# Export the checked-in versions/hashes, but download from PyPI rather than the
# developer's local mirror. Keep pip available for MCDR plugin dependencies.
RUN uv export --frozen --no-dev --no-emit-project --output-file requirements.txt \
    && python -m pip install --no-cache-dir -r requirements.txt

FROM eclipse-temurin:21-jre-jammy AS java
FROM python:3.14-slim-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libstdc++6 libfontconfig1 libfreetype6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 mcpanel \
    && useradd --uid 1000 --gid 1000 --no-create-home mcpanel \
    && mkdir /data && chown 1000:1000 /data
COPY --from=java /opt/java/openjdk /opt/java/openjdk
COPY --from=dependencies /usr/local/lib/python3.14/site-packages /usr/local/lib/python3.14/site-packages
WORKDIR /app
COPY backend/app ./backend/app
COPY backend/default_config ./backend/default_config
COPY --from=web /build/web/dist ./web/dist
ENV JAVA_HOME=/opt/java/openjdk \
    PATH="/opt/java/openjdk/bin:${PATH}" \
    MCPANEL_DATA_DIR=/data \
    MCPANEL_WEB_DIST=/app/web/dist \
    PYTHONPATH=/app/backend:/data/python-packages \
    PIP_TARGET=/data/python-packages \
    PIP_NO_CACHE_DIR=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HOME=/data
USER 1000:1000
EXPOSE 16824 25565
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:16824/api/health', timeout=3)"
CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "16824", "--workers", "1"]
