#!/bin/bash

# Quick restart script after code updates
# Usage: ./restart.sh

echo "🔄 Restarting NewsBot..."

# Pull latest code (if using git)
if [ -d .git ]; then
    echo "📥 Pulling latest code..."
    git pull
fi

# Restart the container (will use mounted volumes for code)
echo "🔄 Restarting container..."
docker-compose restart

# Show logs
echo "📋 Container logs:"
docker-compose logs -f --tail=30

