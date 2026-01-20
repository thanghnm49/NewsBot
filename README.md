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

### Reddit OAuth (optional)

1. Create a Reddit app (type: script) at https://www.reddit.com/prefs/apps
2. Add these variables to your `.env`:
```
REDDIT_CLIENT_ID=your_client_id
REDDIT_CLIENT_SECRET=your_client_secret
REDDIT_REDIRECT_URI=http://localhost:8080
REDDIT_USER_AGENT=NewsBot/1.0 by <your-reddit-username>
```
3. Add Reddit feeds to `rss-feeds.json`:
```json
[
  {
    "name": "Reddit Home",
    "type": "reddit",
    "source": "home",
    "sort": "best"
  },
  {
    "name": "Reddit Saved",
    "type": "reddit",
    "source": "saved"
  }
]
```
4. In Telegram, run `/reddit_setup` and follow the link, then send `/reddit_code <code>`

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

### Deployment to VPS (Ubuntu)

1. SSH into your VPS:
```bash
ssh user@your-vps-ip
```

2. Create a directory and clone the repository (or create manually):
```bash
mkdir -p NewsBot
cd NewsBot
```

3. Create `.env` file with your bot token:
```bash
nano .env
```
Add your `TELEGRAM_BOT_TOKEN`:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
```

4. Create `docker-compose.yml` and `Dockerfile` (or clone from GitHub):
```bash
# Option A: Clone from GitHub
git clone https://github.com/thanghnm49/NewsBot.git .
# Then create .env file

# Option B: Create files manually (copy from repository)
```

5. Build and run with Docker Compose:
```bash
docker-compose up -d --build
```

6. View logs:
```bash
docker-compose logs -f
```

**Note:** The bot automatically pulls the latest code from GitHub (`https://github.com/thanghnm49/NewsBot.git`) every time the container starts. No need to manually pull or restart after pushing code changes - just restart the container!

## Telegram Commands

- `/start` - Start receiving news updates
- `/stop` - Stop receiving news updates
- `/status` - Check bot status and subscription
- `/follow <feed_name>` - Receive updates from a specific feed listed in `rss-feeds.json`
- `/feeds` - List all configured feeds
- `/news` - Manually check for latest news
- `/reddit_setup` - Start Reddit OAuth setup
- `/reddit_code <code>` - Finish Reddit OAuth setup
- `/reddit_status` - Check Reddit connection
- `/reddit_logout` - Disconnect Reddit

## How It Works

1. The bot checks all configured feeds (RSS or Reddit) every 5 minutes
2. It compares the latest item GUID/link with the previously seen one
3. If a new item is found, it sends a formatted message to all subscribed users
4. The state is saved in the SQLite database to track the last seen news

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

### After Code Changes

The bot **automatically pulls the latest code from GitHub** every time the container starts!

**To apply code changes:**
```bash
docker-compose restart
docker-compose logs -f
```

The entrypoint script will:
1. Pull latest code from GitHub
2. Install/update dependencies if needed
3. Start the bot with the latest code

**For major changes (if dependencies changed):**
```bash
docker-compose up -d --build
docker-compose logs -f
```

### Updating RSS Feeds

Edit `rss-feeds.json` and restart the bot:
```bash
docker-compose restart
```

**Note:** The bot automatically pulls from `https://github.com/thanghnm49/NewsBot.git` on every container start, so your code is always up-to-date!

## License

MIT

