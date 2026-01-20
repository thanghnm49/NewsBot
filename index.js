const TelegramBot = require('node-telegram-bot-api');
const Parser = require('rss-parser');
const fs = require('fs').promises;
const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');
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
// Store database in data directory to avoid volume mount issues
const DB_FILE = path.join(__dirname, 'data', 'newsbot.db');
const MAX_NEWS_PER_FEED = 10; // Maximum number of news items to check per feed
const MAX_MANUAL_NEWS = 5; // Maximum number of news items to send for /news command

// Reddit OAuth configuration
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID;
const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET;
const REDDIT_REDIRECT_URI = process.env.REDDIT_REDIRECT_URI;
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'NewsBot/1.0';
const REDDIT_SCOPES = ['read', 'history', 'identity'];
const REDDIT_AUTH_BASE = 'https://www.reddit.com/api/v1/authorize';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_API_BASE = 'https://oauth.reddit.com';
const redditStates = new Map(); // chatId -> state

// Ensure database directory exists and is writable (synchronous)
function ensureDatabaseDirectory() {
  try {
    const dbDir = path.dirname(DB_FILE);
    const fsSync = require('fs');
    // Create directory if it doesn't exist
    if (!fsSync.existsSync(dbDir)) {
      fsSync.mkdirSync(dbDir, { recursive: true });
    }
    // Ensure directory is writable
    fsSync.accessSync(dbDir, fsSync.constants.W_OK);
    console.log(`Database directory ready: ${dbDir}`);
  } catch (error) {
    console.error('Error ensuring database directory:', error);
    throw error;
  }
}

// Initialize database
function initDatabase() {
  try {
    // Check if table exists
    const tableCheck = db.prepare(`
      SELECT name FROM sqlite_master 
      WHERE type='table' AND name='news'
    `).get();
    
    if (!tableCheck) {
      console.log('Creating news table...');
      // Create news table
      db.exec(`
        CREATE TABLE news (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guid TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          link TEXT,
          feedUrl TEXT NOT NULL,
          isSent INTEGER DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      console.log('News table created');
    } else {
      console.log('News table already exists');
    }
    
    // Create indexes (these will be created if they don't exist)
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_guid ON news(guid);
      CREATE INDEX IF NOT EXISTS idx_link ON news(link);
      CREATE INDEX IF NOT EXISTS idx_title ON news(title);
      CREATE INDEX IF NOT EXISTS idx_feedUrl ON news(feedUrl);
      CREATE INDEX IF NOT EXISTS idx_isSent ON news(isSent)
    `);

    // Settings table for tokens and configuration
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    
    // Verify table structure
    const tableInfo = db.prepare('PRAGMA table_info(news)').all();
    const columnNames = tableInfo.map(col => col.name);
    console.log('Table columns:', columnNames.join(', '));
    
    // Check if all required columns exist
    const requiredColumns = ['id', 'guid', 'title', 'link', 'feedUrl', 'isSent', 'createdAt'];
    const missingColumns = requiredColumns.filter(col => !columnNames.includes(col));
    
    if (missingColumns.length > 0) {
      console.warn(`Missing columns: ${missingColumns.join(', ')}. Recreating table...`);
      // Drop and recreate table
      db.exec('DROP TABLE IF EXISTS news');
      db.exec(`
        CREATE TABLE news (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guid TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          link TEXT,
          feedUrl TEXT NOT NULL,
          isSent INTEGER DEFAULT 0,
          createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_guid ON news(guid);
        CREATE INDEX IF NOT EXISTS idx_link ON news(link);
        CREATE INDEX IF NOT EXISTS idx_title ON news(title);
        CREATE INDEX IF NOT EXISTS idx_feedUrl ON news(feedUrl);
        CREATE INDEX IF NOT EXISTS idx_isSent ON news(isSent)
      `);
      console.log('Table recreated with correct schema');
    }
    
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
    throw error;
  }
}

// Initialize SQLite database with error handling
let db;
try {
  // Ensure directory exists first
  ensureDatabaseDirectory();
  
  // Initialize database synchronously (better-sqlite3 is synchronous)
  db = new Database(DB_FILE);
  console.log(`Database file opened at: ${DB_FILE}`);
  
  // Initialize database schema immediately
  initDatabase();
} catch (error) {
  console.error('Error initializing database:', error);
  console.error('DB_FILE:', DB_FILE);
  console.error('__dirname:', __dirname);
  console.error('Current working directory:', process.cwd());
  
  // Try to create directory and retry
  try {
    const fsSync = require('fs');
    const dbDir = path.dirname(DB_FILE);
    fsSync.mkdirSync(dbDir, { recursive: true });
    // Set permissions
    fsSync.chmodSync(dbDir, 0o755);
    db = new Database(DB_FILE);
    console.log(`Database initialized at: ${DB_FILE} (after creating directory)`);
    // Initialize schema
    initDatabase();
  } catch (retryError) {
    console.error('Failed to initialize database after retry:', retryError);
    console.error('Please check directory permissions and ensure /app is writable');
    process.exit(1);
  }
}

// Settings helpers (stored in SQLite)
function getSetting(key) {
  const stmt = db.prepare('SELECT value FROM settings WHERE key = ?');
  const result = stmt.get(key);
  return result ? result.value : null;
}

function setSetting(key, value) {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);
  stmt.run(key, value);
}

