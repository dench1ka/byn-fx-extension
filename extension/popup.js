// popup.js — BYN→FX Extension v1.6.0
// Синий акцент (v1.2 дизайн), нейтральные ч/б фоны,
// три режима темы: авто / светлая / тёмная (настройки в отдельной панели)

(function () {
  'use strict';

  const CACHE_KEY          = 'avby_rates_cache';
  const CHART_CACHE_PREFIX = 'avby_chart_';
  const CACHE_TTL          = 3600 * 1000;
  const CHART_CACHE_TTL    = 6 * 3600 * 1000;
  const THEME_KEY          = 'byn_theme';       // 'auto' | 'dark' | 'light'
  const SITES_KEY          = 'bynUsdSites';
  const DELTA_KEY          = 'byn_show_delta';
  const TARGET_CURR_KEY    = 'byn_target_currency';

  const CURRENCIES = {
    BYN: { symbol: 'Br' }, USD: { symbol: '$'  }, EUR: { symbol: '€' },
    RUB: { symbol: '₽'  }, PLN: { symbol: 'zł' }, CNY: { symbol: '¥' },
    GBP: { symbol: '£'  }
  };

  let rates      = { BYN: 1 };
  let currencyIds = {};
  let scales     = {};
  let prevRates  = {};
  let showDelta  = true;
  let isLoading  = false;
  let activeCurrency  = null;
  let activeRange     = 'month';

  // ── Storage helpers ──────────────────────────────────────────────────

  function readLocal(key) {
    return new Promise(res => {
      try { chrome.storage.local.get([key], r => res(r[key] ?? null)); }
      catch (e) { res(null); }
    });
  }
  function writeLocal(key, value) {
    try { chrome.storage.local.set({ [key]: value }); } catch (e) {}
  }
  function readSync(key) {
    return new Promise(res => {
      try { chrome.storage.sync.get([key], r => res(r[key] ?? null)); }
      catch (e) { res(null); }
    });
  }
  function writeSync(key, value) {
    try { chrome.storage.sync.set({ [key]: value }); } catch (e) {}
  }

  // ── ТЕМА ─────────────────────────────────────────────────────────────
  // themePreference: 'auto' | 'dark' | 'light'
  // Реальная тема (то что применяем): 'dark' | 'light'

  let themePreference = 'auto';
  let mediaQuery = null;

  function resolveTheme(pref) {
    if (pref === 'auto') {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light' : 'dark';
    }
    return pref;
  }

  function applyResolvedTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
  }

  function applyThemePref(pref) {
    themePreference = pref;
    applyResolvedTheme(resolveTheme(pref));
    // Обновляем active-кнопку в picker
    document.querySelectorAll('.theme-opt').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-theme-val') === pref);
    });
  }

  async function loadTheme() {
    const stored = await readLocal(THEME_KEY);
    const pref = (stored && ['auto', 'dark', 'light'].includes(stored)) ? stored : 'auto';
    applyThemePref(pref);

    // Слушаем системное изменение (только если режим — авто)
    if (window.matchMedia) {
      mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
      mediaQuery.addEventListener('change', () => {
        if (themePreference === 'auto') {
          applyResolvedTheme(resolveTheme('auto'));
        }
      });
    }
  }

  function setTheme(pref) {
    applyThemePref(pref);
    writeLocal(THEME_KEY, pref);
  }

  // ── SETTINGS PANEL ────────────────────────────────────────────────────

  function openSettings() {
    const ov = document.getElementById('settingsOverlay');
    ov.classList.add('open');
    ov.removeAttribute('aria-hidden');
  }

  function closeSettings() {
    const ov = document.getElementById('settingsOverlay');
    ov.classList.remove('open');
    ov.setAttribute('aria-hidden', 'true');
  }

  // ── SITES / DELTA / TARGET CURRENCY ──────────────────────────────────

  const SITE_IDS = ['avby', 'kufar'];
  const FX_OPTIONS = ['USD','EUR','RUB'];
  let targetCurr = 'USD';

  async function loadSiteSettings() {
    const sites = (await readSync(SITES_KEY)) || {};
    SITE_IDS.forEach(s => {
      const tgl = document.getElementById('tgl-' + s);
      if (tgl) tgl.checked = sites[s] !== false;
    });

    const delta = await readLocal(DELTA_KEY);
    showDelta = delta !== false;
    const tglD = document.getElementById('tgl-delta');
    if (tglD) tglD.checked = showDelta;

    // Целевая валюта
    const tc = await readLocal(TARGET_CURR_KEY);
    targetCurr = (tc && FX_OPTIONS.includes(tc)) ? tc : 'USD';
    updateCurrPicker();
  }

  function updateCurrPicker() {
    document.querySelectorAll('.curr-opt').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-curr') === targetCurr);
    });
  }

  function saveTargetCurr(c) {
    targetCurr = c;
    writeLocal(TARGET_CURR_KEY, c);
    // Сообщаем content script через storage
    // (content.js слушает chrome.storage.onChanged)
    updateCurrPicker();
  }

  function saveSites() {
    const payload = {};
    SITE_IDS.forEach(s => {
      const t = document.getElementById('tgl-' + s);
      payload[s] = t ? t.checked : true;
    });
    writeSync(SITES_KEY, payload);
  }

  // ── RATES ─────────────────────────────────────────────────────────────

  async function fetchRates(force = false) {
    if (!force) {
      const c = await readLocal(CACHE_KEY);
      if (c && c.rates && c.timestamp && (Date.now() - c.timestamp < CACHE_TTL)) {
        return { rates: c.rates, ids: c.ids||{}, scales: c.scales||{}, prev: c.prev||{}, fromCache: true, ts: c.timestamp };
      }
    }
    try {
      const resp = await fetch('https://api.nbrb.by/exrates/rates?periodicity=0');
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const data = await resp.json();
      const wanted = new Set(['USD','EUR','RUB','PLN','CNY','GBP']);
      const nr = { BYN:1 }, ni = {}, ns = { BYN:1 };
      data.forEach(r => {
        if (r && wanted.has(r.Cur_Abbreviation)) {
          nr[r.Cur_Abbreviation] = r.Cur_OfficialRate / r.Cur_Scale;
          ni[r.Cur_Abbreviation] = r.Cur_ID;
          ns[r.Cur_Abbreviation] = r.Cur_Scale;
        }
      });
      if (!nr.USD) throw new Error('no USD');
      const old = await readLocal(CACHE_KEY);
      const prev = old?.rates || {};
      const ts = Date.now();
      writeLocal(CACHE_KEY, { rates:nr, ids:ni, scales:ns, prev, timestamp:ts });
      return { rates:nr, ids:ni, scales:ns, prev, fromCache:false, ts };
    } catch (e) {
      console.warn('[BYN→USD]', e.message);
      const stale = await readLocal(CACHE_KEY);
      if (stale?.rates) return { rates:stale.rates, ids:stale.ids||{}, scales:stale.scales||{}, prev:stale.prev||{}, fromCache:true, ts:stale.timestamp, stale:true };
      throw e;
    }
  }

  // ── CONVERSION ────────────────────────────────────────────────────────

  function parseAmount(s) {
    if (!s) return NaN;
    const c = String(s).trim().replace(/[\s\u00A0\u202F]/g,'').replace(',','.');
    if (!/^-?\d*\.?\d*$/.test(c) || !c || c==='.' || c==='-') return NaN;
    return parseFloat(c);
  }

  function fmtNum(n) {
    if (!isFinite(n)) return '';
    const abs = Math.abs(n);
    const fr = abs>=10000 ? 0 : abs>=1 ? 2 : 4;
    const rounded = Number(n.toFixed(fr));
    const s = rounded < 0 ? '-' : '';
    const [int, frac] = Math.abs(rounded).toFixed(fr).split('.');
    return s + int.replace(/\B(?=(\d{3})+(?!\d))/g,' ') + (frac ? '.'+frac : '');
  }

  function fmtRate(v) {
    return (v == null || !isFinite(v)) ? '—' : v.toFixed(4);
  }

  function deltaP(cur, prev) {
    if (cur==null||prev==null||!isFinite(cur)||!isFinite(prev)||prev===0) return null;
    return ((cur-prev)/prev)*100;
  }
  function fmtDelta(p) { return p==null ? '' : (p>0?'+':'')+p.toFixed(2)+'%'; }

  function doConvert() {
    const from  = document.getElementById('fromCurr').value;
    const to    = document.getElementById('toCurr').value;
    const amt   = parseAmount(document.getElementById('fromAmount').value);
    const toEl  = document.getElementById('toAmount');
    if (!isFinite(amt)||amt===0||!rates[from]||!rates[to]) { toEl.value=''; return; }
    toEl.value = fmtNum(amt * rates[from] / rates[to]);
  }

  function swapCurrencies() {
    const fc = document.getElementById('fromCurr');
    const tc = document.getElementById('toCurr');
    const tv = document.getElementById('toAmount').value;
    [fc.value, tc.value] = [tc.value, fc.value];
    if (tv) document.getElementById('fromAmount').value = tv;
    updateSymbols(); doConvert();
  }

  function updateSymbols() {
    document.getElementById('fromSymbol').textContent = CURRENCIES[document.getElementById('fromCurr').value]?.symbol || '';
    document.getElementById('toSymbol').textContent   = CURRENCIES[document.getElementById('toCurr').value]?.symbol  || '';
  }

  // ── UI UPDATES ────────────────────────────────────────────────────────

  function updateHero() {
    const usd  = rates.USD;
    const hv   = document.getElementById('heroRate');
    const hd   = document.getElementById('heroDelta');
    if (!usd) { hv.textContent='—'; hd.textContent=''; return; }
    hv.textContent = usd.toFixed(4);
    const d = showDelta ? deltaP(usd, prevRates.USD) : null;
    if (!d || Math.abs(d) < 0.001) {
      hd.textContent=''; hd.className='hero-delta zero';
    } else if (d > 0) {
      hd.textContent='↑ '+fmtDelta(d); hd.className='hero-delta up';
    } else {
      hd.textContent='↓ '+fmtDelta(d); hd.className='hero-delta down';
    }
  }

  function updateGrid() {
    document.querySelectorAll('.rate-card').forEach(card => {
      const code = card.getAttribute('data-currency');
      const rv   = card.querySelector('.rc-val');
      if (!rv) return;
      const r = rates[code];
      rv.textContent = r != null ? fmtRate(r * (scales[code]||1)) : '—';

      let dEl = card.querySelector('.rc-d');
      if (!dEl) { dEl = document.createElement('div'); dEl.className='rc-d'; card.appendChild(dEl); }
      const d = showDelta ? deltaP(r, prevRates[code]) : null;
      if (!d || Math.abs(d)<0.01) { dEl.textContent=''; return; }
      dEl.textContent = (d>0?'↑ ':'↓ ') + fmtDelta(d);
      dEl.className   = 'rc-d ' + (d>0 ? 'up' : 'dn');
    });
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try { return new Date(ts).toLocaleTimeString('ru-RU', { hour:'2-digit', minute:'2-digit' }); }
    catch (e) { return '—'; }
  }

  // ── CHART ─────────────────────────────────────────────────────────────

  function rangeD(r) { return {week:7,month:30,quarter:90,year:365}[r]||30; }
  function fmtD(d)   { return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate(); }

  async function fetchDyn(id, days) {
    const ck = CHART_CACHE_PREFIX + id + '_' + days;
    const c  = await readLocal(ck);
    if (c?.data && c.timestamp && (Date.now()-c.timestamp < CHART_CACHE_TTL)) return c.data;
    const end=new Date(), start=new Date();
    start.setDate(start.getDate()-days);
    const resp = await fetch(`https://api.nbrb.by/exrates/rates/dynamics/${id}?startDate=${fmtD(start)}&endDate=${fmtD(end)}`);
    if (!resp.ok) throw new Error('HTTP '+resp.status);
    const data = await resp.json();
    if (!Array.isArray(data)||!data.length) throw new Error('Нет данных');
    writeLocal(ck, { data, timestamp: Date.now() });
    return data;
  }

  function renderChart(svg, data, scale) {
    const W=320, H=112, PL=30, PR=8, PT=8, PB=18;
    const vals  = data.map(d => d.Cur_OfficialRate / (scale||1));
    const dates = data.map(d => new Date(d.Date));
    const mn=Math.min(...vals), mx=Math.max(...vals);
    const pad=(mx-mn||1)*.1, yMin=mn-pad, yMax=mx+pad;
    const xs=i => PL+(i/Math.max(vals.length-1,1))*(W-PL-PR);
    const ys=v => PT+(1-(v-yMin)/(yMax-yMin))*(H-PT-PB);

    let lp='';
    vals.forEach((v,i) => { lp+=(i===0?'M':'L')+xs(i).toFixed(1)+' '+ys(v).toFixed(1)+' '; });
    const ap = lp+`L${xs(vals.length-1).toFixed(1)} ${ys(yMin).toFixed(1)} L${xs(0).toFixed(1)} ${ys(yMin).toFixed(1)} Z`;
    const isUp = vals[vals.length-1] >= vals[0];
    const ac = isUp ? '#60a5fa' : '#f87171';

    const ticks = [yMin+pad, (yMin+yMax)/2, yMax-pad];
    let grid='', yl='', xl='';
    ticks.forEach(t => {
      const y=ys(t).toFixed(1);
      grid+=`<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="var(--border)" stroke-width=".5" stroke-dasharray="2 3"/>`;
      yl+=`<text x="${PL-4}" y="${y}" text-anchor="end" dominant-baseline="middle" font-family="ui-monospace,monospace" font-size="8" fill="var(--mute)">${t.toFixed(t>10?2:4)}</text>`;
    });
    [0,Math.floor(vals.length/2),vals.length-1].forEach((i,k)=>{
      const d=dates[i], lbl=d.getDate()+'.'+(d.getMonth()+1).toString().padStart(2,'0');
      const anchor=k===0?'start':k===2?'end':'middle';
      xl+=`<text x="${xs(i).toFixed(1)}" y="${H-4}" text-anchor="${anchor}" font-family="ui-monospace,monospace" font-size="8" fill="var(--mute)">${lbl}</text>`;
    });

    svg.innerHTML=`<defs><linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${ac}" stop-opacity=".22"/>
      <stop offset="100%" stop-color="${ac}" stop-opacity="0"/>
    </linearGradient></defs>
    ${grid}
    <path d="${ap}" fill="url(#cg)"/>
    <path d="${lp}" fill="none" stroke="${ac}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>
    ${yl}${xl}`;

    return { min:mn, max:mx, first:vals[0], last:vals[vals.length-1] };
  }

  async function showChart(currency, range) {
    activeCurrency = currency; activeRange = range;
    document.getElementById('chartPanel').classList.remove('hidden');
    document.querySelectorAll('.rate-card').forEach(c => c.classList.toggle('active', c.dataset.currency===currency));
    document.querySelectorAll('.c-tab').forEach(t => t.classList.toggle('active', t.dataset.range===range));
    document.getElementById('chartCurr').textContent = currency + ' ';
    const r = rates[currency];
    document.getElementById('chartCurrent').textContent = r ? '1 '+currency+' = '+r.toFixed(4)+' BYN' : '';

    const body  = document.getElementById('chartBody');
    const stats = document.getElementById('chartStats');
    body.innerHTML  = '<div class="ch-loading">загрузка</div>';
    stats.innerHTML = '';

    const id = currencyIds[currency];
    if (!id) { body.innerHTML='<div class="ch-error">обновите курсы</div>'; return; }

    try {
      const data = await fetchDyn(id, rangeD(range));
      body.innerHTML = '<svg class="chart-svg" id="cSvg" viewBox="0 0 320 112" preserveAspectRatio="none"></svg>';
      const svg = document.getElementById('cSvg');
      requestAnimationFrame(() => {
        const st = renderChart(svg, data, scales[currency]||1);
        const ch = ((st.last-st.first)/st.first)*100;
        const cls = ch>0?'up':ch<0?'dn':'';
        stats.innerHTML=`
          <span><span class="csl">мин</span><span class="csv">${st.min.toFixed(4)}</span></span>
          <span><span class="csl">макс</span><span class="csv">${st.max.toFixed(4)}</span></span>
          <span><span class="csl">изм.</span><span class="csv ${cls}">${ch>0?'+':''}${ch.toFixed(2)}%</span></span>`;
      });
    } catch(e) {
      body.innerHTML = `<div class="ch-error">ошибка: ${e.message}</div>`;
    }
  }

  function hideChart() {
    document.getElementById('chartPanel').classList.add('hidden');
    document.querySelectorAll('.rate-card').forEach(c=>c.classList.remove('active'));
    activeCurrency = null;
  }

  // ── LOAD & RENDER ─────────────────────────────────────────────────────

  async function loadAndRender(force=false) {
    if (isLoading) return;
    isLoading = true;
    const btn = document.getElementById('refreshBtn');
    if (btn) { btn.classList.add('spinning'); btn.disabled=true; }
    try {
      const d = await fetchRates(force);
      rates       = d.rates;
      currencyIds = d.ids    || {};
      scales      = d.scales || {};
      prevRates   = d.prev   || {};
      updateHero(); updateGrid(); updateSymbols(); doConvert();
      const ts = fmtTime(d.ts);
      const sub = document.getElementById('updatedSub');
      const lu  = document.getElementById('lastUpdated');
      if (sub) sub.textContent = (d.stale?'оффлайн · ':'НБ РБ · ') + ts;
      if (lu)  lu.textContent  = ts;
      if (activeCurrency) showChart(activeCurrency, activeRange);
    } catch(e) {
      rates  = { BYN:1, USD:3.25, EUR:3.55, RUB:0.035, PLN:0.82, CNY:0.45, GBP:4.10 };
      scales = { BYN:1, USD:1, EUR:1, RUB:100, PLN:1, CNY:10, GBP:1 };
      updateHero(); updateGrid(); updateSymbols(); doConvert();
      const s = document.getElementById('updatedSub');
      if (s) s.textContent = 'нет связи · резервные курсы';
    } finally {
      if (btn) { btn.classList.remove('spinning'); btn.disabled=false; }
      isLoading = false;
    }
  }

  // ── INIT ──────────────────────────────────────────────────────────────

  function init() {
    // Тема
    loadTheme();
    document.getElementById('themePicker').addEventListener('click', e => {
      const btn = e.target.closest('.theme-opt');
      if (!btn) return;
      setTheme(btn.getAttribute('data-theme-val'));
    });

    // Настройки — открыть / закрыть
    document.getElementById('settingsBtn').addEventListener('click', openSettings);
    document.getElementById('backBtn').addEventListener('click', closeSettings);

    // Загрузить начальные состояния тоглов
    loadSiteSettings();

    // Тогл сайтов
    SITE_IDS.forEach(s => {
      const t = document.getElementById('tgl-'+s);
      if (t) t.addEventListener('change', saveSites);
    });

    // Тогл delta
    const tglD = document.getElementById('tgl-delta');
    if (tglD) tglD.addEventListener('change', () => {
      showDelta = tglD.checked;
      writeLocal(DELTA_KEY, showDelta);
      updateHero(); updateGrid();
    });

    // Выбор целевой валюты для сайтов
    const currPicker = document.getElementById('currPicker');
    if (currPicker) {
      currPicker.addEventListener('click', e => {
        const btn = e.target.closest('.curr-opt');
        if (!btn) return;
        saveTargetCurr(btn.getAttribute('data-curr'));
      });
    }

    // Конвертер
    document.getElementById('fromAmount').addEventListener('input', doConvert);
    document.getElementById('fromAmount').addEventListener('focus', e => e.target.closest('.conv-row').classList.add('focused'));
    document.getElementById('fromAmount').addEventListener('blur',  e => e.target.closest('.conv-row').classList.remove('focused'));
    document.getElementById('fromCurr').addEventListener('change', () => { updateSymbols(); doConvert(); });
    document.getElementById('toCurr').addEventListener('change',   () => { updateSymbols(); doConvert(); });
    document.getElementById('swapBtn').addEventListener('click', swapCurrencies);

    // Карточки → график
    document.getElementById('ratesGrid').addEventListener('click', e => {
      const card = e.target.closest('.rate-card');
      if (!card) return;
      const code = card.dataset.currency;
      if (activeCurrency === code) { hideChart(); return; }
      showChart(code, activeRange);
    });
    document.getElementById('chartTabs').addEventListener('click', e => {
      const tab = e.target.closest('.c-tab');
      if (!tab || !activeCurrency) return;
      showChart(activeCurrency, tab.dataset.range);
    });
    document.getElementById('chartClose').addEventListener('click', hideChart);
    document.getElementById('refreshBtn').addEventListener('click', () => loadAndRender(true));

    loadAndRender(false);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Экспорт для тестов
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseAmount, fmtNum, fmtRate, deltaP, fmtDelta,
      resolveTheme, applyThemePref, setTheme,
      saveTargetCurr, updateCurrPicker,
      _setRates: r => { rates=r; },
      _setScales: s => { scales=s; },
      _getPref:       () => themePreference,
      _getTargetCurr: () => targetCurr
    };
  }
})();
