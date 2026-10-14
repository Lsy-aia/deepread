#!/usr/bin/env bash
# DeepRead helper: run a lightweight (CRF-only, CPU) GROBID server in Docker, bound to 127.0.0.1:8070.
# Usage: scripts/grobid.sh start|stop|status
# License: AGPL-3.0-or-later
set -euo pipefail

NAME="${DEEPREAD_GROBID_NAME:-deepread-grobid}"
IMAGE="${DEEPREAD_GROBID_IMAGE:-grobid/grobid:0.9.1-crf}"   # official CRF-only image (~0.5 GB compressed)
PORT="${DEEPREAD_GROBID_PORT:-8070}"
URL="http://127.0.0.1:${PORT}"

alive() { [ "$(curl -s -m 3 "${URL}/api/isalive" 2>/dev/null || true)" = "true" ]; }

case "${1:-}" in
  start)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "Container $NAME already running."
    elif docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker start "$NAME" >/dev/null
    else
      echo "Pulling/starting $IMAGE ..."
      docker run -d --name "$NAME" --restart unless-stopped \
        -p "127.0.0.1:${PORT}:8070" --init --ulimit core=0 "$IMAGE" >/dev/null
    fi
    echo -n "Waiting for GROBID"
    for _ in $(seq 1 90); do
      if alive; then echo; echo "GROBID is up at ${URL} (version: $(curl -s "${URL}/api/version"))"; break; fi
      echo -n "."; sleep 2
    done
    alive || { echo; echo "Not ready yet; check: docker logs $NAME"; exit 1; }
    echo "Memory: the CRF-only image typically uses ~1-2 GB RAM at idle/under load (more with many parallel PDFs)."
    echo "Set a cap with: docker update --memory 3g --memory-swap 3g $NAME"
    echo "Set DeepRead's parser.grobidURL to ${URL}."
    ;;
  stop)
    docker stop "$NAME" >/dev/null 2>&1 && echo "Stopped $NAME." || echo "$NAME is not running."
    echo "(Remove it entirely with: docker rm $NAME)"
    ;;
  status)
    if docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
      echo "container: running"
      docker stats --no-stream --format 'memory: {{.MemUsage}}  cpu: {{.CPUPerc}}' "$NAME" || true
      if alive; then echo "api: alive, version $(curl -s "${URL}/api/version")"; else echo "api: not responding at ${URL}"; fi
    else
      echo "container: not running"; exit 1
    fi
    ;;
  *) echo "Usage: $0 start|stop|status"; exit 2 ;;
esac
