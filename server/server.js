// ============================================================
// VOICE FM — Complete backend in a single file
// Express + Postgres (Neon) + WebSocket + LiveKit tokens
// ============================================================
import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import { WebSocketServer } from 'ws';
import { AccessToken } from 'livekit-server-sdk';
import { nanoid } from 'nanoid';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- ENV ----------
const PORT = Number(process.env.PORT || 4000);
const NODE_ENV = process.env.NODE_ENV || 'development';
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const CORS_ORIGIN = process.env.CORS_ORIGIN || PUBLIC_BASE_URL;
const ADMIN_PATH = process.env.ADMIN_PATH || '/control-room-9f3a2b-vf';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const COOKIE_NAME = 'vf_session';
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 12);
const DATABASE_URL = process.env.DATABASE_URL;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_ROOM = process.env.LIVEKIT_ROOM || 'voicefm-live';
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_WINDOW_MIN = Number(process.env.LOGIN_WINDOW_MIN || 15);

if (!DATABASE_URL) throw new Error('DATABASE_URL required');
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET)
  throw new Error('LiveKit env vars required');

// ---------- DB ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS programs (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      host TEXT,
      description TEXT,
      day_of_week TEXT DEFAULT 'DAILY',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      category TEXT,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      read INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS broadcast_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      live INTEGER DEFAULT 0,
      program_title TEXT,
      host TEXT,
      started_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await pool.query(`INSERT INTO broadcast_state (id, live) VALUES (1, 0)
                    ON CONFLICT (id) DO NOTHING`);

  // Seed admin
  if (ADMIN_EMAIL && ADMIN_PASSWORD) {
    const { rows } = await pool.query('SELECT id FROM admins WHERE email=$1', [ADMIN_EMAIL]);
    if (!rows.length) {
      const hash = bcrypt.hashSync(ADMIN_PASSWORD, BCRYPT_ROUNDS);
      await pool.query(
        'INSERT INTO admins(email, password_hash) VALUES($1,$2)',
        [ADMIN_EMAIL, hash]
      );
      console.log('✅ Admin created:', ADMIN_EMAIL);
    }
  }

  // Seed defaults
  const defaults = {
    station_name: 'VOICE FM',
    tagline: 'Your Voice. Your Music. Your FM.',
    about_text:
      'VOICE FM is your 24/7 online FM radio station bringing you live talk, music, and stories from around the world.',
    contact_email: 'hello@voicefm.example.com',
    contact_phone: '+1 555 0100',
    contact_address: '',
    social_whatsapp: '',
    social_facebook: '',
    social_instagram: '',
    social_youtube: '',
    social_x: '',
    seo_title: 'VOICE FM — Live Online FM Radio | Listen Free 24/7',
    seo_description:
      'Listen to VOICE FM live online. Free 24/7 FM radio with music, talk shows and live DJs.',
    seo_keywords:
      'Online FM Radio,Live Radio Station,Internet Radio,Listen FM Online,Online Radio Station',
    hero_title: 'LIVE FM RADIO',
    hero_subtitle: 'Listen Live. Anytime. Anywhere.',
    primary_color: '#8b5cf6',
  };
  for (const [k, v] of Object.entries(defaults)) {
    await pool.query(
      `INSERT INTO settings(key,value) VALUES($1,$2)
       ON CONFLICT (key) DO NOTHING`,
      [k, v]
    );
  }

  // Seed programs
  const { rows: pcount } = await pool.query('SELECT COUNT(*)::int c FROM programs');
  if (pcount[0].c === 0) {
    const rows = [
      ['Morning FM','RJ Aisha','Wake up with fresh music & news.','06:00','08:00','Music'],
      ['Telugu Hits','RJ Kiran','Non-stop Telugu chartbusters.','08:00','10:00','Music'],
      ['RJ Talk','RJ Meera','Live call-in talk show.','10:00','13:00','Talk'],
      ['Lunch Time','RJ Sam','Relaxed tunes for your lunch.','13:00','16:00','Music'],
      ['Youth Zone','RJ Nikhil','Trending youth hits & requests.','16:00','19:00','Youth'],
      ['Evening Show','RJ Priya','Smooth evening vibes.','19:00','21:00','Music'],
      ['Night Stories','RJ Arjun','Calm stories before sleep.','21:00','23:00','Talk'],
    ];
    for (const r of rows) {
      await pool.query(
        `INSERT INTO programs(title,host,description,start_time,end_time,category)
         VALUES($1,$2,$3,$4,$5,$6)`, r
      );
    }
    console.log('✅ Programs seeded');
  }
}

