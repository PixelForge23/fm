import { Room, createLocalAudioTrack } from
  'https://cdn.jsdelivr.net/npm/livekit-client@2.6.0/+esm';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (!res.ok) throw Object.assign(new Error('api'), { status: res.status });
  return res.json();
}

async function checkAuth() {
  try { await api('/api/admin/me'); showDash(); }
  catch { showLogin(); }
}
function showLogin() { $('#loginView').hidden = false; $('#dashView').hidden = true; }
function showDash() { $('#loginView').hidden = true; $('#dashView').hidden = false; loadAll(); }

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').hidden = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: $('#email').value, password: $('#password').value }),
    });
    showDash();
  } catch {
    $('#loginError').hidden = false;
    $('#loginError').textContent = 'Invalid credentials.';
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/admin/logout', { method: 'POST' });
  await stopBroadcast(true);
  showLogin();
});

$$('.admin-tabs button').forEach(btn => btn.addEventListener('click', () => {
  $$('.admin-tabs button').forEach(b => b.classList.toggle('active', b === btn));
  $$('[data-panel]').forEach(p => p.hidden = p.dataset.panel !== btn.dataset.tab);
}));

// ---------- BROADCAST ----------
let room = null;
let localTrack = null;
let micMuted = false;
let audioCtx, analyser, meterRaf;

$('#micBtn').addEventListener('click', async () => {
  if (!room) await startBroadcast();
  else await stopBroadcast();
});

$('#micTestBtn').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    meterLoop(stream);
    setTimeout(() => stream.getAudioTracks().forEach(t => t.stop()), 4000);
  } catch { bError('Microphone access is required for broadcasting.'); }
});

$('#muteMicBtn').addEventListener('click', () => {
  if (!localTrack) return;
  micMuted = !micMuted;
  if (micMuted) localTrack.mute(); else localTrack.unmute();
  $('#muteMicBtn').textContent = micMuted ? '🔇 Unmute' : '🎤 Mute';
});

function bError(msg) { const e = $('#bError'); e.hidden = !msg; e.textContent = msg || ''; }

async function startBroadcast() {
  bError('');
  try {
    const { token, url } = await api('/api/live/broadcaster-token');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
               channelCount: 1, sampleRate: 48000 },
    });
    meterLoop(stream);

    room = new Room({ adaptiveStream: false, dynacast: false });
    await room.connect(url, token);

    localTrack = await createLocalAudioTrack(stream.getAudioTracks()[0], { name: 'admin-mic' });
    await room.localParticipant.publishTrack(localTrack);

    await api('/api/live/state', {
      method: 'POST',
      body: JSON.stringify({
        live: true,
        programTitle: $('#programTitle').value || 'Live Talk',
        host: $('#hostName').value || null,
      }),
    });

    $('#micBtn').classList.add('on');
    $('#micLabel').textContent = 'END LIVE';
    $('#micBtn').setAttribute('aria-pressed', 'true');
    $('#broadcastState').textContent = '🔴 LIVE ON AIR';
  } catch (e) {
    console.error(e);
    bError(e.name === 'NotAllowedError'
      ? 'Microphone access is required for broadcasting.'
      : 'Failed to start broadcast: ' + e.message);
    await stopBroadcast(true);
  }
}

async function stopBroadcast(silent = false) {
  if (localTrack) { try { localTrack.stop(); } catch {} localTrack = null; }
  if (room) { try { await room.disconnect(); } catch {} room = null; }
  try { await api('/api/live/state', { method: 'POST', body: JSON.stringify({ live: false }) }); } catch {}
  $('#micBtn').classList.remove('on');
  $('#micLabel').textContent = 'START LIVE';
  $('#micBtn').setAttribute('aria-pressed', 'false');
  $('#broadcastState').textContent = 'OFF AIR';
  micMuted = false;
  $('#muteMicBtn').textContent = '🎤 Mute';
  cancelAnimationFrame(meterRaf);
  $('#meterBar').style.width = '0%';
  if (!silent) bError('');
}

function meterLoop(stream) {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  src.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const bar = $('#meterBar');
  cancelAnimationFrame(meterRaf);
  (function tick() {
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) { const v = (data[i] - 128) / 128; sum += v * v; }
    const rms = Math.sqrt(sum / data.length);
    bar.style.width = Math.min(100, Math.round(rms * 220)) + '%';
    meterRaf = requestAnimationFrame(tick);
  })();
}

