// notion-script.js
(async () => {
  const SCROLL_PAUSE = 200;
  const TOGGLE_PAUSE = 150;
  const COMMENT_CLICK_PAUSE = 400;
  const POPOVER_WAIT = 700;
  const INITIAL_WAIT = 2000;
  
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const qsa = (root, sel) => {
    try { return Array.from((root || document).querySelectorAll(sel)); }
    catch { return []; }
  };
  
  async function progress(msg) {
    console.log(msg);
    if (typeof reportProgress === 'function') {
      try { await reportProgress(msg); } catch {}
    }
  }
  
  async function waitFor(selector, timeout = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      const el = document.querySelector(selector);
      if (el) return el;
      await sleep(100);
    }
    return null;
  }
  
  const URL_RE = /\bhttps?:\/\/[^\s)]+/g;

  const COMMENT_BTN_SEL = '[aria-label*="omment" i],button[data-testid*="comment" i],[data-testid*="comment-pill" i],.notion-comment-count';
  const COMMENT_POPOVER_SEL = 'div[role="dialog"],div[role="tooltip"],[data-popover],[class*="popover" i],[class*="comments" i]';

  async function scrollAll() {
    let lastH = 0, attempts = 0;
    while (attempts < 20) {
      window.scrollBy(0, 500);
      await sleep(SCROLL_PAUSE);
      const h = document.documentElement.scrollHeight;
      if (h === lastH) { attempts++; if (attempts > 2) break; }
      else attempts = 0;
      lastH = h;
    }
    window.scrollTo(0, 0);
    await sleep(300);
  }

  async function expandAllToggles() {
    for (let pass = 0; pass < 3; pass++) {
      const toggles = qsa(document, '[role="button"][aria-expanded="false"]')
        .filter(b => b.closest('[data-block-id], .notion-page-content, main'));
      if (toggles.length === 0) break;
      for (const toggle of toggles) {
        try { toggle.click(); } catch {}
        await sleep(TOGGLE_PAUSE);
      }
      await sleep(200);
    }
  }

  function findCommentButtonsForBlock(block) {
    const br = block.getBoundingClientRect();
    const Y_PAD = 12;
    return qsa(document, COMMENT_BTN_SEL).filter(b => {
      if (b.closest('a,[href]')) return false;
      const r = b.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false;
      const cy = (r.top + r.bottom) / 2;
      return cy >= (br.top - Y_PAD) && cy <= (br.bottom + Y_PAD);
    });
  }

  async function waitForStableContent(pop, maxWait = 2000) {
    let lastText = '';
    let stableCount = 0;
    const start = Date.now();
    
    while (Date.now() - start < maxWait) {
      const currentText = pop.innerText || '';
      if (currentText === lastText && currentText.length > 0) {
        stableCount++;
        if (stableCount >= 3) return;
      } else {
        stableCount = 0;
      }
      lastText = currentText;
      await sleep(100);
    }
  }

  function extractFromPopover(pop, heading) {
    const items = [];
    const headingLower = (heading || '').toLowerCase().trim();
    
    qsa(pop, 'a[href]').forEach(a => {
      if (a.href && !items.includes(a.href)) {
        items.push(a.href);
      }
    });
    
    const text = pop.innerText || '';
    
    (text.match(URL_RE) || []).forEach(u => {
      if (!items.includes(u)) items.push(u);
    });
    
    const commentBlocks = [];
    
    qsa(pop, '[class*="comment-content"], [class*="commentContent"], [class*="comment_content"]').forEach(el => {
      const t = (el.innerText || '').trim();
      if (t && t.length > 0) commentBlocks.push(t);
    });
    
    if (commentBlocks.length === 0) {
      const authorDatePattern = /(?:^|\n)([A-ZА-ЯЁ][a-zа-яё]+(?:\s+[A-ZА-ЯЁ][a-zа-яё]+)?)\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|\d{1,2}[dhmдчм]|\d{1,2}\s+(?:д|ч|м|d|h|m))/gi;
      
      const parts = text.split(authorDatePattern).filter(p => p && p.trim());
      
      for (const part of parts) {
        const cleaned = part
          .replace(/^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{0,2}\s*/i, '')
          .replace(/^\d{1,2}\s*(?:d|h|m|д|ч|м)\s*/i, '')
          .replace(/\s*(ответить|reply)$/i, '')
          .trim();
        
        if (cleaned && cleaned.length > 2) {
          const lines = cleaned.split('\n').map(l => l.trim()).filter(l => l.length > 0);
          lines.forEach(line => {
            if (!commentBlocks.includes(line)) {
              commentBlocks.push(line);
            }
          });
        }
      }
    }
    
    commentBlocks.forEach(ct => {
      const cleaned = ct.replace(/\s*(ответить|reply)$/i, '').trim();
      
      if (!cleaned || cleaned.length < 2) return;
      if (/^\d{1,2}$/.test(cleaned) && Number(cleaned) <= 31) return;
      if (/^(ответить|reply|add comment|resolve|resolved|edit|delete|удалить|изменить)$/i.test(cleaned)) return;
      if (/^\d{1,2}:\d{2}$/.test(cleaned)) return;
      if (/^\d+\s*(d|д|day|дн|h|ч|час|m|м|min|мин|s|с|sec|сек)\s*(ago|назад)?$/i.test(cleaned)) return;
      if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d/i.test(cleaned)) return;
      if (/^\d{1,2}\s+(янв|фев|мар|апр|мая|июн|июл|авг|сен|окт|ноя|дек)/i.test(cleaned)) return;
      if (/^руслан\s+усачев$/i.test(cleaned)) return;
      if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}$/i.test(cleaned)) return;
      if (cleaned.toLowerCase() === headingLower) return;
      
      if (!items.some(x => x.toLowerCase() === cleaned.toLowerCase())) {
        items.push(cleaned);
      }
    });
    
    return items;
  }

  async function collectRefs(block, heading) {
    const btns = findCommentButtonsForBlock(block);
    const refs = [];
    
    for (const btn of btns) {
      try {
        document.body.click();
        await sleep(50);
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(100);
        
        btn.scrollIntoView({ block: 'center' });
        await sleep(100);
        
        const rr = btn.getBoundingClientRect();
        btn.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: rr.left + 2, clientY: rr.top + 2 }));
        await sleep(50);
        
        btn.click();
        await sleep(COMMENT_CLICK_PAUSE);
        
        let pop = null;
        for (let i = 0; i < 15 && !pop; i++) {
          await sleep(150);
          const popovers = qsa(document, COMMENT_POPOVER_SEL)
            .filter(el => el.getBoundingClientRect().width > 50 && el.getBoundingClientRect().height > 30);
          if (popovers.length) {
            let best = null, minDist = Infinity;
            for (const p of popovers) {
              const pr = p.getBoundingClientRect();
              const dist = Math.abs(pr.left - rr.left) + Math.abs(pr.top - rr.top);
              if (dist < minDist) { minDist = dist; best = p; }
            }
            pop = best;
          }
        }
        
        if (pop) {
          await waitForStableContent(pop, 2000);
          const items = extractFromPopover(pop, heading);
          items.forEach(item => {
            if (!refs.includes(item)) refs.push(item);
          });
        }
        
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        await sleep(100);
      } catch {}
    }
    
    return refs;
  }

  function getHeading(el) {
    const h = el.querySelector('h1,h2,h3,h4,h5,h6');
    return h ? (h.innerText || '').replace(/\u00A0/g, ' ').replace(/^\*+|\*+$/g, '').trim() : '';
  }

  function extractMarkers(text) {
    const markers = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\/[A-Za-zА-Яа-яЁё]/.test(trimmed) && 
          !trimmed.startsWith('/http') && 
          !trimmed.startsWith('//')) {
        markers.push(trimmed);
      }
    }
    return markers;
  }

  // Извлекает текст из блока с правильными переносами
  function extractTextWithBreaks(element) {
    const lines = [];
    
    // Находим все текстовые блоки внутри
    const textBlocks = element.querySelectorAll('[data-block-id], p, div[class*="text"], li');
    
    if (textBlocks.length > 0) {
      textBlocks.forEach(block => {
        // Пропускаем кнопки и служебные элементы
        if (block.closest('button, [role="button"], [aria-label*="comment"]')) return;
        
        const text = (block.innerText || '').replace(/\u00A0/g, ' ').trim();
        if (text && !lines.includes(text)) {
          lines.push(text);
        }
      });
    }
    
    // Если не нашли блоки — берём весь текст
    if (lines.length === 0) {
      const text = (element.innerText || '').replace(/\u00A0/g, ' ').trim();
      if (text) lines.push(text);
    }
    
    return lines.join('\n\n');
  }

  function extractText(block, heading) {
    const clone = block.cloneNode(true);
    
    // Удаляем служебные элементы
    qsa(clone, 'button,[role="button"],[aria-label*="comment" i]').forEach(el => el.remove());
    qsa(clone, 'span,div').forEach(el => {
      const t = (el.textContent || '').trim();
      if (/^\d+$/.test(t) && Number(t) <= 999 && !el.querySelector('*')) el.remove();
    });

    // Собираем текст из дочерних блоков
    const childBlocks = qsa(clone, '[data-block-id]');
    let rawText = '';
    
    if (childBlocks.length > 0) {
      // Есть вложенные блоки — берём текст из каждого
      const texts = [];
      childBlocks.forEach(child => {
        const t = (child.innerText || '').replace(/\u00A0/g, ' ').trim();
        if (t) texts.push(t);
      });
      rawText = texts.join('\n\n');
    } else {
      // Нет вложенных — берём весь текст
      rawText = (clone.innerText || '').replace(/\u00A0/g, ' ');
    }
    
    // Убираем заголовок из начала
    const cleanHead = heading.replace(/[«»"""']/g, '').toLowerCase().trim();
    const lines = rawText.split('\n');
    while (lines.length && lines[0].replace(/[«»"""']/g, '').toLowerCase().trim() === cleanHead) {
      lines.shift();
    }
    rawText = lines.join('\n');
    
    // Форматируем
    return formatText(rawText);
  }

  function formatText(text) {
    if (!text) return '';
    
    // Защищаем URL
    const urls = [];
    text = text.replace(/https?:\/\/[^\s]+/g, (m) => {
      urls.push(m);
      return `__URL${urls.length - 1}__`;
    });
    
    // Защищаем конструкции типа и/или
    text = text.replace(/\bи\/или\b/gi, '__IILI__');
    
    // Разбиваем склеенные предложения:
    // Цифра + Заглавная буква (21В → 21\n\nВ)
    text = text.replace(/(\d)([A-ZА-ЯЁ][a-zа-яё])/g, '$1\n\n$2');
    
    // Маленькая буква + Заглавная без пробела (словоСлово → слово\n\nСлово)
    text = text.replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1\n\n$2');
    
    // После .!? перед Заглавной
    text = text.replace(/([.!?])([A-ZА-ЯЁ])/g, '$1\n\n$2');
    
    // Убираем множественные переносы
    text = text.replace(/\n{3,}/g, '\n\n');
    
    // Убираем пробелы в начале строк
    text = text.split('\n').map(line => line.trim()).join('\n');
    
    // Восстанавливаем
    text = text.replace(/__IILI__/g, 'и/или');
    urls.forEach((url, i) => {
      text = text.replace(`__URL${i}__`, url);
    });
    
    return text.trim();
  }

  // === MAIN ===
  await progress('⏳ Загружаю страницу...');
  await waitFor('main,.notion-page-content,[data-root="true"]', 15000);
  await sleep(INITIAL_WAIT);
  
  await progress('📜 Прокручиваю...');
  await scrollAll();
  
  await progress('🔓 Раскрываю блоки...');
  await expandAllToggles();
  await scrollAll();
  await sleep(500);

  const root = document.querySelector('.notion-page-content') ||
    document.querySelector('[data-root="true"]') ||
    document.querySelector('main') || document.body;

  const title = (document.querySelector('h1')?.innerText || document.title || 'Без заголовка')
    .replace(/\u00A0/g, ' ').trim();
  let output = `# ${title}\n\n`;

  let blocks = qsa(root, '[data-block-id]').filter(b => {
    const parent = b.parentElement?.closest('[data-block-id]');
    return !parent || parent === root;
  });
  
  const total = blocks.length;
  await progress(`📦 Обрабатываю ${total} блоков...`);
  
  let refsCount = 0;
  
  for (let i = 0; i < blocks.length; i++) {
    if (i % 5 === 0) await progress(`🔄 ${i + 1}/${total}...`);
    
    const block = blocks[i];
    const heading = getHeading(block);
    const text = extractText(block, heading);
    const markers = extractMarkers(text);
    const popoverRefs = await collectRefs(block, heading);
    const allRefs = [...popoverRefs, ...markers];
    refsCount += allRefs.length;
    
    if (heading) {
      const count = allRefs.length ? ` (${allRefs.length})` : '';
      output += `### ${heading}${count}\n`;
    }
    
    if (allRefs.length) {
      allRefs.forEach((r, j) => output += `${j + 1}. ${r}\n`);
      output += '\n';
    }
    
    if (text) output += text + '\n\n';
  }

  if (!blocks.length) output += (root.innerText || '').replace(/\u00A0/g, ' ');

  await progress(`✅ Готово! ${total} блоков, ${refsCount} комментариев`);
  return output.trim();
})();
