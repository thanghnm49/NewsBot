FROM node:18-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directory for state file
RUN mkdir -p /app && chmod 755 /app

# Run the bot
CMD ["node", "index.js"]

