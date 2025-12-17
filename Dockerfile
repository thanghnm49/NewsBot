FROM node:18-alpine

# Install git and build tools for better-sqlite3
# sqlite-dev is needed for better-sqlite3 native bindings
RUN apk add --no-cache git python3 make g++ sqlite-dev

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Ensure package-lock.json is in sync, then use npm ci
# This updates the lock file if needed, then installs with npm ci
RUN npm install --package-lock-only && \
    npm ci --only=production

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Copy application files
COPY . .

# Create directory for state file
RUN mkdir -p /app && chmod 755 /app

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]

