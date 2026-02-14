// notion-scraper.js
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function scrapeNotionPage(url, onProgress = () => {}) {
  const debugRef = process.env.NOTION_DEBUG_REF || '';
  const headlessEnv = process.env.PUPPETEER_HEADLESS;
  const headless =
    headlessEnv === undefined
      ? 'new'
      : !['0', 'false', 'no'].includes(String(headlessEnv).toLowerCase());
  const slowMo = Number(process.env.PUPPETEER_SLOWMO || 0) || 0;
  const devtools = ['1', 'true', 'yes'].includes(
    String(process.env.PUPPETEER_DEVTOOLS || '').toLowerCase()
  );
  const viewportWidth = Number(process.env.PUPPETEER_WIDTH || 1280) || 1280;
  const viewportHeight = Number(process.env.PUPPETEER_HEIGHT || 800) || 800;

  const browser = await puppeteer.launch({
    headless,
    slowMo,
    devtools,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      `--window-size=${viewportWidth},${viewportHeight}`
    ],
    defaultViewport: { width: viewportWidth, height: viewportHeight }
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: viewportWidth, height: viewportHeight });
    if (debugRef) {
      await page.evaluateOnNewDocument((ref) => {
        window.__NOTION_DEBUG_REF = ref;
      }, debugRef);
    }
    
    page.on('console', msg => {
      const text = msg.text();
      if (text.startsWith('⏳') || text.startsWith('📜') || text.startsWith('🔓') || 
          text.startsWith('📦') || text.startsWith('🔄') || text.startsWith('✅')) {
        console.log('    [browser]', text);
        onProgress(text);
      }
    });

    await page.goto(url, { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });

    const scriptContent = fs.readFileSync(
      path.join(__dirname, 'notion-script.js'), 
      'utf-8'
    );

    const content = await page.evaluate(scriptContent, { timeout: 180000 });
    
    return content;
  } finally {
    await browser.close();
  }
}

export function parseTopics(content) {
  const lines = content.split('\n');
  let title = 'Без названия';
  const topics = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith('# ')) {
      title = line.slice(2).trim();
    } else if (line.startsWith('### ')) {
      if (current) topics.push(current);
      const headerMatch = line.slice(4).match(/^(.+?)(?:\s*$(\d+)$)?$/);
      current = {
        header: headerMatch ? headerMatch[1].trim() : line.slice(4).trim(),
        comments: [],
        body: ''
      };
    } else if (current) {
      const numMatch = line.match(/^(\d+)\.\s+(.+)$/);
      if (numMatch) {
        current.comments.push(numMatch[2]);
      } else if (line.trim()) {
        current.body += (current.body ? '\n' : '') + line;
      }
    }
  }
  
  if (current) topics.push(current);
  
  return { title, topics };
}
