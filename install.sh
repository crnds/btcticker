#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}✓${NC} $*"; }
warn()  { echo -e "${YELLOW}!${NC} $*"; }
error() { echo -e "${RED}✗${NC} $*"; exit 1; }

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FILE_URL="file://$DIR/index.html"
LAUNCHER="$HOME/.local/bin/btcticker-kiosk"
AUTOSTART="$HOME/.config/autostart/btcticker.desktop"

echo "btcticker — kiosk installer"
echo "==========================="

# Detect browser: preference order
BROWSER=""
for b in firefox-esr firefox chromium-browser chromium google-chrome; do
  if command -v "$b" &>/dev/null; then BROWSER="$b"; break; fi
done

if [[ -z "$BROWSER" ]]; then
  warn "No supported browser found. Installing Chromium..."
  command -v apt-get &>/dev/null || \
    error "No apt-get on this system. Install Firefox ESR or Chromium manually and re-run."
  sudo apt-get update
  sudo apt-get install -y chromium-browser || sudo apt-get install -y chromium || \
    error "Could not install a browser. Install Firefox ESR or Chromium manually and re-run."
  for b in chromium-browser chromium; do
    if command -v "$b" &>/dev/null; then BROWSER="$b"; break; fi
  done
fi

info "Browser: $BROWSER"

# Suppress Firefox first-run dialogs
if [[ "$BROWSER" == firefox* ]]; then
  # prefer the default-release profile (modern Firefox); fall back to any *.default*
  PROFILE_DIR=$(find "$HOME/.mozilla/firefox" -maxdepth 1 -name "*.default-release" -type d 2>/dev/null | head -1 || true)
  [[ -z "$PROFILE_DIR" ]] && \
    PROFILE_DIR=$(find "$HOME/.mozilla/firefox" -maxdepth 1 -name "*.default*" -type d 2>/dev/null | head -1 || true)
  if [[ -n "$PROFILE_DIR" ]]; then
    # sentinel keeps re-runs from appending duplicate prefs
    if grep -q 'btcticker-kiosk prefs' "$PROFILE_DIR/user.js" 2>/dev/null; then
      info "Firefox first-run prefs already present"
    else
      cat >> "$PROFILE_DIR/user.js" <<'PREFS'
// btcticker-kiosk prefs
user_pref("browser.startup.firstrunSkipsHomepage", true);
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionPolicyAccepted", true);
user_pref("datareporting.policy.dataSubmissionPolicyNotifiedTime", "9999999999999");
user_pref("browser.rights.3.shown", true);
PREFS
      info "Firefox first-run suppressed"
    fi
  else
    warn "No Firefox profile found — first-run dialogs may appear on first launch"
  fi
fi

# Write launcher script
mkdir -p "$HOME/.local/bin"
{
  echo '#!/usr/bin/env bash'
  echo '# disable screen blanking and power management for kiosk display'
  echo 'xset s off -dpms s noblank 2>/dev/null || true'
  case "$BROWSER" in
    firefox-esr|firefox)
      echo "exec \"$BROWSER\" --kiosk \"$FILE_URL\""
      ;;
    *)
      # background sync/extensions/translate services buy nothing on a
      # locked-down single-tab kiosk and just compete for CPU/RAM; on very
      # low-power boxes it's also worth manually A/B testing --disable-gpu —
      # whether software or GPU rasterization is faster depends entirely on
      # driver quality, so it isn't safe to force one way by default here
      echo "exec \"$BROWSER\" --kiosk --incognito --disable-infobars --no-first-run \\"
      echo "  --disable-background-networking --disable-sync --disable-extensions \\"
      echo "  --disable-features=Translate,TranslateUI --no-default-browser-check \"$FILE_URL\""
      ;;
  esac
} > "$LAUNCHER"
chmod +x "$LAUNCHER"
info "Launcher written: $LAUNCHER"

# Write XDG autostart entry
mkdir -p "$HOME/.config/autostart"
cat > "$AUTOSTART" <<EOF
[Desktop Entry]
Type=Application
Name=btcticker
Exec=$LAUNCHER
X-GNOME-Autostart-enabled=true
EOF
info "Autostart entry: $AUTOSTART"

echo ""
echo -e "${GREEN}Done.${NC} btcticker will launch automatically on next login."
echo ""
echo "  Start now : $LAUNCHER"
echo "  Uninstall : rm \"$LAUNCHER\" \"$AUTOSTART\""
