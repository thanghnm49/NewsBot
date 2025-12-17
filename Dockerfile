FROM node:18-alpine

# Install git and build tools for better-sqlite3
# sqlite-dev is needed for better-sqlite3 native bindings
RUN apk add --no-cache git python3 make g++ sqlite-dev

WORKDIR /app

# Copy package files (package-lock.json must exist for npm ci)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Copy entrypoint script
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Copy application files
COPY . .

# Create directory for state file
RUN mkdir -p /app && chmod 755 /app

# Use entrypoint script
ENTRYPOINT ["/app/entrypoint.sh"]

