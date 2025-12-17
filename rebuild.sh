#!/bin/bash

# Rebuild script for major changes
# Usage: ./rebuild.sh

echo "🔨 Rebuilding NewsBot..."

# Pull latest code (if using git)
if [ -d .git ]; then
    echo "📥 Pulling latest code..."
    git pull
fi

# Rebuild and restart the container
echo "🔨 Rebuilding container..."
docker-compose up -d --build

# Show logs
echo "📋 Container logs:"
docker-compose logs -f --tail=50

