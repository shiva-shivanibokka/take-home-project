#!/usr/bin/env bash
# setup-vps.sh — Oracle Cloud Always-Free ARM (Ubuntu 22.04/24.04)
# Run once after SSH access is confirmed.
# Usage: bash infra/setup-vps.sh
#
# What this does:
#   1. Installs Node 22 and PM2
#   2. Installs OpenClaw globally
#   3. Clones the repo (or pulls latest)
#   4. Installs @supabase/supabase-js in each agent skill directory
#   5. Builds the TypeScript orchestrator
#   6. Starts the orchestrator under PM2 and configures reboot persistence

set -euo pipefail

REPO_URL="https://github.com/shiva-shivanibokka/take-home-project.git"
APP_DIR="$HOME/take-home-project"

# ─── 1. System packages ─────────────────────────────────────────────────────────
echo "==> Updating system packages"
sudo apt-get update -y && sudo apt-get upgrade -y

echo "==> Installing Node 22 (via NodeSource)"
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
echo "    Node $(node -v), npm $(npm -v)"

echo "==> Installing PM2 globally"
sudo npm install -g pm2

echo "==> Installing OpenClaw globally"
sudo npm install -g openclaw@latest

# ─── 2. Repo ────────────────────────────────────────────────────────────────────
echo "==> Cloning repo (or pulling latest)"
if [ ! -d "$APP_DIR/.git" ]; then
  git clone "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" pull --rebase
fi

# ─── 3. Environment file ────────────────────────────────────────────────────────
if [ ! -f "$APP_DIR/.env" ]; then
  echo ""
  echo "⚠  $APP_DIR/.env not found."
  echo "   Copy .env.example and fill in your values before continuing:"
  echo ""
  echo "     cp $APP_DIR/.env.example $APP_DIR/.env"
  echo "     nano $APP_DIR/.env"
  echo ""
  echo "   Then re-run this script."
  exit 1
fi

# ─── 4. Agent skill dependencies ────────────────────────────────────────────────
echo "==> Installing @supabase/supabase-js in each agent skill"
for agent in collector writer reviewer; do
  SKILL_DIR="$APP_DIR/agents-openclaw/workspaces/$agent/skills"
  mkdir -p "$SKILL_DIR"
  # Create a minimal ESM package.json if one doesn't exist
  if [ ! -f "$SKILL_DIR/package.json" ]; then
    cat > "$SKILL_DIR/package.json" <<'JSON'
{ "name": "skill", "type": "module", "dependencies": { "@supabase/supabase-js": "^2.46.0" } }
JSON
  fi
  cd "$SKILL_DIR" && npm install
  echo "    $agent ✓"
done

# ─── 5. Orchestrator ────────────────────────────────────────────────────────────
echo "==> Building orchestrator"
cd "$APP_DIR/orchestrator"
npm install
npm run build

# ─── 6. PM2 — start and persist across reboots ─────────────────────────────────
echo "==> Starting orchestrator under PM2"
cd "$APP_DIR"

# Stop any existing instance so we can replace it cleanly
pm2 delete orchestrator 2>/dev/null || true

pm2 start orchestrator/dist/index.js \
  --name orchestrator \
  --cwd "$APP_DIR" \
  --

# Register PM2 as a startup service (run the printed command if prompted)
pm2 startup || true
pm2 save

echo ""
echo "✅  VPS setup complete."
echo ""
echo "   Check status:  pm2 status"
echo "   Follow logs:   pm2 logs orchestrator --lines 30"
echo ""
echo "   If pm2 startup printed a 'sudo env ...' command above, run it now"
echo "   to complete reboot persistence, then run: pm2 save"
