#!/usr/bin/env bash
#
# PartyMusic — setup script for Ubuntu 22.04
# Usage: sudo bash setup.sh
#
set -euo pipefail

APP_NAME="partymusic"
APP_DIR="/opt/${APP_NAME}"
SERVICE_FILE="${APP_NAME}.service"
NODE_MIN_VERSION="18"

# ─── Colors ───
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── Root check ───
if [[ $EUID -ne 0 ]]; then
  error "This script must be run as root (use sudo)"
fi

# ─── 1. System update & prerequisites ───
info "Updating package lists..."
apt-get update -qq

info "Installing prerequisites..."
apt-get install -y -qq curl ca-certificates gnupg > /dev/null

# ─── 2. Install Node.js 18.x (if missing or too old) ───
install_node() {
  info "Installing Node.js ${NODE_MIN_VERSION}.x from NodeSource..."
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MIN_VERSION}.x" | bash - > /dev/null 2>&1
  apt-get install -y -qq nodejs > /dev/null
  info "Node.js $(node -v) installed"
}

if command -v node &> /dev/null; then
  CURRENT_NODE=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if [[ "$CURRENT_NODE" -lt "$NODE_MIN_VERSION" ]]; then
    warn "Node.js $(node -v) is too old, upgrading..."
    install_node
  else
    info "Node.js $(node -v) already installed — OK"
  fi
else
  install_node
fi

# ─── 3. Deploy application ───
info "Deploying application to ${APP_DIR}..."
mkdir -p "${APP_DIR}"

# Copy project files
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cp -r "${SCRIPT_DIR}/package.json" "${APP_DIR}/"
cp -r "${SCRIPT_DIR}/server.js"    "${APP_DIR}/"
cp -r "${SCRIPT_DIR}/public"       "${APP_DIR}/"

# Create .env if it doesn't exist
if [[ ! -f "${APP_DIR}/.env" ]]; then
  if [[ -f "${SCRIPT_DIR}/.env" ]]; then
    cp "${SCRIPT_DIR}/.env" "${APP_DIR}/.env"
    info "Copied .env from project directory"
  else
    cp "${SCRIPT_DIR}/.env.example" "${APP_DIR}/.env"
    warn "Created .env from template — edit ${APP_DIR}/.env to set YM_TOKEN"
  fi
fi

# ─── 4. Install npm dependencies (production only) ───
info "Installing npm dependencies..."
cd "${APP_DIR}"
npm install --production --ignore-scripts 2>&1 | tail -1

# ─── 5. Set permissions ───
info "Setting file permissions..."
chown -R www-data:www-data "${APP_DIR}"
chmod 600 "${APP_DIR}/.env"

# ─── 6. Install systemd service ───
info "Installing systemd service..."
cp "${SCRIPT_DIR}/${SERVICE_FILE}" "/etc/systemd/system/${SERVICE_FILE}"
systemctl daemon-reload
systemctl enable "${APP_NAME}.service"

# ─── 7. Start the service ───
info "Starting ${APP_NAME} service..."
systemctl restart "${APP_NAME}.service"
sleep 2

# ─── 8. Verify ───
if systemctl is-active --quiet "${APP_NAME}.service"; then
  info "Service is running!"
  echo ""
  echo -e "  ${GREEN}●${NC} Status:  systemctl status ${APP_NAME}"
  echo -e "  ${GREEN}●${NC} Logs:    journalctl -u ${APP_NAME} -f"
  echo -e "  ${GREEN}●${NC} Restart: systemctl restart ${APP_NAME}"
  echo -e "  ${GREEN}●${NC} Stop:    systemctl stop ${APP_NAME}"
  echo ""

  PORT=$(grep -oP '^PORT=\K.*' "${APP_DIR}/.env" 2>/dev/null || echo "3000")
  echo -e "  ${GREEN}●${NC} URL:     http://$(hostname -I | awk '{print $1}'):${PORT}"
  echo ""
else
  error "Service failed to start. Check logs: journalctl -u ${APP_NAME} -n 50"
fi

info "Setup complete!"
