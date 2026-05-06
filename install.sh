#!/bin/bash
set -e

# ─────────────────────────────────────────────────────────
#  Bitcoin Ticker — Linux Installer
#  Supports: Linux Mint, Ubuntu, Debian
#  Browsers: Firefox ESR, Chromium, Chrome
# ─────────────────────────────────────────────────────────

BOLD="\033[1m"
GREEN="\033[0;32m"
RED="\033[0;31m"
YELLOW="\033[1;33m"
RESET="\033[0m"

info()    { echo -e "${GREEN}[✔]${RESET} $1"; }
warn()    { echo -e "${YELLOW}[!]${RESET} $1"; }
error()   { echo -e "${RED}[✘]${RESET} $1"; exit 1; }
section() { echo -e "\n${BOLD}── $1 ──${RESET}"; }

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="bitcointicker"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
NODE_MIN_VERSION=18
APP_URL="http://localhost:3000"

echo -e "${BOLD}"
echo "  ██████╗ ████████╗ ██████╗"
echo "  ██╔══██╗╚══██╔══╝██╔════╝"
echo "  ██████╔╝   ██║   ██║"
echo "  ██╔══██╗   ██║   ██║"
echo "  ██████╔╝   ██║   ╚██████╗"
echo "  ╚═════╝    ╚═╝    ╚═════╝  Ticker Installer"
echo -e "${RESET}"

# ── 1. Root check ──────────────────────────────────────────
section "Checking permissions"
if [ "$EUID" -ne 0 ]; then
  error "Please run as root: sudo bash install.sh"
fi
REAL_USER="${SUDO_USER:-$(logname 2>/dev/null || echo $USER)}"
REAL_HOME=$(eval echo "~$REAL_USER")
info "Installing for user: ${REAL_USER}"

# ── 2. Detect distro ───────────────────────────────────────
section "Detecting system"
if [ -f /etc/os-release ]; then
  . /etc/os-release
  info "OS: ${PRETTY_NAME}"
else
  warn "Could not detect OS — assuming Debian/Ubuntu compatible"
fi

# ── 3. Install Node.js ─────────────────────────────────────
section "Node.js"
install_node() {
  warn "Installing Node.js v22 via NodeSource..."
  apt-get update -qq
  apt-get install -y curl ca-certificates gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
}

if command -v node &>/dev/null; then
  NODE_VERSION=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
  if [ "$NODE_VERSION" -lt "$NODE_MIN_VERSION" ]; then
    warn "Node.js v${NODE_VERSION} is too old (need v${NODE_MIN_VERSION}+). Upgrading..."
    install_node
  else
    info "Node.js $(node -v) already installed"
  fi
else
  install_node
fi
info "Node.js $(node -v) ready"

# ── 4. npm install ─────────────────────────────────────────
section "Dependencies"
cd "$PROJECT_DIR"
npm install --omit=dev --silent
info "npm packages installed"

# ── 5. Create data directory ───────────────────────────────
section "Data directory"
mkdir -p "$PROJECT_DIR/data"
chown "$REAL_USER":"$REAL_USER" "$PROJECT_DIR/data" 2>/dev/null || true
info "data/ ready"

# ── 6. systemd service ─────────────────────────────────────
section "systemd service"
NODE_PATH=$(command -v node)

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Bitcoin Ticker Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${REAL_USER}
WorkingDirectory=${PROJECT_DIR}
ExecStart=${NODE_PATH} server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "systemd service '${SERVICE_NAME}' is running"
else
  error "Service failed to start. Check logs: sudo journalctl -u ${SERVICE_NAME} -n 30"
fi

# ── 7. Detect browser ──────────────────────────────────────
section "Browser detection"
BROWSER=""
BROWSER_FLAGS=""

if command -v firefox-esr &>/dev/null; then
  BROWSER="firefox-esr"
  BROWSER_FLAGS="--kiosk"
  info "Found: Firefox ESR"
elif command -v firefox &>/dev/null; then
  BROWSER="firefox"
  BROWSER_FLAGS="--kiosk"
  info "Found: Firefox"
elif command -v chromium-browser &>/dev/null; then
  BROWSER="chromium-browser"
  BROWSER_FLAGS="--kiosk --incognito --disable-infobars --noerrdialogs"
  info "Found: Chromium"
elif command -v chromium &>/dev/null; then
  BROWSER="chromium"
  BROWSER_FLAGS="--kiosk --incognito --disable-infobars --noerrdialogs"
  info "Found: Chromium"
elif command -v google-chrome &>/dev/null; then
  BROWSER="google-chrome"
  BROWSER_FLAGS="--kiosk --incognito --disable-infobars --noerrdialogs"
  info "Found: Google Chrome"
else
  warn "No supported browser found"
fi

# ── 8. Firefox ESR profile (suppress first-run UI) ────────
if [[ "$BROWSER" == firefox* ]]; then
  section "Firefox ESR — suppress first-run UI"
  FF_PROFILE_DIR="${REAL_HOME}/.mozilla/firefox"
  mkdir -p "$FF_PROFILE_DIR"

  # find or create a default profile
  FF_PROFILE=$(sudo -u "$REAL_USER" "$BROWSER" --headless --no-remote \
    2>/dev/null & sleep 3; kill %1 2>/dev/null; \
    find "$FF_PROFILE_DIR" -maxdepth 1 -name "*.default*" -type d | head -1)

  if [ -z "$FF_PROFILE" ]; then
    FF_PROFILE=$(find "$FF_PROFILE_DIR" -maxdepth 1 -name "*.default*" -type d 2>/dev/null | head -1)
  fi

  if [ -n "$FF_PROFILE" ]; then
    # write user.js prefs to suppress update nag, default browser prompt, etc.
    cat > "${FF_PROFILE}/user.js" <<'PREFS'
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("datareporting.policy.dataSubmissionPolicyAccepted", true);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);
user_pref("browser.tabs.warnOnClose", false);
PREFS
    chown "$REAL_USER":"$REAL_USER" "${FF_PROFILE}/user.js"
    info "Firefox first-run prompts suppressed"
  else
    warn "Could not locate Firefox profile — first-run dialog may appear once"
  fi
fi

# ── 9. Autostart .desktop entry ───────────────────────────
section "Browser autostart"
if [ -n "$BROWSER" ]; then
  AUTOSTART_DIR="${REAL_HOME}/.config/autostart"
  mkdir -p "$AUTOSTART_DIR"

  cat > "${AUTOSTART_DIR}/${SERVICE_NAME}.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Bitcoin Ticker
Exec=${BROWSER} ${BROWSER_FLAGS} ${APP_URL}
X-GNOME-Autostart-enabled=true
EOF

  chown -R "$REAL_USER":"$REAL_USER" "$AUTOSTART_DIR"
  info "Autostart entry created for ${BROWSER}"
else
  warn "Skipping autostart — no browser detected"
  warn "Install Firefox ESR: sudo apt install -y firefox-esr"
fi

# ── 10. Done ───────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}Installation complete!${RESET}"
echo ""
echo -e "  Open in browser: ${BOLD}${APP_URL}${RESET}"
echo -e "  Service status:  ${BOLD}sudo systemctl status ${SERVICE_NAME}${RESET}"
echo -e "  Live logs:       ${BOLD}sudo journalctl -u ${SERVICE_NAME} -f${RESET}"
echo -e "  Stop server:     ${BOLD}sudo systemctl stop ${SERVICE_NAME}${RESET}"
echo -e "  Uninstall:       ${BOLD}sudo systemctl disable --now ${SERVICE_NAME} && sudo rm ${SERVICE_FILE}${RESET}"
echo ""