function deleteSetting(key) {
  const stmt = db.prepare('DELETE FROM settings WHERE key = ?');
  stmt.run(key);
}

// Load RSS feeds from config
let rssFeeds = [];
let chatIds = new Set();
const feedSubscribers = new Map(); // feedName (lowercase) -> Set of chat IDs

// Generate consistent GUID from news item (prefer link as it's most stable)
function generateGuid(item) {
  // Prefer link as GUID as it's most stable and unique
  if (item.link) {
    // Extract clean URL without query parameters for consistency
    try {
      const url = new URL(item.link);
      return url.origin + url.pathname;
    } catch (e) {
      return item.link;
    }
  }
  // Fallback to guid if link not available
  if (item.guid) {
    return item.guid;
  }
  // Last resort: use title (less reliable)
  return item.title || 'unknown';
}

// Normalize title for comparison (trim, lowercase)
function normalizeTitle(title) {
  if (!title) return '';
  return title.trim().toLowerCase();
}

// Normalize link for comparison (remove query params, lowercase)
function normalizeLink(link) {
  if (!link) return '';
  try {
    const url = new URL(link);
    return (url.origin + url.pathname).toLowerCase();
  } catch (e) {
    return link.toLowerCase();
  }
}

// Check if news exists in database by guid, title, or link - returns full record
function findExistingNews(guid, title, link) {
  // Check by GUID first (most reliable)
  if (guid) {
    const stmt = db.prepare('SELECT * FROM news WHERE guid = ?');
    const result = stmt.get(guid);
    if (result) return result;
  }
  
  // Check by normalized link
  if (link && link.trim()) {
    try {
      const normalizedLink = normalizeLink(link);
      // Use simpler query that works with SQLite
      const stmt = db.prepare('SELECT * FROM news WHERE link = ? OR link = ? COLLATE NOCASE');
      const result = stmt.get(normalizedLink, link);
      if (result) {
        console.log(`Found duplicate by link: ${link.substring(0, 50)}... (existing GUID: ${result.guid})`);
        return result;
      }
    } catch (error) {
      console.error('Error checking by link:', error);
      // Fallback to simple link check
      try {
        const stmt = db.prepare('SELECT * FROM news WHERE link = ?');
        const result = stmt.get(link);
        if (result) return result;
      } catch (e) {
        console.error('Error in fallback link check:', e);
      }
    }
  }
  
  // Check by normalized title (only if title is meaningful)
  if (title && title.length > 10) {
    try {
      const normalizedTitle = normalizeTitle(title);
      // Use simpler query
      const stmt = db.prepare('SELECT * FROM news WHERE title = ? COLLATE NOCASE');
      const result = stmt.get(normalizedTitle);
      if (result) {
        console.log(`Found duplicate by title: ${title.substring(0, 50)}... (existing GUID: ${result.guid})`);
        return result;
      }
    } catch (error) {
      console.error('Error checking by title:', error);
      // Fallback to simple title check
      try {
        const stmt = db.prepare('SELECT * FROM news WHERE title = ?');
        const result = stmt.get(title);
        if (result) return result;
      } catch (e) {
        console.error('Error in fallback title check:', e);
      }
    }
  }
  
  return null;
}

