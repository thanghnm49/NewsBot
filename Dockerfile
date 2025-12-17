FROM node:18-alpine

WORKDIR /app

# Copy package files (package-lock.json must exist for npm ci)
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directory for state file
RUN mkdir -p /app && chmod 755 /app

# Run the bot
CMD ["node", "index.js"]

