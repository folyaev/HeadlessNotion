// notion-scraper.js
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function scrapeNotionPage(url, onProgress = () => {}) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    
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
