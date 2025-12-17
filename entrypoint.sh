#!/bin/sh

# Entrypoint script to auto-pull from GitHub and start the bot

set -e

GIT_REPO_URL=${GIT_REPO_URL:-https://github.com/thanghnm49/NewsBot.git}
GIT_BRANCH=${GIT_BRANCH:-main}

echo "🚀 Starting NewsBot..."

# Check if we're in a git repository
if [ -d .git ]; then
    echo "📥 Pulling latest code from GitHub (branch: $GIT_BRANCH)..."
    git fetch origin
    git reset --hard origin/$GIT_BRANCH || git reset --hard origin/main || git pull origin main || git pull origin master || true
    echo "✅ Code updated"
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
fi

# Install/update dependencies
if [ -f package.json ]; then
    echo "📦 Installing dependencies..."
    npm install --only=production
fi

# Start the bot
echo "🤖 Starting bot..."
exec node index.js