// Insert news into database (only if not exists) - returns the news record
function insertNews(guid, title, link, feedUrl) {
  // Check if news already exists by guid, title, or link
  const existing = findExistingNews(guid, title, link);
  if (existing) {
    // Return existing record (use its GUID for consistency)
    return existing;
  }
  
  try {
    const stmt = db.prepare('INSERT INTO news (guid, title, link, feedUrl) VALUES (?, ?, ?, ?)');
    stmt.run(guid, title, link, feedUrl);
    // Return the newly inserted record
    const selectStmt = db.prepare('SELECT * FROM news WHERE guid = ?');
    return selectStmt.get(guid);
  } catch (error) {
    // Ignore unique constraint errors (already exists - race condition)
    if (error.code !== 'SQLITE_CONSTRAINT_UNIQUE') {
      console.error('Error inserting news:', error);
    }
    // Return existing record if constraint violation
    const existingCheck = findExistingNews(guid, title, link);
    if (existingCheck) {
      return existingCheck;
    }
    // Fallback to guid lookup
    const stmt = db.prepare('SELECT * FROM news WHERE guid = ?');
    return stmt.get(guid);
  }
}

// Check if news is already sent (by guid, title, or link)
function isNewsSent(guid, title, link) {
  // Find existing record by guid, title, or link
  const existing = findExistingNews(guid, title, link);
  if (existing) {
    return existing.isSent === 1;
  }
  return false;
}

// Mark news as sent (atomic operation) - marks ALL matching records by guid, title, or link
function markNewsAsSent(guid, title, link) {
  // Find existing record first to get its actual GUID
  const existing = findExistingNews(guid, title, link);
  if (!existing) {
    return false; // Doesn't exist, can't mark
  }
  
  // Use the existing record's GUID to mark (most reliable)
  const actualGuid = existing.guid;
  const stmt = db.prepare('UPDATE news SET isSent = 1 WHERE guid = ? AND isSent = 0');
  const result = stmt.run(actualGuid);
  
  // Also mark any other records with same link or title (catch all duplicates)
  if (link && link.trim()) {
    const normalizedLink = normalizeLink(link);
    const linkStmt = db.prepare('UPDATE news SET isSent = 1 WHERE (LOWER(link) = ? OR link = ?) AND isSent = 0');
    linkStmt.run(normalizedLink, link);
  }
  
  if (title && title.length > 10) {
    const normalizedTitle = normalizeTitle(title);
    const titleStmt = db.prepare('UPDATE news SET isSent = 1 WHERE LOWER(TRIM(title)) = ? AND isSent = 0');
    titleStmt.run(normalizedTitle);
  }
  
  return result.changes > 0;
}

// Check if news should be sent (exists, not sent, and can be marked as sending)
function shouldSendNews(guid) {
  const stmt = db.prepare('SELECT isSent FROM news WHERE guid = ?');
  const result = stmt.get(guid);
  if (!result) {
    return false; // Doesn't exist
  }
  return result.isSent === 0; // Not sent yet
}

