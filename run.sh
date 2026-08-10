#!/usr/bin/env bash
#
# PartyMusic launcher.
# Builds and starts the synchronized music service via Docker Compose.
#
set -euo pipefail

cd "$(dirname "$0")"

PORT="${PORT:-8000}"

# --- pick a docker compose command ------------------------------------------
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "ERROR: Docker Compose is not installed. Install Docker Desktop or the docker-compose plugin." >&2
  exit 1
fi

# --- make sure the music directory exists -----------------------------------
mkdir -p music
if [ -z "$(ls -A music 2>/dev/null)" ]; then
  echo "NOTE: the ./music folder is empty."
  echo "      Add .mp3/.ogg/.wav/.flac/.m4a/.opus files there and they will appear in the playlist."
fi

usage() {
  cat <<EOF
PartyMusic — synchronized listening service

Usage: ./run.sh [command]

Commands:
  up        Build images and start the service (default)
  down      Stop and remove the containers
  logs      Follow the container logs
  restart   Restart the service
  rebuild   Rebuild images from scratch and start

Environment:
  PORT      Host port for the web UI (default: 8000)
EOF
}

cmd="${1:-up}"
case "$cmd" in
  up)
    echo "Starting PartyMusic..."
    PORT="$PORT" $COMPOSE up --build -d
    echo ""
    echo "✅ PartyMusic is running!"
    echo "   Open http://localhost:${PORT} in your browser."
    echo "   Share the same room name with friends to listen in sync."
    ;;
  down)
    $COMPOSE down
    ;;
  logs)
    $COMPOSE logs -f
    ;;
  restart)
    $COMPOSE restart
    ;;
  rebuild)
    $COMPOSE down
    $COMPOSE build --no-cache
    PORT="$PORT" $COMPOSE up -d
    echo "✅ Rebuilt and running at http://localhost:${PORT}"
    ;;
  -h|--help|help)
    usage
    ;;
  *)
    echo "Unknown command: $cmd" >&2
    usage
    exit 1
    ;;
esac
