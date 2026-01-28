// bot.js
import { Telegraf } from 'telegraf';
import { scrapeNotionPage, parseTopics } from './notion-scraper.js';
import { createHash } from 'crypto';
import http from 'http';
import { URL } from 'url';
import 'dotenv/config';

console.log('🚀 Запуск бота...');

if (!process.env.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN не найден в .env!');
  process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN, {
  handlerTimeout: 600000 // 10 минут
});

const cache = new Map();
const headlinesStore = new Map(); // key: notion URL, value: { title, headlines, updatedAt }
const HEADLINES_PORT = Number(process.env.HEADLINES_PORT || 3131);

bot.catch((err, ctx) => {
  console.error('❌ Ошибка бота:', err.message);
});

function hashTopic(topic) {
  const content = JSON.stringify({
    header: topic.header,
    body: topic.body,
    comments: topic.comments
  });
  return createHash('md5').update(content).digest('hex');
}

function getCommentEmoji(text) {
  const lower = text.toLowerCase();
  if (/видео|video|ролик|клип|youtube|youtu\.be|vimeo/.test(lower)) return '🎬';
  if (/аудио|audio|звук|подкаст|музык|spotify|soundcloud/.test(lower)) return '🎵';
  if (/фото|photo|картинк|изображ|скрин|\.jpg|\.png|\.gif/.test(lower)) return '📷';
  return '🔗';
}

function dedupeLinks(links) {
  const seen = new Map();
  const result = [];
  for (const item of links) {
    // Убираем #:~:text= и сравниваем базовые URL
    const baseUrl = item.split('#:~:text=')[0].split('#')[0];
    if (!seen.has(baseUrl)) {
      seen.set(baseUrl, true);
      // Сохраняем только базовый URL (без #:~:text=)
      result.push(baseUrl);
    }
  }
  return result;
}

// Извлекает ссылки из текста
function extractLinksFromText(text) {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/g;
  const matches = text.match(urlRegex) || [];
  return matches.map(url => {
    // Убираем trailing пунктуацию
    return url.replace(/[.,;:!?)]+$/, '');
  });
}

function separateComments(comments) {
  const textComments = [];
  const links = [];
  for (const item of comments) {
    if (/^https?:\/\//.test(item)) {
      links.push(item);
    } else {
      const cleaned = item.replace(/^\/+/, '').trim();
      if (cleaned) textComments.push(cleaned);
    }
  }
  return { textComments, links: dedupeLinks(links) };
}

