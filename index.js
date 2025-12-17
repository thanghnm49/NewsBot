const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

// Initialize Telegram Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set in .env file');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const parser = new Parser();

// Configuration
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes in milliseconds
const DB_FILE = path.join(__dirname, 'newsbot.db');
const MAX_NEWS_PER_FEED = 10; // Maximum number of news items to check per feed
const MAX_MANUAL_NEWS = 5; // Maximum number of news items to send for /news command

// Initialize SQLite database
const db = new Database(DB_FILE);

// Load RSS feeds from config
let rssFeeds = [];
let chatIds = new Set();

// Initialize database
function initDatabase() {
  // Create news table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS news (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      link TEXT,
      feedUrl TEXT NOT NULL,
      isSent INTEGER DEFAULT 0,
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Create indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_guid ON news(guid);
    CREATE INDEX IF NOT EXISTS idx_feedUrl ON news(feedUrl);
    CREATE INDEX IF NOT EXISTS idx_isSent ON news(isSent)
  `);
  
  console.log('Database initialized');
}

// Check if news exists in database
function newsExists(guid) {
  const stmt = db.prepare('SELECT id FROM news WHERE guid = ?');
  const result = stmt.get(guid);
  return result !== undefined;
}

// Insert news into database (only if not exists)
function insertNews(guid, title, link, feedUrl) {
  if (newsExists(guid)) {
    return false; // Already exists, don't insert
  }
  
  try {
    const stmt = db.prepare('INSERT INTO news (guid, title, link, feedUrl) VALUES (?, ?, ?, ?)');
    stmt.run(guid, title, link, feedUrl);
    return true; // Successfully inserted
  } catch (error) {
    // Ignore unique constraint errors (already exists)
    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
      console.error('Error inserting news:', error);
    }
    return false;
  }
}

// Check if news is already sent
function isNewsSent(guid) {
  const stmt = db.prepare('SELECT isSent FROM news WHERE guid = ?');
  const result = stmt.get(guid);
  return result ? result.isSent === 1 : false;
}

// Mark news as sent
function markNewsAsSent(guid) {
  const stmt = db.prepare('UPDATE news SET isSent = 1 WHERE guid = ?');
  stmt.run(guid);
}

// Load RSS feeds configuration
async function loadRSSFeeds() {
  try {
    const data = await fs.readFile('rss-feeds.json', 'utf8');
    rssFeeds = JSON.parse(data);
    console.log(`Loaded ${rssFeeds.length} RSS feeds`);
  } catch (error) {
    console.error('Error loading RSS feeds:', error);
    console.log('Creating default rss-feeds.json file...');
    // Create default RSS feeds file
    const defaultFeeds = [
      {
        "name": "BBC News",
        "url": "https://feeds.bbci.co.uk/news/rss.xml"
      },
      {
        "name": "TechCrunch",
        "url": "https://techcrunch.com/feed/"
      }
    ];
    await fs.writeFile('rss-feeds.json', JSON.stringify(defaultFeeds, null, 2));
    rssFeeds = defaultFeeds;
  }
}

// Fetch and parse RSS feed
async function fetchRSSFeed(feedConfig) {
  try {
    const feed = await parser.parseURL(feedConfig.url);
    return feed;
  } catch (error) {
    console.error(`Error fetching RSS feed ${feedConfig.name}:`, error.message);
    return null;
  }
}

// Get latest news and send to specific chat (for manual requests)
async function getLatestNewsForChat(chatId) {
  let newsFound = 0;
  
  for (const feedConfig of rssFeeds) {
    const feed = await fetchRSSFeed(feedConfig);
    if (!feed || !feed.items || feed.items.length === 0) {
      continue;
    }

    // Get multiple latest items (limit to MAX_MANUAL_NEWS)
    const itemsToSend = feed.items.slice(0, MAX_MANUAL_NEWS);
    
    for (const item of itemsToSend) {
      const itemGuid = item.guid || item.link || item.title;
      
      // Skip if already sent
      if (isNewsSent(itemGuid)) {
        continue;
      }
      
      // Insert into database if not exists
      insertNews(itemGuid, item.title || 'No title', item.link || '', feedConfig.url);
      
      const message = formatNewsMessage(feedConfig.name, item);
      
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false
        });
        newsFound++;
        // Mark as sent
        markNewsAsSent(itemGuid);
        // Small delay between messages to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error sending news to chat ${chatId}:`, error.message);
        // Continue with next item instead of throwing
      }
    }
  }
  
  return newsFound;
}

