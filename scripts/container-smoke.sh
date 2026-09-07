#!/usr/bin/env bash
set -euo pipefail
image=${1:-mc-panel:ci}
data=$(mktemp -d)
name="mcpanel-smoke-$(basename "$data" | tr '[:upper:]' '[:lower:]')"
cleanup() {
  docker logs "$name" 2>/dev/null || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  rm -rf "$data"
}
trap cleanup EXIT
start() {
  docker run -d --init --user "$(id -u):$(id -g)" --name "$name" -p 127.0.0.1::16824 \
    --mount "type=bind,source=$data,target=/data" "$image" >/dev/null
  port=$(docker port "$name" 16824/tcp | head -1 | cut -d: -f2)
  url="http://127.0.0.1:$port"
  for _ in $(seq 1 60); do
    if curl -fsS "$url/api/health" >/dev/null; then return; fi
    sleep 1
  done
  echo 'Container did not become healthy' >&2
  return 1
}
start
curl -fsS "$url/" | grep -q '/assets/'
curl -fsS "$url/api/auth/bootstrap" | python3 -c 'import json,sys; assert json.load(sys.stdin)["needs_setup"]'
curl -fsS -H 'Content-Type: application/json' -d '{"username":"smokeowner","password":"smoke-test-password"}' "$url/api/auth/setup" >/dev/null
docker exec "$name" java -version
docker exec "$name" /opt/java/openjdk/bin/java -version
docker exec "$name" python -c 'import mcdreforged, pip, scipy; from pathlib import Path; Path("/data/persistence-check").write_text("keep")'
test -s "$data/panel.db"
test -s "$data/secret.key"
docker stop -t 90 "$name" >/dev/null
# Uvicorn re-raises SIGTERM after lifespan shutdown; Tini reports 128 + 15.
case "$(docker inspect -f '{{.State.ExitCode}}' "$name")" in
  0|143) ;;
  *) echo 'Unexpected container exit' >&2; exit 1 ;;
esac
docker logs "$name" 2>&1 | grep -F '[shutdown] Instance shutdown complete'
docker rm "$name" >/dev/null
start
curl -fsS "$url/api/auth/bootstrap" | python3 -c 'import json,sys; assert not json.load(sys.stdin)["needs_setup"]'
docker exec "$name" python -c 'from pathlib import Path; assert Path("/data/persistence-check").read_text() == "keep"'
echo 'Container smoke test passed'