// Load RSS feeds configuration
async function loadRSSFeeds() {
  try {
    const data = await fs.readFile('rss-feeds.json', 'utf8');
    rssFeeds = JSON.parse(data);
    if (!Array.isArray(rssFeeds)) {
      throw new Error('rss-feeds.json must contain an array');
    }
    console.log(`Loaded ${rssFeeds.length} feeds`);
    const redditFeeds = rssFeeds.filter(isRedditFeed);
    if (redditFeeds.length > 0 && !hasRedditConfig()) {
      console.warn('Reddit feeds found but REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET/REDDIT_REDIRECT_URI not configured.');
    }
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

// Feed helpers
function normalizeFeedName(name) {
  return (name || '').trim().toLowerCase();
}

function findFeedByName(name) {
  const normalized = normalizeFeedName(name);
  return rssFeeds.find(feed => normalizeFeedName(feed.name) === normalized);
}

function getSubscribersForFeed(feedName) {
  const subscribers = new Set(chatIds); // Global subscribers get every feed
  const normalized = normalizeFeedName(feedName);
  const specificSubs = feedSubscribers.get(normalized);
  if (specificSubs) {
    specificSubs.forEach(id => subscribers.add(id));
  }
  return subscribers;
}

function removeChatFromFeedSubscriptions(chatId) {
  for (const subscribers of feedSubscribers.values()) {
    subscribers.delete(chatId);
  }
}

function chatHasAnySubscription(chatId) {
  if (chatIds.has(chatId)) {
    return true;
  }
  for (const subscribers of feedSubscribers.values()) {
    if (subscribers.has(chatId)) {
      return true;
    }
  }
  return false;
}

function getFeedsForChat(chatId) {
  if (chatIds.has(chatId)) {
    return rssFeeds.map(feed => feed.name);
  }
  const feeds = new Set();
  for (const [feedKey, subscribers] of feedSubscribers.entries()) {
    if (subscribers.has(chatId)) {
      const matchingFeed = rssFeeds.find(feed => normalizeFeedName(feed.name) === feedKey);
      feeds.add(matchingFeed?.name || feedKey);
    }
  }
  return Array.from(feeds);
}

function getAllSubscribers() {
  const all = new Set(chatIds);
  for (const subscribers of feedSubscribers.values()) {
    subscribers.forEach(id => all.add(id));
  }
  return all;
}

function isRedditFeed(feedConfig) {
  return (feedConfig?.type || '').toLowerCase() === 'reddit';
}

function hasRedditConfig() {
  return Boolean(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET && REDDIT_REDIRECT_URI);
}

function buildRedditAuthUrl(chatId) {
  const state = crypto.randomBytes(16).toString('hex');
  redditStates.set(chatId, state);
  const params = new URLSearchParams({
    client_id: REDDIT_CLIENT_ID,
    response_type: 'code',
    state,
    redirect_uri: REDDIT_REDIRECT_URI,
    duration: 'permanent',
    scope: REDDIT_SCOPES.join(' ')
  });
  return `${REDDIT_AUTH_BASE}?${params.toString()}`;
}

async function exchangeRedditCodeForTokens(code) {
  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDDIT_REDIRECT_URI
  });

  const response = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reddit token exchange failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function refreshRedditAccessToken(refreshToken) {
  const auth = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken
  });

  const response = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT
    },
    body
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reddit refresh failed (${response.status}): ${text}`);
  }

  return response.json();
}

async function getRedditAccessToken() {
  const refreshToken = getSetting('reddit_refresh_token');
  if (!refreshToken) {
    return null;
  }

  const accessToken = getSetting('reddit_access_token');
  const expiresAtRaw = getSetting('reddit_access_expires_at');
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : 0;

  if (accessToken && expiresAt && Date.now() < expiresAt - 60 * 1000) {
    return accessToken;
  }

  const data = await refreshRedditAccessToken(refreshToken);
  const newAccessToken = data.access_token;
  const newExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;

  setSetting('reddit_access_token', newAccessToken);
  setSetting('reddit_access_expires_at', String(newExpiresAt));

  return newAccessToken;
}

async function getRedditUsername() {
  const cached = getSetting('reddit_username');
  if (cached) {
    return cached;
  }

  const token = await getRedditAccessToken();
  if (!token) {
    return null;
  }

  const response = await fetch(`${REDDIT_API_BASE}/api/v1/me`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': REDDIT_USER_AGENT
    }
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Reddit user lookup failed (${response.status}): ${text}`);
  }

  const data = await response.json();
  if (data?.name) {
    setSetting('reddit_username', data.name);
  }
  return data?.name || null;
}

