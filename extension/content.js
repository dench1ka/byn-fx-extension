// BYN→FX Content Script v1.6.3
// • Поддержка цен в ₽/RUB на Куфаре (недвижимость) — кросс-конвертация через BYN
// • Универсальный парсер любой валюты → целевая

(function () {
  'use strict';

  const CACHE_KEY       = 'avby_rates_cache';
  const CACHE_TTL       = 3600 * 1000;
  const BADGE_CLASS     = 'byn-fx-badge';
  const DONE_ATTR       = 'data-bynfx';
  const SETTINGS_KEY    = 'bynUsdSites';
  const TARGET_CURR_KEY = 'byn_target_currency';

  const FALLBACK = {
    BYN:1, USD:3.25, EUR:3.55, RUB:0.035, PLN:0.82, CNY:0.45, GBP:4.10
  };

  const SYMBOLS = { USD:'$', EUR:'€', RUB:'₽', PLN:'zł', CNY:'¥', GBP:'£', BYN:'Br' };

  // Паттерны обнаружения иностранных валют в тексте
  // Каждый элемент: [regex-для-обнаружения, код-валюты]
  const FOREIGN_PATTERNS = [
    [/[$]|(?<!\d)\bUSD\b/,    'USD'],
    [/€|(?<!\d)\bEUR\b/i,     'EUR'],
    [/₽|(?<!\d)\bRUB\b/i,    'RUB'],
    [/£|(?<!\d)\bGBP\b/i,    'GBP'],
    [/¥|(?<!\d)\bCNY\b/i,    'CNY'],
    [/zł|(?<!\d)\bPLN\b/i,   'PLN'],
    [/₴|(?<!\d)\bUAH\b/i,    'UAH'],
  ];

  let rates      = {};
  let isEnabled  = true;
  let targetCurr = 'USD';
  let observer   = null;
  let isProcBusy = false;
  let schedTimer = null;

  // ─── Определение сайта ────────────────────────────────────────────────
  const HOST = location.hostname.replace(/^www\./, '');
  const SITE = HOST.includes('kufar.by') ? 'kufar' :
               HOST.includes('av.by')    ? 'avby'  : 'generic';

  // ─── УНИВЕРСАЛЬНЫЙ ПАРСЕР ─────────────────────────────────────────────

  /**
   * Парсит цену в любой валюте.
   * Возвращает { amount: number, currency: string } | null
   *
   * Примеры:
   *   "5 500 000 ₽"  → { amount: 5500000, currency: 'RUB' }
   *   "180 000 р."   → { amount: 180000,  currency: 'BYN' }
   *   "$45,000"      → { amount: 45000,   currency: 'USD' }
   *   "€35 000"      → { amount: 35000,   currency: 'EUR' }
   *   "97 000 км"    → null  (пробег)
   *   "2021"         → null  (год, нет суффикса)
   */
  // Единицы измерения которые точно не являются ценой
  // Важно: \b не работает с кириллицей в JS, поэтому просто substring-паттерны
  const NOT_PRICE_RE = /см|мм|м²|м2|кг(?!\s*[рр])|Вт|кВт|ГБ|МБ|ТБ|\bGB\b|\bMB\b|\bTB\b|GHz|MHz|мл|дюйм|inch|[xхXХ×]\s*\d|\d\s*[xхXХ×]/i;

  // Паттерны дат и времени — не являются ценой
  // "09:34", "12:47", "14 мар.", "11 мая", "2 взрослых", "5,0" (рейтинг)
  const NOT_DATE_TIME_RE = /\d{1,2}:\d{2}|(?:янв|фев|мар|апр|май|июн|июл|авг|сен|окт|ноя|дек)[а-я.]*|пн|вт|ср|чт|пт|сб|вс/i;

  function parseAnyPrice(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.trim();
    if (!t || t.length > 80) return null;

    // Пробег
    if (/км/i.test(t)) return null;
    // Единицы измерения (размеры, мощность, память и т.п.)
    if (NOT_PRICE_RE.test(t)) return null;
    // Даты и время ("09:34", "14 мар.", "21 мая, чт")
    if (NOT_DATE_TIME_RE.test(t)) return null;

    // Определяем иностранную валюту
    for (const [re, code] of FOREIGN_PATTERNS) {
      if (re.test(t)) {
        const n = extractNumber(t);
        if (n === null) return null;
        // Верхний порог зависит от валюты
        const maxAmt = code === 'RUB' ? 500_000_000 : 10_000_000;
        const minAmt = code === 'RUB' ? 10_000 : 100;
        if (n < minAmt || n > maxAmt) return null;
        return { amount: n, currency: code };
      }
    }

    // Ни одна иностранная валюта не найдена — считаем BYN
    const n = extractNumber(t);
    if (n === null) return null;
    // Верхний порог зависит от сайта:
    // av.by: авто до ~500 000 BYN (~$150k), берём с запасом 800 000
    // kufar: недвижимость до ~600 000 BYN, авто тоже в пределах
    // Числа выше — это технические данные (ID, timestamps и т.п.)
    const maxBYN = SITE === 'avby' ? 800_000 : 600_000;
    if (n < 100 || n > maxBYN) return null;
    return { amount: n, currency: 'BYN' };
  }

  /**
   * Строгий вариант: требует явный суффикс валюты.
   * Используется в leaf-scanner чтобы не хватать годы/количества.
   */
  function parseAnyPriceStrict(text) {
    if (!text || typeof text !== 'string') return null;
    const t = text.trim();
    if (!t || t.length > 60) return null;

    if (/км/i.test(t)) return null;
    if (NOT_PRICE_RE.test(t)) return null;
    if (NOT_DATE_TIME_RE.test(t)) return null;

    // Иностранная валюта — достаточно символа/аббревиатуры
    for (const [re, code] of FOREIGN_PATTERNS) {
      if (re.test(t)) {
        const n = extractNumber(t);
        if (n === null) return null;
        const maxAmt = code === 'RUB' ? 500_000_000 : 10_000_000;
        const minAmt = code === 'RUB' ? 10_000 : 100;
        if (n < minAmt || n > maxAmt) return null;
        return { amount: n, currency: code };
      }
    }

    // BYN — требуем явный суффикс
    if (!/р\.|руб|BYN|\bбел\b/i.test(t)) return null;
    const n = extractNumber(t);
    if (n === null) return null;
    const maxBYN = SITE === 'avby' ? 800_000 : 600_000;
    if (n < 100 || n > maxBYN) return null;
    return { amount: n, currency: 'BYN' };
  }

  /** Извлекает первое число из строки. */
  function extractNumber(text) {
    // Убираем символы валют, сохраняем цифры, пробелы, точки, запятые
    const clean = text.replace(/[^\d\s\u00A0\u202F.,]/g, '').trim();
    if (!clean) return null;

    const noSpaces = clean.replace(/[\s\u00A0\u202F]/g, '');

    // Определяем разделитель тысяч vs десятичный:
    // "45,000"  → тысячный разделитель → 45000
    // "45.000"  → тысячный разделитель → 45000 (европейский формат)
    // "45,5"    → десятичная запятая  → 45.5
    // "45.5"    → десятичная точка    → 45.5
    // "1,234,567" → тысячные          → 1234567
    const commas = (noSpaces.match(/,/g) || []).length;
    const dots   = (noSpaces.match(/\./g) || []).length;

    let normalized;
    if (commas > 1) {
      // "1,234,567" — все запятые как тысячные
      normalized = noSpaces.replace(/,/g, '');
    } else if (commas === 1 && dots === 0) {
      const afterComma = noSpaces.split(',')[1];
      if (afterComma && afterComma.length === 3) {
        // "45,000" — тысячный разделитель
        normalized = noSpaces.replace(',', '');
      } else {
        // "45,5" — десятичный
        normalized = noSpaces.replace(',', '.');
      }
    } else if (dots === 1 && commas === 0) {
      const afterDot = noSpaces.split('.')[1];
      if (afterDot && afterDot.length === 3) {
        // "45.000" — тысячный разделитель (европейский)
        normalized = noSpaces.replace('.', '');
      } else {
        // "45.5" — десятичный
        normalized = noSpaces;
      }
    } else {
      // Убираем все нецифровые
      normalized = noSpaces.replace(/[.,]/g, '');
    }

    const n = parseFloat(normalized);
    return isFinite(n) && n > 0 ? n : null;
  }

  // Обёртки для обратной совместимости (используются в processPage и тестах)
  function parseBynPrice(text) {
    const r = parseAnyPrice(text);
    return r ? r.amount : null;  // возвращает число (BYN или иностранная)
  }
  function parseBynStrict(text) {
    const r = parseAnyPriceStrict(text);
    return r ? r.amount : null;
  }

  // ─── ФОРМАТИРОВАНИЕ БЕЙДЖА ────────────────────────────────────────────

  /**
   * Конвертирует amount из fromCurrency в targetCurr через BYN.
   * Не показывает бейдж если fromCurrency === targetCurr.
   */
  function formatBadge(amount, fromCurrency) {
    const fc = fromCurrency || 'BYN';

    // Нет смысла конвертировать USD→USD и т.п.
    if (fc === targetCurr) return null;

    const rateFrom = rates[fc];
    const rateTo   = rates[targetCurr];
    if (!rateFrom || !rateTo) return null;

    // Переводим в BYN, потом в целевую
    const byn = amount * rateFrom;
    const val = byn / rateTo;

    if (!isFinite(val) || val <= 0) return null;

    // Проверяем разумность: от $5 до $2M (или эквивалент)
    const valUSD = byn / (rates.USD || 3.25);
    if (valUSD < 5 || valUSD > 2_000_000) return null;

    const sym = SYMBOLS[targetCurr] || targetCurr;

    if (targetCurr === 'RUB') {
      const rounded = Math.round(val);
      if (rounded >= 1_000_000) {
        // От миллиона — сокращаем: ₽5.1М
        const m = rounded / 1_000_000;
        const mStr = m % 1 === 0 ? m.toFixed(0) : m.toFixed(1);
        return sym + mStr + 'М';
      }
      // До миллиона — полное число с разделителем тысяч пробелом: ₽143 000
      return sym + rounded.toLocaleString('ru-RU');
    }
    return sym + Math.round(val).toLocaleString('en-US');
  }

  /** Хелпер: парсит текст и возвращает готовый текст бейджа или null. */
  function getBadgeText(text, strict) {
    const parsed = strict ? parseAnyPriceStrict(text) : parseAnyPrice(text);
    if (!parsed) return null;
    return formatBadge(parsed.amount, parsed.currency);
  }

  // ─── СТИЛИ ────────────────────────────────────────────────────────────

  function injectStyles() {
    if (document.getElementById('bynfx-style')) return;
    const s = document.createElement('style');
    s.id = 'bynfx-style';
    // Ключевое: display:inline, чтобы бейдж шёл строго за текстом цены
    // независимо от того, flex/block родитель
    s.textContent = `
      .${BADGE_CLASS} {
        display: inline !important;
        margin-left: 7px;
        padding: 2px 8px;
        background: rgba(96,165,250,.11);
        color: #2563eb;
        border: 1px solid rgba(96,165,250,.38);
        font-size: 0.80em;
        font-weight: 600;
        border-radius: 5px;
        letter-spacing: .01em;
        vertical-align: middle;
        font-family: ui-monospace,'SF Mono',Menlo,Consolas,monospace;
        white-space: nowrap;
        pointer-events: none;
        line-height: 1.6;
        box-sizing: content-box;
        text-decoration: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  // ─── ПОИСК ТЕКСТОВОГО УЗЛА ────────────────────────────────────────────

  /**
   * Возвращает последний текстовый узел внутри el, содержащий цифру.
   * Используется чтобы вставить бейдж сразу ПОСЛЕ текста внутри элемента.
   */
  function lastNumericTextNode(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, null, false);
    let last = null;
    let node;
    while ((node = walker.nextNode())) {
      if (/\d/.test(node.nodeValue)) last = node;
    }
    return last;
  }

  // ─── ЗАЩИТА ОТ ДУБЛИРОВАНИЯ ───────────────────────────────────────────

  /**
   * Проверяет наличие бейджа ТОЛЬКО в прямых предках (не в братьях/сёстрах).
   * body и html не проверяем — слишком широко.
   */
  function ancestorHasBadge(el, levels = 4) {
    let cur = el.parentElement;
    for (let i = 0; i < levels && cur; i++, cur = cur.parentElement) {
      // Останавливаемся на body — дальше незачем
      if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
      if (cur.hasAttribute(DONE_ATTR)) return true;
      // Смотрим только прямых детей cur у которых есть бейдж И которые являются предком el
      // (то есть cur сам обработан, не его братья)
      if (cur.classList && cur.classList.contains(BADGE_CLASS)) return true;
    }
    return false;
  }

  /**
   * Проверяет наличие бейджа в потомках.
   */
  function descendantHasBadge(el) {
    return !!el.querySelector('.' + BADGE_CLASS);
  }

  // ─── ВСТАВКА БЕЙДЖА ────────────────────────────────────────────────────

  /**
   * Стратегия:
   * 1. Находим последний текстовый узел с цифрой внутри priceEl
   * 2. Вставляем бейдж как следующий сибл этого текстового узла
   * → Бейдж оказывается inline внутри элемента, сразу за числом
   * → Не зависит от display родителя (flex / block / inline)
   */
  function injectBadge(priceEl, badgeText) {
    if (!priceEl || !priceEl.parentNode) return false;
    if (priceEl.hasAttribute(DONE_ATTR)) return false;
    if (descendantHasBadge(priceEl)) return false;
    if (ancestorHasBadge(priceEl)) return false;

    const badge = document.createElement('span');
    badge.className = BADGE_CLASS;
    badge.textContent = badgeText;
    badge.setAttribute('aria-label', 'Цена: ' + badgeText + ' (справочно, Нацбанк РБ)');
    badge.setAttribute('title', 'Курс Нацбанка РБ · справочно');

    // Находим текстовый узел с ценой
    const textNode = lastNumericTextNode(priceEl);
    if (textNode) {
      // Вставляем сразу после текстового узла — inline!
      if (textNode.nextSibling) {
        textNode.parentNode.insertBefore(badge, textNode.nextSibling);
      } else {
        textNode.parentNode.appendChild(badge);
      }
    } else {
      // Fallback: в конец самого элемента
      priceEl.appendChild(badge);
    }

    priceEl.setAttribute(DONE_ATTR, '1');
    return true;
  }

  function removeAllBadges(root) {
    const r = root || document;
    r.querySelectorAll('.' + BADGE_CLASS).forEach(el => el.remove());
    r.querySelectorAll('[' + DONE_ATTR + ']').forEach(el => el.removeAttribute(DONE_ATTR));
  }

  // ─── КАНДИДАТ ──────────────────────────────────────────────────────────

  function isPriceCandidate(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.hasAttribute(DONE_ATTR)) return false;
    if (el.classList.contains(BADGE_CLASS)) return false;
    if (el.closest && el.closest('.' + BADGE_CLASS)) return false;

    // Не берём элементы у которых уже есть бейдж-потомок
    if (descendantHasBadge(el)) return false;

    const text = el.textContent || '';
    if (text.length > 80 || !/\d/.test(text)) return false;
    // Пробег
    if (/км/i.test(text)) return false;

    // Принимаем любую валюту (BYN, RUB, USD, EUR...)
    return parseAnyPrice(text) !== null;
  }

  // ─── СЕЛЕКТОРЫ ─────────────────────────────────────────────────────────

  // av.by: точные классы лучше чем [class*=], меньше ложных срабатываний
  const SEL_AVBY = [
    '.listing-item-price-primary',
    '[class*="listing-item-price"]',
    '[class*="ListingItemPrice"]',
    '[class*="pricePrimary"]',
    '[class*="price-primary"]',
    '[class*="price-byn"]',
    '[class*="priceByn"]',
    '[class*="Price_price"]',
    '[class*="styles_price"]',
    '.offer-price__value',
    '.offer-price__byn',
    '[class*="OfferPrice__byn"]',
    '[class*="offer-price"]',
    '.card-leasing__price-value',
    '[data-marker*="price"]',
    '[data-testid*="price"]',
    '.js-price'
  ];

  // kufar.by: только точные selectors чтобы не дублировать
  // Намеренно НЕ используем широкие [class*="price"] — слишком много совпадений
  const SEL_KUFAR = [
    // Листинг — карточка товара/авто (CSS-modules с хешем)
    '[class*="styles_price"]',
    '[class*="Price_price"]',
    '[class*="price-primary"]',
    '[class*="currentPrice"]',
    '[class*="priceValue"]',
    '[class*="price__value"]',
    '[class*="price__amount"]',
    '[class*="price__current"]',
    '[class*="itemPrice"]',
    '[class*="CardPrice"]',
    '[class*="cardPrice"]',
    // Страница объявления
    '[data-testid="price"]',
    '[data-testid*="price"]',
    '[data-name="price"]',
    '.price-entry',
    '.price-value',
    // Недвижимость (специфичные, не дублируются)
    '.ad-price'
  ];

  // ─── LEAF SCANNER — универсальный fallback ─────────────────────────
  // Обходит DOM через TreeWalker и ищет «листовые» элементы,
  // у которых весь видимый текст — это BYN-цена.
  // Работает когда CSS-классы неизвестны (SPA с CSS modules).

  const LEAF_TAGS = new Set(['SPAN','DIV','P','STRONG','B','H2','H3','H4','LI','TD']);
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','IMG','INPUT','BUTTON',
                              'HEADER','FOOTER','NAV','ASIDE','FORM']);

  function leafScan(root) {
    if (!isEnabled || !rates[targetCurr]) return 0;
    const r = root || document;
    let count = 0;

    const walker = document.createTreeWalker(r.body || r, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        // Пропускаем служебные теги
        if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        // Пропускаем уже обработанные
        if (node.hasAttribute(DONE_ATTR)) return NodeFilter.FILTER_SKIP;
        if (node.classList?.contains(BADGE_CLASS)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      // Интересуемся только "листовыми" элементами — у которых нет дочерних ЭЛЕМЕНТОВ
      // (только текстовые узлы) или один дочерний span/strong
      if (!LEAF_TAGS.has(node.tagName)) continue;

      const childElements = node.children;
      // Допускаем 0 дочерних элементов или 1 дочерний если это span/strong/b
      if (childElements.length > 1) continue;
      if (childElements.length === 1) {
        const child = childElements[0];
        if (!['SPAN','STRONG','B','EM'].includes(child.tagName)) continue;
        // Дочерний элемент не должен сам содержать бейдж
        if (child.classList?.contains(BADGE_CLASS)) continue;
        if (child.hasAttribute(DONE_ATTR)) continue;
      }

      if (!isPriceCandidate(node)) continue;

      // Leaf-scanner использует СТРОГИЙ парсер — требует суффикс валюты.
      // Это отсекает года, пробег, количества объявлений.
      const badgeText = getBadgeText(node.textContent, true /* strict */);
      if (!badgeText) continue;

      if (injectBadge(node, badgeText)) count++;
    }

    return count;
  }

  function getSelectors() {
    return SITE === 'kufar' ? SEL_KUFAR : SEL_AVBY;
  }

  // ─── ОСНОВНОЙ ПРОХОД ───────────────────────────────────────────────────

  function processPage(root) {
    if (!isEnabled || !rates[targetCurr]) return 0;

    const r = root || document;
    const selectors = getSelectors();
    let count = 0;

    // Собираем candidates без дубликатов.
    const raw = [];
    const rawSet = new WeakSet();
    for (const sel of selectors) {
      let nodes;
      try { nodes = r.querySelectorAll(sel); } catch (e) { continue; }
      nodes.forEach(el => {
        if (!rawSet.has(el) && isPriceCandidate(el)) {
          rawSet.add(el);
          raw.push(el);
        }
      });
    }

    // Фильтруем: если A является предком B — оставляем только B
    const candidates = raw.filter(el => {
      return !raw.some(other => other !== el && el.contains(other));
    });

    for (const el of candidates) {
      const badgeText = getBadgeText(el.textContent, false /* мягкий */);
      if (!badgeText) continue;
      if (injectBadge(el, badgeText)) count++;
    }

    // Fallback: leaf-scanner для SPA с неизвестными CSS-классами
    if (count === 0 || SITE === 'kufar') {
      count += leafScan(r);
    }

    return count;
  }

  // ─── КУРСЫ ─────────────────────────────────────────────────────────────

  function getCachedRates() {
    return new Promise(res => {
      try {
        chrome.storage.local.get([CACHE_KEY], r => {
          const c = r?.[CACHE_KEY];
          if (c?.rates && c.timestamp && Date.now() - c.timestamp < CACHE_TTL) {
            res(c.rates);
          } else { res(null); }
        });
      } catch (e) { res(null); }
    });
  }

  async function fetchRatesFromAPI() {
    try {
      const resp = await fetch('https://api.nbrb.by/exrates/rates?periodicity=0');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      if (!Array.isArray(data)) throw new Error('bad response');
      const wanted = new Set(['USD','EUR','RUB','PLN','CNY','GBP']);
      const nr = { BYN: 1 };
      data.forEach(r => {
        if (r && wanted.has(r.Cur_Abbreviation)) {
          nr[r.Cur_Abbreviation] = r.Cur_OfficialRate / r.Cur_Scale;
        }
      });
      if (!nr.USD) throw new Error('no USD');
      try {
        chrome.storage.local.set({ [CACHE_KEY]: { rates: nr, timestamp: Date.now() } });
      } catch (e) {}
      return nr;
    } catch (e) {
      console.warn('[BYN→FX]', e.message);
      return null;
    }
  }

  async function loadRates() {
    const cached = await getCachedRates();
    if (cached) return cached;
    const fresh = await fetchRatesFromAPI();
    return fresh || { ...FALLBACK };
  }

  // ─── НАСТРОЙКИ ─────────────────────────────────────────────────────────

  async function loadSettings() {
    return new Promise(res => {
      try {
        chrome.storage.sync.get([SETTINGS_KEY], r => {
          const sites = r?.[SETTINGS_KEY] || {};
          isEnabled = sites[SITE] !== false;
          res();
        });
      } catch (e) { res(); }
    });
  }

  async function loadTargetCurrency() {
    return new Promise(res => {
      try {
        chrome.storage.local.get([TARGET_CURR_KEY], r => {
          const v = r?.[TARGET_CURR_KEY];
          targetCurr = (v && SYMBOLS[v]) ? v : 'USD';
          res();
        });
      } catch (e) { res(); }
    });
  }

  // ─── OBSERVER ──────────────────────────────────────────────────────────

  function scheduleProcess() {
    if (schedTimer) return;
    schedTimer = setTimeout(() => {
      schedTimer = null;
      if (isProcBusy) return;
      isProcBusy = true;
      try { processPage(); } catch (e) {}
      isProcBusy = false;
    }, 280);
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains(BADGE_CLASS)) continue;
          scheduleProcess();
          return;
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ─── INIT ──────────────────────────────────────────────────────────────

  async function init() {
    await loadSettings();
    await loadTargetCurrency();
    rates = await loadRates();
    injectStyles();

    if (document.body) {
      processPage();
      startObserver();
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        processPage();
        startObserver();
      }, { once: true });
    }
  }

  // Реакция на изменение настроек из popup
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'sync' && changes[SETTINGS_KEY]) {
        const sites = changes[SETTINGS_KEY].newValue || {};
        isEnabled = sites[SITE] !== false;
        if (!isEnabled) removeAllBadges();
        else processPage();
      }
      if (area === 'local' && changes[TARGET_CURR_KEY]) {
        const v = changes[TARGET_CURR_KEY].newValue;
        if (v && SYMBOLS[v]) {
          targetCurr = v;
          // Перерисовываем все бейджи с новой валютой
          removeAllBadges();
          processPage();
        }
      }
    });
  } catch (e) {}

  // Экспорт для тестов
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseAnyPrice, parseAnyPriceStrict, extractNumber,
      parseBynPrice, parseBynStrict,  // обёртки для совместимости
      formatBadge, getBadgeText, isPriceCandidate,
      injectBadge, removeAllBadges, processPage, leafScan,
      ancestorHasBadge, descendantHasBadge, lastNumericTextNode,
      _setRates: r => { rates = r; },
      _setEnabled: e => { isEnabled = e; },
      _setTargetCurr: c => { targetCurr = c; },
      _getSite: () => SITE,
      BADGE_CLASS, DONE_ATTR, SYMBOLS, FALLBACK,
      SEL_AVBY, SEL_KUFAR
    };
  } else {
    init();
  }
})();
