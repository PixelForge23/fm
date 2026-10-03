const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function loadSettings() {
  try {
    const s = await fetch('/api/settings').then(r => r.json());
    if (s.seo?.title) document.title = s.seo.title;
    const d = document.querySelector('meta[name="description"]');
    if (d && s.seo?.description) d.setAttribute('content', s.seo.description);
    $$('[data-station-name]').forEach(el => el.textContent = s.stationName || 'VOICE FM');
    const t = $('#stationTagline'); if (t && s.tagline) t.textContent = s.tagline;
    const ht = $('#heroTitle'); if (ht && s.hero?.title) ht.textContent = s.hero.title;
    const hs = $('#heroSubtitle'); if (hs && s.hero?.subtitle) hs.textContent = s.hero.subtitle;
    if (s.primaryColor) document.documentElement.style.setProperty('--primary', s.primaryColor);
  } catch {}
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (ev) => {
    try {
      const s = JSON.parse(ev.data);
      if (s.type !== 'state') return;
      const badge = $('#liveBadge'), text = $('#liveText');
      if (badge) badge.classList.toggle('off', !s.live);
      if (text) text.textContent = s.live ? 'LIVE NOW' : 'OFF AIR';
      const lc = $('#listenerCount'); if (lc) lc.textContent = s.listeners ?? 0;
      const na = $('#nowOnAir');
      if (na) na.textContent = s.live
        ? (s.programTitle ? `${s.programTitle}${s.host ? ' · ' + s.host : ''}` : 'Live Talk')
        : 'Station is currently OFF AIR.';
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWS, 3000);
  ws.onerror = () => ws.close();
}

function initMenu() {
  const b = $('.menu-btn'), l = $('.nav-links');
  b?.addEventListener('click', () => l.classList.toggle('open'));
}

function initShare() {
  $('#shareBtn')?.addEventListener('click', async () => {
    const url = location.origin + '/';
    try {
      if (navigator.share) await navigator.share({ title: document.title, url });
      else { await navigator.clipboard.writeText(url); $('#shareBtn').textContent = '✅ Copied!'; }
    } catch {}
  });
}

document.addEventListener('DOMContentLoaded', () => {
  const y = $('#year'); if (y) y.textContent = new Date().getFullYear();
  loadSettings();
  connectWS();
  initMenu();
  initShare();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