// ---------- PROGRAMS ----------
async function loadPrograms() {
  const rows = await api('/api/admin/programs');
  const el = $('#progList');
  el.innerHTML = rows.map(p => `
    <div class="card" style="margin-bottom:10px">
      <div class="row" style="justify-content:space-between">
        <div>
          <b>${esc(p.title)}</b>
          <div class="muted">${p.start_time} – ${p.end_time} · ${esc(p.host || '')} · ${esc(p.category || '')}</div>
        </div>
        <div class="row">
          <button class="btn secondary" data-edit="${p.id}">Edit</button>
          <button class="btn danger" data-del="${p.id}">Delete</button>
        </div>
      </div>
    </div>`).join('');
  el.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
    if (!confirm('Delete this program?')) return;
    await api('/api/admin/programs/' + b.dataset.del, { method: 'DELETE' });
    loadPrograms();
  }));
  el.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => {
    const p = rows.find(x => String(x.id) === b.dataset.edit);
    const f = $('#progForm');
    ['title','host','start_time','end_time','category','description']
      .forEach(k => f[k].value = p[k] || '');
    f.dataset.editing = b.dataset.edit;
    f.querySelector('button[type=submit]').textContent = 'Update Program';
  }));
}

$('#progForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const body = {
    title: f.title.value.trim(), host: f.host.value.trim(),
    start_time: f.start_time.value.trim(), end_time: f.end_time.value.trim(),
    category: f.category.value.trim(), description: f.description.value.trim(),
    day_of_week: 'DAILY', active: 1,
  };
  try {
    if (f.dataset.editing)
      await api('/api/admin/programs/' + f.dataset.editing, { method: 'PUT', body: JSON.stringify(body) });
    else
      await api('/api/admin/programs', { method: 'POST', body: JSON.stringify(body) });
    f.reset(); delete f.dataset.editing;
    f.querySelector('button[type=submit]').textContent = 'Add Program';
    loadPrograms();
  } catch { alert('Failed to save program'); }
});

// ---------- SETTINGS / SEO ----------
const STATION_FIELDS = ['station_name','tagline','about_text','contact_email','contact_phone',
  'contact_address','social_whatsapp','social_facebook','social_instagram','social_youtube',
  'social_x','hero_title','hero_subtitle','primary_color'];
const SEO_FIELDS = ['seo_title','seo_description','seo_keywords'];

function buildFields(formEl, keys, data) {
  formEl.innerHTML = keys.map(k => `
    <label style="display:block">
      <span class="muted">${k.replace(/_/g,' ')}</span>
      ${k.includes('about') || k.includes('description')
        ? `<textarea name="${k}" rows="3" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:#fff">${esc(data[k] || '')}</textarea>`
        : `<input name="${k}" value="${esc(data[k] || '')}" style="width:100%;padding:10px;border-radius:10px;border:1px solid var(--border);background:rgba(255,255,255,.04);color:#fff" />`}
    </label>`).join('');
}

async function loadSettings() {
  const s = await api('/api/admin/settings');
  buildFields($('#settingsForm'), STATION_FIELDS, s);
  buildFields($('#seoForm'), SEO_FIELDS, s);
}

$('#saveSettings').addEventListener('click', async () => {
  await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(formToObj($('#settingsForm'))) });
  $('#saveSettings').textContent = '✅ Saved';
  setTimeout(() => $('#saveSettings').textContent = 'Save', 1200);
});
$('#saveSeo').addEventListener('click', async () => {
  await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(formToObj($('#seoForm'))) });
  $('#saveSeo').textContent = '✅ Saved';
  setTimeout(() => $('#saveSeo').textContent = 'Save SEO', 1200);
});

function formToObj(form) {
  const o = {};
  new FormData(form).forEach((v, k) => o[k] = String(v).trim());
  return o;
}

// ---------- MESSAGES ----------
async function loadMessages() {
  const rows = await api('/api/admin/messages');
  const el = $('#msgList');
  if (!rows.length) { el.innerHTML = '<p class="muted">No messages yet.</p>'; return; }
  el.innerHTML = rows.map(m => `
    <div class="card" style="margin-bottom:10px">
      <div class="row" style="justify-content:space-between">
        <b>${esc(m.name)} &lt;${esc(m.email)}&gt;</b>
        <span class="muted">${new Date(m.created_at).toLocaleString()}</span>
      </div>
      <div class="muted">${esc(m.subject || '')}</div>
      <p>${esc(m.body)}</p>
    </div>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function loadAll() { await Promise.all([loadPrograms(), loadSettings(), loadMessages()]); }

checkAuth();
window.addEventListener('beforeunload', () => { if (room) stopBroadcast(true); });