function formatDuration(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} сек`;
  return `${Math.floor(sec / 60)} мин ${sec % 60} сек`;
}

function cleanHeadline(header) {
  if (!header) return '';
  // убираем завершающие "(число)" и лишние пробелы
  return header.replace(/\s*\(\d+\)\s*$/, '').trim();
}

function buildHeadlinesText(topics) {
  return topics
    .map(t => cleanHeadline(t.header))
    .filter(Boolean)
    .join('\n');
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Безопасная отправка с retry при 429
async function safeSend(ctx, text, options = {}) {
  const maxRetries = 3;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      await ctx.reply(text, options);
      return true;
    } catch (e) {
      if (e.response?.error_code === 429) {
        const retryAfter = e.response.parameters?.retry_after || 30;
        console.log(`⏳ Rate limit, жду ${retryAfter} сек...`);
        await sleep((retryAfter + 1) * 1000);
      } else {
        console.log('⚠️ Send failed:', e.message);
        if (attempt === maxRetries - 1) {
          // Последняя попытка — отправляем без форматирования
          try {
            await ctx.reply(text.replace(/<[^>]+>/g, ''));
          } catch {}
        }
        return false;
      }
    }
  }
  return false;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatExpandableQuote(text) {
  const escaped = escapeHtml(text);
  return `<blockquote expandable>${escaped}</blockquote>`;
}

bot.command('start', (ctx) => {
  ctx.reply(
    '👋 Привет! Отправь ссылку на Notion.\n\n' +
    'При повторной отправке покажу только изменения!\n\n' +
    '/clear — сбросить кэш'
  );
});

bot.command('test', (ctx) => ctx.reply(`✅ Работаю! Кэш: ${cache.size}`));
bot.command('clear', (ctx) => { cache.clear(); ctx.reply('🗑 Кэш очищен'); });

async function handleParse(ctx, url) {
  if (!url || !url.includes('notion')) {
    return ctx.reply('❌ Отправь ссылку на Notion');
  }
  
  const startTime = Date.now();
  const status = await ctx.reply('⏳ Загружаю...');
  
  try {
    const content = await scrapeNotionPage(url, async (msg) => {
      try {
        await ctx.telegram.editMessageText(ctx.chat.id, status.message_id, null, msg);
      } catch {}
    });
    
    const { title, topics } = parseTopics(content);
    const cachedData = cache.get(url) || { topics: new Map() };
    const cachedTopics = cachedData.topics;
    
    const newTopics = [];
    const changedTopics = [];
    let unchangedCount = 0;
    const newCache = new Map();
    
    for (const topic of topics) {
      const hash = hashTopic(topic);
      newCache.set(topic.header, hash);
      
      if (!cachedTopics.has(topic.header)) {
        newTopics.push(topic);
      } else if (cachedTopics.get(topic.header) !== hash) {
        changedTopics.push(topic);
      } else {
        unchangedCount++;
      }
    }
    
    cache.set(url, { topics: newCache, timestamp: Date.now() });
    
    try { await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id); } catch {}
    
    const elapsed = formatDuration(Date.now() - startTime);
    const headlinesText = buildHeadlinesText(topics);
    headlinesStore.set(url, {
      title,
      headlines: headlinesText,
      updatedAt: Date.now()
    });
    
    if (cachedTopics.size === 0) {
      await safeSend(ctx, `📄 ${title}\n📊 Тем: ${topics.length}\n⏱ ${elapsed}`);
      await sleep(500);
      await sendTopics(ctx, topics);
    } else {
      let statsMsg = `📄 ${title}\n\n`;
      statsMsg += `🆕 Новых: ${newTopics.length}\n`;
      statsMsg += `✏️ Изменённых: ${changedTopics.length}\n`;
      statsMsg += `✅ Без изменений: ${unchangedCount}\n`;
      statsMsg += `⏱ ${elapsed}`;
      
      await safeSend(ctx, statsMsg);
      await sleep(500);
      
      if (newTopics.length === 0 && changedTopics.length === 0) {
        await safeSend(ctx, '👍 Изменений нет!');
        // Файл с заголовками больше не отправляем автоматически
        return;
      }
      
      if (newTopics.length > 0) {
        await safeSend(ctx, `🆕 НОВЫЕ (${newTopics.length}):`);
        await sleep(500);
        await sendTopics(ctx, newTopics, '🆕');
      }
      
      if (changedTopics.length > 0) {
        await safeSend(ctx, `✏️ ИЗМЕНЁННЫЕ (${changedTopics.length}):`);
        await sleep(500);
        await sendTopics(ctx, changedTopics, '✏️');
      }
    }
    
    await safeSend(ctx, '✅ Готово!');
    // Файл с заголовками больше не отправляем автоматически
    
  } catch (e) {
    console.error('❌', e.message);
    await safeSend(ctx, `❌ Ошибка: ${e.message}`);
  }
}

async function sendTopics(ctx, topics, emoji = '📰') {
  for (let i = 0; i < topics.length; i++) {
    const t = topics[i];
    
    // Заголовок
    await safeSend(ctx, `${emoji} ${i + 1}/${topics.length}: ${t.header}`);
    await sleep(500);
    
    // Извлекаем ссылки из текста
    const linksInBody = t.body ? extractLinksFromText(t.body) : [];
    
    // Текст без ссылок (или с ними, но ссылки вынесем отдельно)
    let bodyText = t.body || '';
    
    // Убираем ссылки из текста для читаемости
    for (const link of linksInBody) {
      bodyText = bodyText.replace(link, '').replace(/\s{2,}/g, ' ');
    }
    bodyText = bodyText.trim();
    
    if (bodyText) {
      if (bodyText.length > 3500) {
        bodyText = bodyText.slice(0, 3500) + '\n...';
      }
      
      const quoted = formatExpandableQuote(bodyText);
      await safeSend(ctx, quoted, { parse_mode: 'HTML' });
      await sleep(500);
    }
    
    // Объединяем все комментарии и ссылки
    const allComments = [...(t.comments || [])];
    
    // Добавляем ссылки из текста
    for (const link of linksInBody) {
      if (!allComments.includes(link)) {
        allComments.push(link);
      }
    }
    
    if (allComments.length > 0) {
      const { textComments, links } = separateComments(allComments);
      
      // Текстовые комментарии
      for (const comment of textComments) {
        await safeSend(ctx, `💬 ${comment}`);
        await sleep(500);
      }
      
      // Ссылки
      for (const link of links) {
        const em = getCommentEmoji(link);
        await safeSend(ctx, `${em} ${link}`);
        await sleep(500);
      }
    }
    
    await sleep(700);
  }
}

async function sendHeadlinesMessage(ctx, text) {
  if (!text || !text.trim()) return;
  const lines = text.split(/\r?\n/).filter(Boolean);
  // Telegram лимит ~4096 символов; разобьём по кускам
  const chunkSize = 3800;
  let chunk = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if ((chunk + line + '\n').length > chunkSize) {
      await safeSend(ctx, chunk.trimEnd());
      chunk = '';
    }
    chunk += line + '\n';
  }
  if (chunk.trim().length) {
    await safeSend(ctx, chunk.trimEnd());
  }
}

bot.command('parse', async (ctx) => {
  const url = ctx.message.text.replace('/parse', '').trim();
  await handleParse(ctx, url);
});

bot.command('raw', async (ctx) => {
  const url = ctx.message.text.replace('/raw', '').trim();
  if (!url) return ctx.reply('❌ Укажи URL');
  
  const status = await ctx.reply('⏳ Загружаю...');
  
  try {
    const content = await scrapeNotionPage(url, () => {});
    
    await ctx.replyWithDocument({
      source: Buffer.from(content, 'utf-8'),
      filename: 'notion-content.txt'
    });
    
    await ctx.telegram.deleteMessage(ctx.chat.id, status.message_id);
  } catch (e) {
    console.error('❌', e.message);
    await ctx.reply(`❌ ${e.message}`);
  }
});

bot.command('headlines', async (ctx) => {
  const url = ctx.message.text.replace('/headlines', '').trim();
  if (!url) return ctx.reply('❌ Укажи URL');
  const entry = headlinesStore.get(url);
  if (!entry) return ctx.reply('❌ Для этой ссылки ещё нет заголовков. Сначала сделайте /parse.');
  await sendHeadlinesMessage(ctx, entry.headlines);
});

// Алиас /headers
bot.command('headers', async (ctx) => {
  const url = ctx.message.text.replace('/headers', '').trim();
  if (!url) return ctx.reply('❌ Укажи URL');
  const entry = headlinesStore.get(url);
  if (!entry) return ctx.reply('❌ Для этой ссылки ещё нет заголовков. Сначала сделайте /parse.');
  await sendHeadlinesMessage(ctx, entry.headlines);
});

bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return;
  
  if (text.includes('notion.site') || text.includes('notion.so')) {
    await handleParse(ctx, text);
  } else {
    ctx.reply('📝 Отправь ссылку на Notion');
  }
});

bot.launch().then(() => {
  console.log('✅ Бот запущен!');
  startHeadlinesServer();
});

process.once('SIGINT', () => bot.stop());
process.once('SIGTERM', () => bot.stop());

function startHeadlinesServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlObj = new URL(req.url, `http://localhost:${HEADLINES_PORT}`);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      
      if (urlObj.pathname === '/headlines') {
        const target = urlObj.searchParams.get('url');
        if (!target) {
          res.statusCode = 400;
          res.end('missing url param');
          return;
        }
        const entry = headlinesStore.get(target);
        if (!entry) {
          res.statusCode = 404;
          res.end('not found');
          return;
        }
        res.end(entry.headlines || '');
        return;
      }
      
      res.statusCode = 404;
      res.end('not found');
    } catch (e) {
      res.statusCode = 500;
      res.end('internal error');
    }
  });
  
  server.listen(HEADLINES_PORT, () => {
    console.log(`🌐 Локальный сервер заголовков: http://localhost:${HEADLINES_PORT}/headlines?url=<notion_url>`);
  });
}