async function fetchRedditFeedItems(feedConfig, limit) {
  const token = await getRedditAccessToken();
  if (!token) {
    console.warn(`Reddit access token not configured. Skipping ${feedConfig.name}.`);
    return [];
  }

  const source = (feedConfig.source || 'home').toLowerCase();
  const sort = (feedConfig.sort || 'best').toLowerCase();
  let endpoint = '';

  if (source === 'home') {
    endpoint = `/${sort}`;
  } else if (source === 'saved') {
    const username = await getRedditUsername();
    if (!username) {
      console.warn('Unable to resolve Reddit username for saved items.');
      return [];
    }
    endpoint = `/user/${encodeURIComponent(username)}/saved`;
  } else if (source === 'subreddit') {
    if (!feedConfig.subreddit) {
      console.warn(`Reddit feed "${feedConfig.name}" missing subreddit name.`);
      return [];
    }
    endpoint = `/r/${encodeURIComponent(feedConfig.subreddit)}/${sort}`;
  } else {
    console.warn(`Unknown Reddit source "${feedConfig.source}" for ${feedConfig.name}.`);
    return [];
  }

  const params = new URLSearchParams({ limit: String(limit || MAX_NEWS_PER_FEED) });
  const response = await fetch(`${REDDIT_API_BASE}${endpoint}?${params.toString()}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'User-Agent': REDDIT_USER_AGENT
    }
  });

  if (!response.ok) {
    const text = await response.text();
    console.error(`Error fetching Reddit feed ${feedConfig.name}:`, text);
    return [];
  }

  const data = await response.json();
  const children = data?.data?.children || [];

  return children
    .filter(child => child?.data?.id)
    .map(child => {
      const post = child.data;
      return {
        guid: `reddit:${post.id}`,
        title: post.title || 'No title',
        link: `https://www.reddit.com${post.permalink}`,
        contentSnippet: post.selftext ? post.selftext.substring(0, 200) : (post.url || ''),
        pubDate: post.created_utc ? new Date(post.created_utc * 1000).toISOString() : ''
      };
    });
}

// Fetch and parse feed
async function fetchFeedItems(feedConfig, limit) {
  if (isRedditFeed(feedConfig)) {
    return fetchRedditFeedItems(feedConfig, limit);
  }

  try {
    const feed = await parser.parseURL(feedConfig.url);
    return feed?.items || [];
  } catch (error) {
    console.error(`Error fetching RSS feed ${feedConfig.name}:`, error.message);
    return [];
  }
}

