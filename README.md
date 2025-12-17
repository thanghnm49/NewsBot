# Telegram NewsBot

A Telegram bot that automatically fetches and sends RSS news updates every 5 minutes.

## Features

- 📰 Fetches news from multiple RSS feeds
- ⏰ Automatic checking every 5 minutes
- 🔄 Tracks latest news to avoid duplicates
- 🚀 Easy deployment to VPS using Docker
- 📱 Simple Telegram commands

## Prerequisites

- Node.js 18+ (for local development)
- Docker and Docker Compose (for VPS deployment)
- A Telegram Bot Token (get it from [@BotFather](https://t.me/botfather))

## Setup

### 1. Get Telegram Bot Token

1. Open Telegram and search for [@BotFather](https://t.me/botfather)
2. Send `/newbot` and follow the instructions
3. Copy your bot token

### 2. Configure the Bot

1. Clone this repository:
```bash
git clone <your-github-url>
cd NewsBot
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Edit `.env` and add your bot token:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
```

4. Configure RSS feeds in `rss-feeds.json`:
```json
[
  {
    "name": "BBC News",
    "url": "https://feeds.bbci.co.uk/news/rss.xml"
  },
  {
    "name": "TechCrunch",
    "url": "https://techcrunch.com/feed/"
  }
]
```

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the bot:
```bash
npm start
```

## Deployment to VPS (Ubuntu)

### Option 1: Using GitHub and Deploy Script

1. Push your code to GitHub (make sure `.env` is in `.gitignore`)

2. SSH into your VPS:
```bash
ssh user@your-vps-ip
```

3. Clone the repository:
```bash
git clone <your-github-url>
cd NewsBot
```

4. Create `.env` file on the VPS:
```bash
nano .env
```
Add your `TELEGRAM_BOT_TOKEN`

5. Make deploy script executable and run it:
```bash
chmod +x deploy.sh
./deploy.sh
```

### Option 2: Manual Docker Deployment

1. SSH into your VPS and clone the repository:
```bash
git clone <your-github-url>
cd NewsBot
```

2. Create `.env` file with your bot token

3. Build and run with Docker Compose:
```bash
docker-compose up -d --build
```

4. View logs:
```bash
docker-compose logs -f
```

### Option 3: Using Docker Only

```bash
docker build -t newsbot .
docker run -d --name newsbot --restart unless-stopped --env-file .env -v $(pwd)/state.json:/app/state.json newsbot
```

## Telegram Commands

- `/start` - Start receiving news updates
- `/stop` - Stop receiving news updates
- `/status` - Check bot status and subscription
- `/feeds` - List all configured RSS feeds

## How It Works

1. The bot checks all configured RSS feeds every 5 minutes
2. It compares the latest item GUID/link with the previously seen one
3. If a new item is found, it sends a formatted message to all subscribed users
4. The state is saved to `state.json` to track the last seen news

## File Structure

```
NewsBot/
├── index.js              # Main bot application
├── package.json          # Node.js dependencies
├── rss-feeds.json        # RSS feeds configuration
├── .env                  # Environment variables (not in git)
├── .env.example          # Example environment file
├── state.json            # Bot state (last seen news)
├── Dockerfile            # Docker image definition
├── docker-compose.yml    # Docker Compose configuration
├── deploy.sh             # Deployment script
├── .gitignore           # Git ignore rules
└── README.md            # This file
```

## Troubleshooting

### Bot not responding
- Check if the bot token is correct in `.env`
- Verify the bot is running: `docker-compose ps`
- Check logs: `docker-compose logs -f`

### No news updates
- Verify RSS feeds are accessible and valid
- Check if you've subscribed with `/start`
- Review logs for any RSS parsing errors

### State file issues
- The `state.json` file stores the last seen news
- If you want to reset, delete `state.json` and restart the bot
- Make sure the file has write permissions

## Updating the Bot

### After Code Changes (Git Pull)

If you've updated the code and pulled from GitHub:

**Quick restart (for code changes):**
```bash
chmod +x restart.sh
./restart.sh
```

Or manually:
```bash
git pull
docker-compose restart
docker-compose logs -f
```

**Full rebuild (if dependencies changed):**
```bash
chmod +x rebuild.sh
./rebuild.sh
```

Or manually:
```bash
git pull
docker-compose up -d --build
docker-compose logs -f
```

### Updating RSS Feeds

Edit `rss-feeds.json` and restart the bot:
```bash
docker-compose restart
```

Note: Code files (`index.js`, `package.json`) are mounted as volumes, so code changes take effect after restart. For dependency changes, rebuild is required.

## License

MIT

