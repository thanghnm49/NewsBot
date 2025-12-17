#!/bin/sh

# Entrypoint script to auto-pull from GitHub and start the bot

set -e

# Ensure this script is executable
chmod +x /app/entrypoint.sh 2>/dev/null || true

GIT_REPO_URL=${GIT_REPO_URL:-https://github.com/thanghnm49/NewsBot.git}
GIT_BRANCH=${GIT_BRANCH:-main}

echo "🚀 Starting NewsBot..."

# Check if we're in a git repository
if [ -d .git ]; then
    echo "📥 Pulling latest code from GitHub (branch: $GIT_BRANCH)..."
    git fetch origin
    git reset --hard origin/$GIT_BRANCH || git reset --hard origin/main || git pull origin main || git pull origin master || true
    echo "✅ Code updated"
    # Ensure entrypoint script is still executable after git operations
    chmod +x /app/entrypoint.sh 2>/dev/null || true
else
    echo "📥 Cloning repository from GitHub..."
    # If not a git repo, clone it
    cd /tmp
    rm -rf NewsBot-tmp
    git clone -b $GIT_BRANCH $GIT_REPO_URL NewsBot-tmp || git clone $GIT_REPO_URL NewsBot-tmp
    cd NewsBot-tmp
    # Copy files to app directory
    cp -r * /app/ 2>/dev/null || true
    cp -r .[^.]* /app/ 2>/dev/null || true
    cd /app
    echo "✅ Repository cloned"
    # Ensure entrypoint script is executable after copy
    chmod +x /app/entrypoint.sh 2>/dev/null || true
fi

# Install/update dependencies (only if package.json changed)
# Note: better-sqlite3 should already be built in Docker image
if [ -f package.json ]; then
    echo "📦 Checking dependencies..."
    # Only install if node_modules doesn't exist or package.json is newer
    if [ ! -d "node_modules" ] || [ "package.json" -nt "node_modules" ]; then
        echo "📦 Installing/updating dependencies..."
        npm install --only=production
    else
        echo "✅ Dependencies already installed"
    fi
fi

# Start the bot
echo "🤖 Starting bot..."
exec node index.js