// Get latest news and send to specific chat (for manual requests)
async function getLatestNewsForChat(chatId) {
  let newsFound = 0;
  
  for (const feedConfig of rssFeeds) {
    const items = await fetchFeedItems(feedConfig, MAX_MANUAL_NEWS);
    if (!items || items.length === 0) {
      continue;
    }

    // Get multiple latest items (limit to MAX_MANUAL_NEWS)
    const itemsToSend = items.slice(0, MAX_MANUAL_NEWS);
    
    for (const item of itemsToSend) {
      const itemGuid = generateGuid(item);
      const itemTitle = item.title || 'No title';
      const itemLink = item.link || '';
      
      // Insert into database if not exists
      const newsRecord = insertNews(itemGuid, itemTitle, itemLink, feedConfig.url);
      
      if (!newsRecord) {
        continue;
      }
      
      // Check the actual database record's isSent status
      const checkStmt = db.prepare('SELECT isSent FROM news WHERE id = ?');
      const currentStatus = checkStmt.get(newsRecord.id);
      
      if (!currentStatus || currentStatus.isSent === 1) {
        continue; // Already sent
      }
      
      // Double-check by guid, title, link
      if (isNewsSent(newsRecord.guid, itemTitle, itemLink)) {
        continue;
      }
      
      // Mark as sending BEFORE sending using DB ID (most reliable)
      const stmt = db.prepare('UPDATE news SET isSent = 1 WHERE id = ? AND isSent = 0');
      const result = stmt.run(newsRecord.id);
      const marked = result.changes > 0;
      
      if (!marked) {
        // Already marked as sent, skip
        continue;
      }
      
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
        // If sending fails, we could unmark it, but for now we'll leave it marked
        // to avoid spam on retry
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
    const items = await fetchFeedItems(feedConfig, MAX_NEWS_PER_FEED);
    if (!items || items.length === 0) {
      continue;
    }

    // Get items to check (limit to MAX_NEWS_PER_FEED)
    const itemsToCheck = items.slice(0, MAX_NEWS_PER_FEED);
    const newItems = [];
    
    // Find all new items that don't exist in database or haven't been sent
    for (const item of itemsToCheck) {
      const itemGuid = generateGuid(item);
      const itemTitle = item.title || 'No title';
      const itemLink = item.link || '';
      
      // Insert into database if not exists (returns news record)
      const newsRecord = insertNews(itemGuid, itemTitle, itemLink, feedConfig.url);
      
      if (!newsRecord) {
        console.log(`⚠️  Failed to get news record for: ${itemTitle.substring(0, 50)}...`);
        continue;
      }
      
      // Check the actual database record's isSent status
      // Refresh from database to get latest status (important for race conditions)
      const checkStmt = db.prepare('SELECT isSent FROM news WHERE id = ?');
      const currentStatus = checkStmt.get(newsRecord.id);
      
      if (!currentStatus || currentStatus.isSent === 1) {
        // Already sent, skip
        continue;
      }
      
      // Double-check by guid, title, and link to catch any duplicates
      if (isNewsSent(newsRecord.guid, itemTitle, itemLink)) {
        console.log(`⏭️  Duplicate detected and already sent: ${itemTitle.substring(0, 50)}...`);
        continue;
      }
      
      // Use the actual GUID from the database record (in case it was found by link/title)
      newItems.push({ 
        item, 
        guid: newsRecord.guid, // Use actual GUID from DB
        title: itemTitle, 
        link: itemLink,
        dbId: newsRecord.id // Store DB ID for reliable marking
      });
    }

    if (newItems.length === 0) {
      continue; // No new items
    }

    console.log(`Found ${newItems.length} new news item(s) in ${feedConfig.name}`);
    
    // Check if there are any subscribers
    const subscribers = getSubscribersForFeed(feedConfig.name);
    if (subscribers.size === 0) {
      console.log(`⚠️  No subscribers found for ${feedConfig.name}. Users need to send /start or /follow ${feedConfig.name}.`);
      continue;
    }
    
    // Send all new items to all subscribed chats
    let totalSent = 0;
    
    for (const { item, guid: itemGuid, title: itemTitle, link: itemLink, dbId } of newItems) {
      // Double-check if already sent using database ID (most reliable)
      if (dbId) {
        const checkStmt = db.prepare('SELECT isSent FROM news WHERE id = ?');
        const currentStatus = checkStmt.get(dbId);
        if (currentStatus && currentStatus.isSent === 1) {
          console.log(`⏭️  Skipping "${item.title.substring(0, 50)}..." - already sent (checked by DB ID)`);
          continue;
        }
      }
      
      // Also check by guid, title, link
      if (isNewsSent(itemGuid, itemTitle, itemLink)) {
        console.log(`⏭️  Skipping "${item.title.substring(0, 50)}..." - already sent (checked by guid/title/link)`);
        continue;
      }
      
      // Mark as sending BEFORE sending (atomic operation to prevent duplicates)
      // Use DB ID if available for most reliable marking
      let marked = false;
      if (dbId) {
        const stmt = db.prepare('UPDATE news SET isSent = 1 WHERE id = ? AND isSent = 0');
        const result = stmt.run(dbId);
        marked = result.changes > 0;
      }
      
      // Fallback to guid/title/link marking
      if (!marked) {
        marked = markNewsAsSent(itemGuid, itemTitle, itemLink);
      }
      
      if (!marked) {
        // Another process already marked it as sent, skip
        console.log(`⏭️  Skipping "${item.title.substring(0, 50)}..." - already being sent by another process`);
        continue;
      }
      
      console.log(`📤 Preparing to send: "${item.title.substring(0, 50)}..." (GUID: ${itemGuid.substring(0, 30)}..., DB ID: ${dbId})`);
      
      const message = formatNewsMessage(feedConfig.name, item);
      let sentCount = 0;
      
      for (const chatId of subscribers) {
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
            removeChatFromFeedSubscriptions(chatId);
            console.log(`Removed invalid chat ID: ${chatId}`);
          }
        }
      }
      
      // News is already marked as sent above, just log
      if (sentCount > 0) {
        totalSent += sentCount;
        console.log(`✅ Sent "${item.title.substring(0, 50)}..." to ${sentCount} subscriber(s)`);
      } else {
        // If no one received it, we could unmark it, but for safety we'll leave it marked
        console.log(`⚠️  Failed to send "${item.title.substring(0, 50)}..." to any subscriber`);
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
  const wasSubscribed = chatHasAnySubscription(chatId);
  chatIds.add(chatId);
  console.log(`✅ User ${chatId} subscribed. Total subscribers: ${getAllSubscribers().size}`);
  
  const message = wasSubscribed 
    ? '✅ You are already subscribed!\n\n'
    : '✅ You are now subscribed to news updates!\n\n';
  
  await bot.sendMessage(chatId, 
    '👋 Welcome to NewsBot!\n\n' +
    message +
    'I will automatically send you the latest news from configured feeds every 5 minutes.\n\n' +
    'Commands:\n' +
    '/start - Start receiving news updates\n' +
    '/stop - Stop receiving news updates\n' +
    '/status - Check bot status\n' +
    '/feeds - List configured feeds\n' +
    '/follow <feed_name> - Follow updates from a specific feed\n' +
    '/news - Manually check for latest news\n' +
    '/reddit_setup - Start Reddit OAuth setup\n' +
    '/reddit_code <code> - Finish Reddit OAuth setup\n' +
    '/reddit_status - Check Reddit connection\n' +
    '/reddit_logout - Disconnect Reddit'
  );
});

bot.onText(/\/stop/, async (msg) => {
  const chatId = msg.chat.id;
  chatIds.delete(chatId);
  removeChatFromFeedSubscriptions(chatId);
  await bot.sendMessage(chatId, 'You have been unsubscribed from news updates.');
});

bot.onText(/\/status/, async (msg) => {
  const chatId = msg.chat.id;
  const isSubscribed = chatHasAnySubscription(chatId);
  const status = isSubscribed ? '✅ Subscribed' : '❌ Not subscribed';
  const feedCount = rssFeeds.length;
  const followedFeeds = getFeedsForChat(chatId);
  const subscriberCount = getAllSubscribers().size;
  const followingLine = chatIds.has(chatId) 
    ? 'All feeds' 
    : (followedFeeds.length ? followedFeeds.join(', ') : 'None');
  
  await bot.sendMessage(chatId, 
    `Bot Status:\n\n` +
    `Subscription: ${status}\n` +
    `Feeds: ${feedCount}\n` +
    `Total Subscribers: ${subscriberCount}\n` +
    `Following: ${followingLine}`
  );
});

bot.onText(/\/feeds/, async (msg) => {
  const chatId = msg.chat.id;
  if (rssFeeds.length === 0) {
    await bot.sendMessage(chatId, 'No feeds configured.');
    return;
  }
  
  let message = 'dY"? Configured Feeds:\n\n';
  rssFeeds.forEach((feed, index) => {
    if (isRedditFeed(feed)) {
      const source = feed.source || 'home';
      message += `${index + 1}. ${feed.name} (reddit)\n   source: ${source}\n\n`;
    } else {
      message += `${index + 1}. ${feed.name} (rss)\n   ${feed.url}\n\n`;
    }
  });
  
  await bot.sendMessage(chatId, message);
});

bot.onText(/\/follow(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const feedName = match && match[1] ? match[1].trim() : '';
  
  if (!feedName) {
    await bot.sendMessage(chatId, 'Please provide a feed name. Example: /follow vnexpress');
    return;
  }
  
  const feed = findFeedByName(feedName);
  if (!feed) {
    const available = rssFeeds.map(feed => feed.name).join(', ');
    await bot.sendMessage(chatId, `Feed "${feedName}" was not found. Available feeds: ${available}`);
    return;
  }
  
  const normalized = normalizeFeedName(feed.name);
  if (!feedSubscribers.has(normalized)) {
    feedSubscribers.set(normalized, new Set());
  }
  feedSubscribers.get(normalized).add(chatId);
  
  await bot.sendMessage(chatId, `✅ You will now receive updates from "${feed.name}".`);
});



bot.onText(/\/reddit_setup/, async (msg) => {
  const chatId = msg.chat.id;
  if (!hasRedditConfig()) {
    await bot.sendMessage(chatId, 'Reddit OAuth is not configured. Please set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_REDIRECT_URI.');
    return;
  }

  const authUrl = buildRedditAuthUrl(chatId);
  await bot.sendMessage(chatId,
    'Open this URL to authorize NewsBot with your Reddit account:\n' +
    `${authUrl}\n\n` +
    'After approving, you will be redirected to your redirect URI with a code in the URL.\n' +
    'Send the code back here using:\n' +
    '/reddit_code <code>'
  );
});

bot.onText(/\/reddit_code(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const code = match && match[1] ? match[1].trim() : '';

  if (!code) {
    await bot.sendMessage(chatId, 'Please provide the code from the Reddit redirect URL. Example: /reddit_code abc123');
    return;
  }

  if (!hasRedditConfig()) {
    await bot.sendMessage(chatId, 'Reddit OAuth is not configured. Please set REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, and REDDIT_REDIRECT_URI.');
    return;
  }

  try {
    const data = await exchangeRedditCodeForTokens(code);
    if (data.refresh_token) {
      setSetting('reddit_refresh_token', data.refresh_token);
    }
    if (data.access_token) {
      setSetting('reddit_access_token', data.access_token);
      const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
      setSetting('reddit_access_expires_at', String(expiresAt));
    }
    deleteSetting('reddit_username');
    redditStates.delete(chatId);

    if (!data.refresh_token) {
      await bot.sendMessage(chatId, 'Reddit authorized, but no refresh token was returned. If this is the first setup, make sure you approved with duration=permanent.');
      return;
    }

    await bot.sendMessage(chatId, 'Reddit OAuth setup complete. Reddit feeds are now enabled.');
  } catch (error) {
    console.error('Error completing Reddit OAuth:', error);
    await bot.sendMessage(chatId, 'Failed to complete Reddit OAuth setup. Please try again.');
  }
});

bot.onText(/\/reddit_status/, async (msg) => {
  const chatId = msg.chat.id;
  const refreshToken = getSetting('reddit_refresh_token');
  if (!refreshToken) {
    await bot.sendMessage(chatId, 'Reddit is not connected. Use /reddit_setup to start.');
    return;
  }

  try {
    await getRedditAccessToken();
    const username = await getRedditUsername();
    await bot.sendMessage(chatId, `Reddit connected as ${username || 'unknown user'}.`);
  } catch (error) {
    console.error('Error checking Reddit status:', error);
    await bot.sendMessage(chatId, 'Reddit is configured but token refresh failed. Try /reddit_setup again.');
  }
});

bot.onText(/\/reddit_logout/, async (msg) => {
  const chatId = msg.chat.id;
  deleteSetting('reddit_refresh_token');
  deleteSetting('reddit_access_token');
  deleteSetting('reddit_access_expires_at');
  deleteSetting('reddit_username');
  await bot.sendMessage(chatId, 'Reddit connection removed.');
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
  
  // Database is already initialized above, just verify
  console.log('Database ready');
  
  await loadRSSFeeds();
  
  // Initial check
  await checkForNewNews();
  
  // Set up periodic checking
  setInterval(checkForNewNews, CHECK_INTERVAL);
  
  console.log(`NewsBot is running! Checking for news every ${CHECK_INTERVAL / 1000 / 60} minutes.`);
  console.log(`Monitoring ${rssFeeds.length} feed(s).`);
  console.log(`Current subscribers: ${getAllSubscribers().size}`);
  if (getAllSubscribers().size === 0) {
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

