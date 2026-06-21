#!/usr/bin/env bash
# setup-vps.sh — Oracle Cloud Always-Free ARM (Ubuntu 22.04/24.04)
# Run once as the ubuntu user after SSH access is confirmed.
# Usage: bash infra/setup-vps.sh

set -euo pipefail
APP_DIR="$HOME/research-desk"

echo "==> Updating system packages"
sudo apt-get update -y && sudo apt-get upgrade -y

echo "==> Installing Node 22 (via NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

echo "==> Node $(node -v), npm $(npm -v)"

echo "==> Installing OpenClaw globally"
sudo npm install -g openclaw@latest

echo "==> Creating app directory"
mkdir -p "$APP_DIR"

echo "==> Cloning repo (or pulling latest)"
if [ ! -d "$APP_DIR/.git" ]; then
  # Replace with your actual GitHub repo URL
  git clone https://github.com/YOUR_GITHUB_USERNAME/take-home-project.git "$APP_DIR"
else
  git -C "$APP_DIR" pull --rebase
fi

echo "==> Installing orchestrator dependencies"
cd "$APP_DIR/orchestrator"
npm install
npm run build

echo "==> Setting up OpenClaw workspaces"
mkdir -p "$HOME/.openclaw/workspaces"
cp -r "$APP_DIR/agents-openclaw/openclaw.json" "$HOME/.openclaw/"
for agent in collector writer reviewer; do
  TARGET="$HOME/.openclaw/workspaces/$agent"
  mkdir -p "$TARGET/skills"
  cp "$APP_DIR/agents-openclaw/workspaces/$agent/SOUL.md" "$TARGET/"
  # Install skill deps (supabase client etc)
  cp "$APP_DIR/agents-openclaw/workspaces/$agent/skills/run.mjs" "$TARGET/skills/"
  cd "$TARGET/skills"
  # Create a minimal package.json for the skill
  cat > package.json <<'JSON'
{ "name": "skill", "type": "module", "dependencies": { "@supabase/supabase-js": "^2.46.0" } }
JSON
  npm install
  cd "$APP_DIR"
done

echo "==> Copying .env (make sure you created $APP_DIR/.env first!)"
if [ ! -f "$APP_DIR/.env" ]; then
  echo "⚠  $APP_DIR/.env not found — copy .env.example and fill in your values."
  echo "   Then re-run this script or run: sudo systemctl start orchestrator"
fi

echo "==> Installing systemd units"
sudo cp "$APP_DIR/infra/orchestrator.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable orchestrator
if [ -f "$APP_DIR/.env" ]; then
  sudo systemctl start orchestrator
  echo "==> Orchestrator started"
else
  echo "==> Orchestrator NOT started (missing .env)"
fi

echo ""
echo "✅  VPS setup complete."
echo "   Check status:   sudo systemctl status orchestrator"
echo "   Follow logs:    sudo journalctl -u orchestrator -f"