// Check for new news items
async function checkForNewNews() {
  console.log(`[${new Date().toISOString()}] Checking for new news...`);
  
  for (const feedConfig of rssFeeds) {
    const feed = await fetchRSSFeed(feedConfig);
    if (!feed || !feed.items || feed.items.length === 0) {
      continue;
    }

    // Get items to check (limit to MAX_NEWS_PER_FEED)
    const itemsToCheck = feed.items.slice(0, MAX_NEWS_PER_FEED);
    const newItems = [];
    
    // Find all new items that don't exist in database or haven't been sent
    for (const item of itemsToCheck) {
      const itemGuid = item.guid || item.link || item.title;
      
      // Skip if already sent
      if (isNewsSent(itemGuid)) {
        continue;
      }
      
      // Insert into database if not exists (returns true if inserted, false if already exists)
      const wasInserted = insertNews(itemGuid, item.title || 'No title', item.link || '', feedConfig.url);
      
      // Only process if it's a new item (was just inserted or exists but not sent)
      if (wasInserted || !isNewsSent(itemGuid)) {
        newItems.push(item);
      }
    }

    if (newItems.length === 0) {
      continue; // No new items
    }

    console.log(`Found ${newItems.length} new news item(s) in ${feedConfig.name}`);
    
    // Check if there are any subscribers
    if (chatIds.size === 0) {
      console.log(`⚠️  No subscribers found. Users need to send /start to receive news updates.`);
      continue;
    }
    
    // Send all new items to all subscribed chats
    let totalSent = 0;
    
    for (const item of newItems) {
      const itemGuid = item.guid || item.link || item.title;
      
      // Double-check: skip if already sent (race condition protection)
      if (isNewsSent(itemGuid)) {
        continue;
      }
      
      const message = formatNewsMessage(feedConfig.name, item);
      let sentCount = 0;
      
      for (const chatId of chatIds) {
        try {
          await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: false
          });
          sentCount++;
          // Small delay between messages to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 300));
        } catch (error) {
          console.error(`❌ Error sending message to chat ${chatId}:`, error.message);
          // Remove invalid chat IDs
          if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
            chatIds.delete(chatId);
            console.log(`Removed invalid chat ID: ${chatId}`);
          }
        }
      }
      
      // Mark as sent only if successfully sent to at least one subscriber
      if (sentCount > 0) {
        markNewsAsSent(itemGuid);
        totalSent += sentCount;
        console.log(`✅ Sent "${item.title.substring(0, 50)}..." to ${sentCount} subscriber(s)`);
      }
    }

    if (totalSent > 0) {
      console.log(`📤 Sent ${newItems.length} news item(s) to subscribers from ${feedConfig.name}`);
    }
  }
}

// Format news message for Telegram
function formatNewsMessage(feedName, item) {
  const title = escapeHtml(item.title || 'No title');
  const link = item.link || '#';
  const description = escapeHtml((item.contentSnippet || item.content || '').substring(0, 200));
  const pubDate = item.pubDate ? new Date(item.pubDate).toLocaleString() : '';

  let message = `<b>📰 ${feedName}</b>\n\n`;
  message += `<b>${title}</b>\n\n`;
  
  if (description) {
    message += `${description}...\n\n`;
  }
  
  if (pubDate) {
    message += `📅 ${pubDate}\n\n`;
  }
  
  message += `<a href="${link}">Read more →</a>`;
  
  return message;
}

// Escape HTML special characters
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Telegram bot commands
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const wasSubscribed = chatIds.has(chatId);
  chatIds.add(chatId);
  console.log(`✅ User ${chatId} subscribed. Total subscribers: ${chatIds.size}`);
  
  const message = wasSubscribed 
    ? '✅ You are already subscribed!\n\n'
    : '✅ You are now subscribed to news updates!\n\n';
  
  await bot.sendMessage(chatId, 
    '👋 Welcome to NewsBot!\n\n' +
    message +
    'I will automatically send you the latest news from configured RSS feeds every 5 minutes.\n\n' +
    'Commands:\n' +
    '/start - Start receiving news updates\n' +
    '/stop - Stop receiving news updates\n' +
    '/status - Check bot status\n' +
    '/feeds - List configured RSS feeds\n' +
    '/news - Manually check for latest news'
  );
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  chatIds.delete(chatId);
  await bot.sendMessage(chatId, 'You have been unsubscribed from news updates.');
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const isSubscribed = chatIds.has(chatId);
  const status = isSubscribed ? '✅ Subscribed' : '❌ Not subscribed';
  const feedCount = rssFeeds.length;
  
  await bot.sendMessage(chatId, 
    `Bot Status:\n\n` +
    `Subscription: ${status}\n` +
    `RSS Feeds: ${feedCount}\n` +
    `Total Subscribers: ${chatIds.size}`
  );
});

bot.onText(/\/feeds/, async (msg) => {
  const chatId = msg.chat.id;
  if (rssFeeds.length === 0) {
    await bot.sendMessage(chatId, 'No RSS feeds configured.');
    return;
  }
  
  let message = '📡 Configured RSS Feeds:\n\n';
  rssFeeds.forEach((feed, index) => {
    message += `${index + 1}. ${feed.name}\n   ${feed.url}\n\n`;
  });
  
  await bot.sendMessage(chatId, message);
});

bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  console.log(`User ${chatId} requested manual news check`);
  
  await bot.sendMessage(chatId, '🔍 Fetching latest news from all feeds...');
  
  try {
    const newsCount = await getLatestNewsForChat(chatId);
    if (newsCount === 0) {
      await bot.sendMessage(chatId, '📭 No news feeds available or all feeds are empty.');
    } else {
      await bot.sendMessage(chatId, `✅ Sent ${newsCount} latest news item(s) from all feeds (up to ${MAX_MANUAL_NEWS} per feed).`);
    }
  } catch (error) {
    console.error('Error during manual news check:', error);
    await bot.sendMessage(chatId, '❌ Error occurred while fetching news. Please try again later.');
  }
});

// Handle errors
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

// Initialize and start
async function start() {
  console.log('Starting NewsBot...');
  
  // Initialize database
  initDatabase();
  
  await loadRSSFeeds();
  
  // Initial check
  await checkForNewNews();
  
  // Set up periodic checking
  setInterval(checkForNewNews, CHECK_INTERVAL);
  
  console.log(`NewsBot is running! Checking for news every ${CHECK_INTERVAL / 1000 / 60} minutes.`);
  console.log(`Monitoring ${rssFeeds.length} RSS feed(s).`);
  console.log(`Current subscribers: ${chatIds.size}`);
  if (chatIds.size === 0) {
    console.log(`⚠️  No subscribers yet. Users need to send /start to the bot to receive news updates.`);
  }
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\nShutting down...');
  db.close();
  process.exit(0);
});

// Start the bot
start().catch(console.error);

