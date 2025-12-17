const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs').promises;
const path = require('path');
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
const STATE_FILE = path.join(__dirname, 'state.json');
const MAX_NEWS_PER_FEED = 10; // Maximum number of news items to check per feed
const MAX_MANUAL_NEWS = 5; // Maximum number of news items to send for /news command

// Load RSS feeds from config
let rssFeeds = [];
let chatIds = new Set();

// Load state (last seen news items)
let state = {};

// Initialize state file if it doesn't exist
async function loadState() {
  try {
    const data = await fs.readFile(STATE_FILE, 'utf8');
    const loadedState = JSON.parse(data);
    // Migrate old state format (single GUID) to new format (array of GUIDs)
    state = {};
    for (const [key, value] of Object.entries(loadedState)) {
      if (Array.isArray(value)) {
        state[key] = value;
      } else {
        // Old format: single GUID string, convert to array
        state[key] = value ? [value] : [];
      }
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      state = {};
      await saveState();
    } else {
      console.error('Error loading state:', error);
      state = {};
    }
  }
}

async function saveState() {
  try {
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error('Error saving state:', error);
  }
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
      const message = formatNewsMessage(feedConfig.name, item);
      
      try {
        await bot.sendMessage(chatId, message, {
          parse_mode: 'HTML',
          disable_web_page_preview: false
        });
        newsFound++;
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

    const feedKey = feedConfig.url;
    const seenGuids = state[feedKey] || [];
    const seenGuidsSet = new Set(seenGuids);
    
    // Get items to check (limit to MAX_NEWS_PER_FEED)
    const itemsToCheck = feed.items.slice(0, MAX_NEWS_PER_FEED);
    const newItems = [];
    
    // Find all new items
    for (const item of itemsToCheck) {
      const itemGuid = item.guid || item.link || item.title;
      if (!seenGuidsSet.has(itemGuid)) {
        newItems.push(item);
        seenGuidsSet.add(itemGuid);
      }
    }

    if (newItems.length === 0) {
      continue; // No new items
    }

    console.log(`Found ${newItems.length} new news item(s) in ${feedConfig.name}`);
    
    // Check if there are any subscribers
    if (chatIds.size === 0) {
      console.log(`⚠️  No subscribers found. Users need to send /start to receive news updates.`);
      // Still update state so we don't send duplicate messages later
      state[feedKey] = Array.from(seenGuidsSet);
      await saveState();
      continue;
    }
    
    // Send all new items to all subscribed chats
    let totalSent = 0;
    
    for (const item of newItems) {
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
      
      totalSent += sentCount;
      console.log(`✅ Sent "${item.title.substring(0, 50)}..." to ${sentCount} subscriber(s)`);
    }

    console.log(`📤 Sent ${newItems.length} news item(s) to ${totalSent / newItems.length} subscriber(s) from ${feedConfig.name}`);

    // Update state with all seen GUIDs (keep only recent ones to avoid state file growing too large)
    const allSeenGuids = Array.from(seenGuidsSet);
    // Keep only the most recent MAX_NEWS_PER_FEED * 2 GUIDs to prevent state file from growing too large
    state[feedKey] = allSeenGuids.slice(0, MAX_NEWS_PER_FEED * 2);
    await saveState();
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
  
  await loadState();
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

// Start the bot
start().catch(console.error);