// ---------- AUTH HELPERS ----------
async function getSetting(key, fallback = null) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
  return rows.length ? rows[0].value : fallback;
}
async function setSetting(key, value) {
  await pool.query(
    `INSERT INTO settings(key,value) VALUES($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [key, value]
  );
}
async function getAllSettings() {
  const { rows } = await pool.query('SELECT key, value FROM settings');
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: SESSION_TTL_HOURS * 3600 * 1000,
    path: '/',
  });
}
function issueToken(admin) {
  return jwt.sign(
    { sub: admin.id, email: admin.email, role: 'admin' },
    JWT_SECRET,
    { expiresIn: `${SESSION_TTL_HOURS}h` }
  );
}
async function requireAdmin(req, res, next) {
  try {
    const token = req.cookies?.[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: 'unauthenticated' });
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
    const { rows } = await pool.query('SELECT id,email FROM admins WHERE id=$1', [payload.sub]);
    if (!rows.length) return res.status(401).json({ error: 'unauthenticated' });
    req.admin = rows[0];
    next();
  } catch {
    return res.status(401).json({ error: 'unauthenticated' });
  }
}
async function mintToken({ identity, canPublish, canSubscribe, name }) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity, name, ttl: '12h',
  });
  at.addGrant({
    room: LIVEKIT_ROOM, roomJoin: true,
    canPublish, canSubscribe,
    canPublishData: false,
  });
  return await at.toJwt();
}

// ---------- BROADCAST STATE + WS ----------
const wsClients = new Set();

async function currentState() {
  const { rows } = await pool.query('SELECT * FROM broadcast_state WHERE id=1');
  const r = rows[0] || {};
  return {
    type: 'state',
    live: !!r.live,
    programTitle: r.program_title,
    host: r.host,
    startedAt: r.started_at,
    listeners: Math.max(0, wsClients.size),
  };
}
async function broadcastState() {
  const payload = JSON.stringify(await currentState());
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}
async function setLiveState({ live, programTitle = null, host = null }) {
  await pool.query(
    `UPDATE broadcast_state
     SET live=$1, program_title=$2, host=$3, started_at=$4, updated_at=NOW()
     WHERE id=1`,
    [live ? 1 : 0, programTitle, host, live ? new Date() : null]
  );
  await broadcastState();
}

function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', async (ws) => {
    wsClients.add(ws);
    ws.send(JSON.stringify(await currentState()));
    ws.on('close', () => { wsClients.delete(ws); broadcastState(); });
    ws.on('message', (raw) => {
      try {
        const m = JSON.parse(raw);
        if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
      } catch {}
    });
  });
  // periodic heartbeat so listener count stays fresh
  setInterval(broadcastState, 5000);
}

// ---------- EXPRESS ----------
const app = express();
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());

app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }));
app.use('/api/admin/login', rateLimit({
  windowMs: LOGIN_WINDOW_MIN * 60_000,
  max: LOGIN_MAX_ATTEMPTS,
  standardHeaders: true,
  message: { error: 'too_many_attempts' },
}));

// ---------- PUBLIC ROUTES ----------
app.get('/api/settings', async (req, res) => {
  const s = await getAllSettings();
  res.json({
    stationName: s.station_name,
    tagline: s.tagline,
    aboutText: s.about_text,
    contactEmail: s.contact_email,
    contactPhone: s.contact_phone,
    contactAddress: s.contact_address,
    social: {
      whatsapp: s.social_whatsapp, facebook: s.social_facebook,
      instagram: s.social_instagram, youtube: s.social_youtube, x: s.social_x,
    },
    seo: { title: s.seo_title, description: s.seo_description, keywords: s.seo_keywords },
    hero: { title: s.hero_title, subtitle: s.hero_subtitle },
    primaryColor: s.primary_color,
  });
});

app.get('/api/programs', async (req, res) => {
  const { q } = req.query;
  if (q) {
    const like = `%${q}%`;
    const { rows } = await pool.query(
      `SELECT * FROM programs WHERE active=1 AND
       (title ILIKE $1 OR host ILIKE $1 OR description ILIKE $1 OR category ILIKE $1)
       ORDER BY start_time`, [like]);
    return res.json(rows);
  }
  const { rows } = await pool.query(
    'SELECT * FROM programs WHERE active=1 ORDER BY start_time');
  res.json(rows);
});

app.get('/api/schedule', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM programs WHERE active=1 ORDER BY start_time');
  res.json(rows);
});

app.get('/api/now', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM broadcast_state WHERE id=1');
  const bs = rows[0] || {};
  const now = new Date();
  const hhmm = String(now.getHours()).padStart(2, '0') + ':' +
               String(now.getMinutes()).padStart(2, '0');
  const { rows: prows } = await pool.query(
    `SELECT * FROM programs WHERE active=1 AND start_time <= $1 AND end_time > $1
     ORDER BY start_time LIMIT 1`, [hhmm]);
  res.json({
    live: !!bs.live, startedAt: bs.started_at,
    currentProgram: prows[0] || null,
  });
});

app.post('/api/contact', async (req, res) => {
  const { name, email, subject = '', body } = req.body || {};
  if (!name || !email || !body) return res.status(400).json({ error: 'invalid_input' });
  if (name.length > 80 || email.length > 120 || body.length > 2000)
    return res.status(400).json({ error: 'too_long' });
  await pool.query(
    'INSERT INTO messages(name,email,subject,body) VALUES($1,$2,$3,$4)',
    [name, email, subject, body]);
  res.json({ ok: true });
});

// ---------- LIVE / STREAMING ROUTES ----------
app.get('/api/live/listener-token', async (req, res) => {
  try {
    const token = await mintToken({
      identity: `listener-${nanoid(10)}`,
      name: 'Listener',
      canPublish: false,
      canSubscribe: true,
    });
    res.json({ token, url: LIVEKIT_URL, room: LIVEKIT_ROOM });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'token_failed' });
  }
});

app.get('/api/live/broadcaster-token', requireAdmin, async (req, res) => {
  const token = await mintToken({
    identity: `admin-${req.admin.id}`,
    name: 'VOICE FM Studio',
    canPublish: true,
    canSubscribe: false,
  });
  res.json({ token, url: LIVEKIT_URL, room: LIVEKIT_ROOM });
});

app.post('/api/live/state', requireAdmin, async (req, res) => {
  const { live, programTitle, host } = req.body || {};
  await setLiveState({ live: !!live, programTitle, host });
  res.json(await currentState());
});

app.get('/api/live/state', async (req, res) => res.json(await currentState()));

// ---------- ADMIN ROUTES ----------
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'missing_fields' });
  const { rows } = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
  const admin = rows[0];
  if (!admin || !bcrypt.compareSync(password, admin.password_hash))
    return res.status(401).json({ error: 'invalid_credentials' });
  const token = issueToken(admin);
  setSessionCookie(res, token);
  res.json({ ok: true, admin: { email: admin.email } });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (req, res) => {
  res.json({ admin: { email: req.admin.email } });
});

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json(await getAllSettings());
});

app.put('/api/admin/settings', requireAdmin, async (req, res) => {
  const data = req.body || {};
  for (const [k, v] of Object.entries(data)) {
    await setSetting(k, String(v).slice(0, 2000));
  }
  res.json({ ok: true });
});

app.get('/api/admin/programs', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM programs ORDER BY start_time');
  res.json(rows);
});

app.post('/api/admin/programs', requireAdmin, async (req, res) => {
  const p = req.body || {};
  if (!p.title || !p.start_time || !p.end_time)
    return res.status(400).json({ error: 'invalid' });
  const { rows } = await pool.query(
    `INSERT INTO programs(title,host,description,day_of_week,start_time,end_time,category,active)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [p.title, p.host || '', p.description || '', p.day_of_week || 'DAILY',
     p.start_time, p.end_time, p.category || '', p.active ?? 1]);
  res.json({ id: rows[0].id });
});

app.put('/api/admin/programs/:id', requireAdmin, async (req, res) => {
  const p = req.body || {};
  await pool.query(
    `UPDATE programs SET title=$1,host=$2,description=$3,day_of_week=$4,
     start_time=$5,end_time=$6,category=$7,active=$8 WHERE id=$9`,
    [p.title, p.host || '', p.description || '', p.day_of_week || 'DAILY',
     p.start_time, p.end_time, p.category || '', p.active ?? 1, req.params.id]);
  res.json({ ok: true });
});

app.delete('/api/admin/programs/:id', requireAdmin, async (req, res) => {
  await pool.query('DELETE FROM programs WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.get('/api/admin/messages', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM messages ORDER BY created_at DESC LIMIT 200');
  res.json(rows);
});

// ---------- STATIC CLIENT ----------
const clientDir = path.resolve(__dirname, '..', 'client');
app.use(express.static(clientDir, { extensions: ['html'] }));

// Hidden admin page
app.get(ADMIN_PATH, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(clientDir, 'control-room.html'));
});
app.get(`${ADMIN_PATH}/*`, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.sendFile(path.join(clientDir, 'control-room.html'));
});

// SPA fallback for known public routes
const PUBLIC_ROUTES = ['/','/live','/programs','/schedule','/about','/contact','/privacy','/terms','/live.html','/programs.html','/schedule.html','/about.html','/contact.html','/privacy.html','/terms.html','/index.html'];
app.get('*', (req, res, next) => {
  if (PUBLIC_ROUTES.includes(req.path))
    return res.sendFile(path.join(clientDir, 'index.html'));
  next();
});

// Health check
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- BOOT ----------
(async () => {
  await initDb();
  const server = http.createServer(app);
  attachWebSocket(server);
  server.listen(PORT, () => {
    console.log(`🎙️  VOICE FM listening on :${PORT}`);
    console.log(`   Admin: ${ADMIN_PATH}`);
  });
})().catch(err => {
  console.error('❌ Boot failed:', err);
  process.exit(1);
});
