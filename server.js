// Backend "banque de donnees" - demo pour partenaire operateur (Orange, Moov, etc.)
// AUCUNE dependance externe. Le paiement est SIMULE (pas de vrai operateur branche).
// Priorite : forfaits ILLIMITES a duree fixe (modele europeen). Les recharges ponctuelles
// et le premium restent disponibles en complement.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DB_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PUBLIC = path.join(__dirname, 'public');
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 Mo par fichier stocke en base
const MAX_USER_BYTES = 200 * 1024 * 1024; // 200 Mo max stockes par utilisateur (protege le serveur)

// ─── Forfaits illimites a duree fixe (modele europeen) : fonctionnalite PRINCIPALE ───
// Point d'integration operateur : aujourd'hui "illimite" = un simple drapeau avec une
// date de fin, stocke cote serveur. Le jour d'un partenariat (Orange, Moov...), c'est ICI
// qu'on branchera l'appel a leur API pour activer un vrai forfait illimite sur la ligne.
const PLANS = [
  { id: 'week', label: 'Illimite 7 jours', amount: 500, days: 7 },
  { id: 'month', label: 'Illimite 30 jours', amount: 5000, days: 30 },
];

let db = { users: {}, sessions: {}, sessionTimes: {} };
if (fs.existsSync(DB_FILE)) {
  try {
    db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
  } catch (e) {
    const backup = DB_FILE + '.corrupt-' + Date.now();
    fs.renameSync(DB_FILE, backup);
    console.error(`data.json illisible (${e.message}), copie conservee : ${backup}`);
  }
}

// ─── Comptes administrateur : liste d'e-mails via la variable d'environnement ADMIN_EMAILS ───
// (separes par des virgules). Ex. : ADMIN_EMAILS=moi@exemple.com,associe@exemple.com
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
for (const email of ADMIN_EMAILS) {
  if (db.users[email]) db.users[email].isAdmin = true;
}
// Code secret unique donnant le statut admin a l'inscription (ADMIN_CODE dans les variables d'environnement).
const ADMIN_CODE = process.env.ADMIN_CODE || '';
function isValidAdminCode(code) {
  if (!ADMIN_CODE || typeof code !== 'string' || !code) return false;
  const a = Buffer.from(code);
  const b = Buffer.from(ADMIN_CODE);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

let saveTimer = null;
const flush = () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
};
const save = () => { if (!saveTimer) saveTimer = setTimeout(flush, 200); };
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
function purgeSessions() {
  const now = Date.now();
  for (const token of Object.keys(db.sessions)) {
    const t = db.sessionTimes[token];
    if (!t || now - t > SESSION_TTL_MS) { delete db.sessions[token]; delete db.sessionTimes[token]; }
  }
  save();
}
function sessionUser(token) {
  const email = db.sessions[token];
  if (!email) return null;
  if (!db.sessionTimes[token]) db.sessionTimes[token] = Date.now();
  if (Date.now() - db.sessionTimes[token] > SESSION_TTL_MS) {
    delete db.sessions[token]; delete db.sessionTimes[token]; save();
    return null;
  }
  const u = db.users[email];
  if (u && !Array.isArray(u.files)) u.files = [];
  if (u && !Array.isArray(u.planHistory)) u.planHistory = [];
  if (u && typeof u.isAdmin !== 'boolean') u.isAdmin = false;
  if (u && !u.createdAt) u.createdAt = new Date().toISOString();
  return u || null;
}

const hash = (pwd, salt) =>
  new Promise((resolve, reject) =>
    crypto.scrypt(pwd, salt, 32, (err, key) => (err ? reject(err) : resolve(key.toString('hex')))));
const DUMMY_SALT = crypto.randomBytes(16).toString('hex');
const round = (n) => Math.round(n * 100) / 100;
const extractAmount = (label) => { const m = /(\d+)\s*F/.exec(label || ''); return m ? Number(m[1]) : 0; };

const attempts = new Map();
function tooMany(req) {
  const key = req.socket.remoteAddress || 'inconnu';
  const now = Date.now();
  const rec = (attempts.get(key) || []).filter((t) => now - t < 600000);
  rec.push(now);
  attempts.set(key, rec);
  return rec.length > 10;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (!v.some((t) => now - t < 600000)) attempts.delete(k);
}, 600000).unref();

function isPlanActive(u) { return !!u.planUntil && u.planUntil > Date.now(); }
// Pourcentage de temps restant sur le forfait en cours (100 = vient de commencer, 0 = termine).
function planPercentLeft(u, now) {
  if (!u.planStarted || !u.planUntil) return 0;
  const total = u.planUntil - u.planStarted;
  if (total <= 0) return 0;
  const left = u.planUntil - now;
  return Math.max(0, Math.min(100, round((left / total) * 100)));
}

function publicUser(u) {
  const totalBytes = u.files.reduce((a, f) => a + f.size, 0);
  const now = Date.now();
  const active = isPlanActive(u);
  return {
    email: u.email,
    planActive: active,
    planUntil: u.planUntil || null,
    planLabel: u.planLabel || null,
    planStarted: u.planStarted || null,
    planPercentLeft: active ? planPercentLeft(u, now) : 0,
    plans: PLANS,
    history: u.history.slice(-30).reverse(),
    files: u.files.map((f) => ({ id: f.id, name: f.name, type: f.type, size: f.size, mb: round(f.size / 1048576), created: f.created })),
    storageUsedMb: round(totalBytes / 1048576),
    storageMaxMb: round(MAX_USER_BYTES / 1048576),
    demo: true,
    isAdmin: !!u.isAdmin,
  };
}

function log(u, type, label, mb) {
  u.history.push({ at: new Date().toISOString(), type, label, mb: round(mb) });
  if (u.history.length > 200) u.history.shift();
}

function send(res, code, body) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req, maxBytes = 1e5) {
  return new Promise((resolve) => {
    let chunks = [];
    let size = 0;
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onFail);
      req.off('close', onFail);
      resolve(value);
    };
    const onData = (c) => {
      size += c.length;
      if (size > maxBytes) { finish({ __tooLarge: true }); req.destroy(); return; }
      chunks.push(c);
    };
    const onEnd = () => {
      try { finish(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { finish({}); }
    };
    const onFail = () => finish({});
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onFail);
    req.once('close', onFail);
  });
}

const routes = {
  'POST /api/register': async (req, res, body) => {
    const email = String(body.email || '').trim().toLowerCase();
    const pwd = String(body.password || '');
    if (!/^\S+@\S+\.\S+$/.test(email) || pwd.length < 6)
      return send(res, 400, { error: 'E-mail invalide ou mot de passe trop court (6 min).' });
    if (tooMany(req)) return send(res, 429, { error: 'Trop de tentatives. Reessayez dans quelques minutes.' });
    if (db.users[email]) return send(res, 409, { error: 'Compte deja existant.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const h = await hash(pwd, salt);
    if (db.users[email]) return send(res, 409, { error: 'Compte deja existant.' });
    const admin = ADMIN_EMAILS.includes(email) || isValidAdminCode(body.adminCode);
    db.users[email] = {
      email, salt, hash: h,
      planUntil: null, planStarted: null, planLabel: null,
      history: [], files: [], isAdmin: admin, createdAt: new Date().toISOString(),
    };
    save();
    return startSession(res, email);
  },
  'POST /api/login': async (req, res, body) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (tooMany(req)) return send(res, 429, { error: 'Trop de tentatives. Reessayez dans quelques minutes.' });
    const u = db.users[email];
    const h = await hash(String(body.password || ''), u ? u.salt : DUMMY_SALT);
    const ok = u && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) return send(res, 401, { error: 'Identifiants incorrects.' });
    return startSession(res, email);
  },
  'GET /api/me': (req, res, body, u) => send(res, 200, publicUser(u)),
  'POST /api/logout': (req, res) => {
    delete db.sessions[getToken(req)];
    delete db.sessionTimes[getToken(req)];
    save();
    res.setHeader('Set-Cookie', `token=; ${cookieBase}; Max-Age=0`);
    return send(res, 200, { ok: true });
  },

  // Forfait illimite a duree fixe (modele europeen) : fonctionnalite principale.
  'POST /api/plan': (req, res, body, u) => {
    if (process.env.NODE_ENV === 'production' && process.env.ALLOW_FAKE_PAYMENT !== '1')
      return send(res, 403, { error: 'Paiement reel requis (non implemente).' });
    const plan = PLANS.find((p) => p.id === body.planId);
    if (!plan) return send(res, 400, { error: 'Forfait inconnu.' });
    const base = isPlanActive(u) ? u.planUntil : Date.now();
    u.planUntil = base + plan.days * 86400000;
    u.planStarted = Date.now();
    u.planLabel = plan.label;
    log(u, 'plan', `${plan.label} (${plan.amount} F)`, 0);
    save();
    return send(res, 200, publicUser(u));
  },

  // Enregistrer un fichier trouve par l'utilisateur : necessite un forfait illimite actif.
  'POST /api/files': async (req, res, body, u) => {
    if (!isPlanActive(u))
      return send(res, 402, { error: 'Aucun forfait illimite actif. Active un forfait pour telecharger.' });
    const name = String(body.name || '').trim().slice(0, 200);
    const type = String(body.type || 'application/octet-stream').slice(0, 100);
    const dataUrl = String(body.data || '');
    if (!name || !dataUrl.startsWith('data:'))
      return send(res, 400, { error: 'Fichier invalide.' });
    const commaIdx = dataUrl.indexOf(',');
    if (commaIdx === -1) return send(res, 400, { error: 'Fichier invalide.' });
    const base64 = dataUrl.slice(commaIdx + 1);
    const bytes = Buffer.byteLength(base64, 'base64');
    if (bytes > MAX_FILE_BYTES)
      return send(res, 413, { error: `Fichier trop volumineux (max ${Math.round(MAX_FILE_BYTES / 1048576)} Mo).` });
    const currentBytes = u.files.reduce((a, f) => a + f.size, 0);
    if (currentBytes + bytes > MAX_USER_BYTES)
      return send(res, 413, { error: `Espace de stockage plein (max ${Math.round(MAX_USER_BYTES / 1048576)} Mo).` });
    const file = { id: crypto.randomUUID(), name, type, size: bytes, data: dataUrl, created: new Date().toISOString() };
    u.files.push(file);
    log(u, 'withdraw', `Telechargement : ${name} (forfait illimite)`, 0);
    save();
    return send(res, 200, { ...publicUser(u), fileId: file.id });
  },

  'GET /api/files/:id': (req, res, body, u, id) => {
    const file = u.files.find((f) => f.id === id);
    if (!file) return send(res, 404, { error: 'Fichier introuvable.' });
    return send(res, 200, file);
  },

  'DELETE /api/files/:id': (req, res, body, u, id) => {
    const idx = u.files.findIndex((f) => f.id === id);
    if (idx === -1) return send(res, 404, { error: 'Fichier introuvable.' });
    const [removed] = u.files.splice(idx, 1);
    save();
    return send(res, 200, { ...publicUser(u), removed: removed.name });
  },

  // ─── Interface administrateur : lecture de stats + gestion des comptes ───
  // Reservee aux utilisateurs avec isAdmin=true (voir ADMIN_EMAILS au demarrage).
  'GET /api/admin/stats': (req, res, body, u) => {
    const emails = Object.keys(db.users);
    const now = Date.now();
    let activePlans = 0, totalFiles = 0, totalFileMb = 0, revenuePlans = 0;
    const planCounts = {};
    for (const p of PLANS) planCounts[p.id] = { label: p.label, count: 0, revenue: 0 };
    for (const email of emails) {
      const usr = db.users[email];
      if (usr.planUntil && usr.planUntil > now) activePlans++;
      totalFiles += usr.files.length;
      totalFileMb += usr.files.reduce((a, f) => a + f.size, 0) / 1048576;
      for (const h of usr.history || []) {
        if (h.type === 'plan') {
          revenuePlans += extractAmount(h.label);
          const match = PLANS.find((p) => h.label.startsWith(p.label));
          if (match) { planCounts[match.id].count++; planCounts[match.id].revenue += extractAmount(h.label); }
        }
      }
    }
    return send(res, 200, {
      totalUsers: emails.length,
      activePlans,
      totalFiles,
      totalFileMb: round(totalFileMb),
      revenue: { total: round(revenuePlans) },
      planBreakdown: Object.values(planCounts),
      generatedAt: new Date().toISOString(),
    });
  },

  // Liste des comptes avec infos utiles pour la demo (pas de mot de passe/hash expose).
  'GET /api/admin/users': (req, res, body, u) => {
    const now = Date.now();
    const list = Object.values(db.users).map((usr) => ({
      email: usr.email,
      createdAt: usr.createdAt || null,
      planActive: !!(usr.planUntil && usr.planUntil > now),
      planLabel: usr.planLabel || null,
      planUntil: usr.planUntil || null,
      filesCount: usr.files.length,
      isAdmin: !!usr.isAdmin,
    })).sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return send(res, 200, { users: list });
  },

  // Supprime un compte (et ses donnees) - action destructive reservee a l'admin.
  'DELETE /api/admin/users/:id': (req, res, body, u, email) => {
    if (!db.users[email]) return send(res, 404, { error: 'Compte introuvable.' });
    if (db.users[email].isAdmin) return send(res, 403, { error: 'Impossible de supprimer un compte administrateur.' });
    delete db.users[email];
    for (const token of Object.keys(db.sessions)) {
      if (db.sessions[token] === email) { delete db.sessions[token]; delete db.sessionTimes[token]; }
    }
    save();
    return send(res, 200, { ok: true, removed: email });
  },

  // Offre manuellement un forfait illimite a un compte (utile pour une demo en direct).
  'POST /api/admin/users/:id/grant-plan': (req, res, body, u, email) => {
    const target = db.users[email];
    if (!target) return send(res, 404, { error: 'Compte introuvable.' });
    const plan = PLANS.find((p) => p.id === body.planId);
    if (!plan) return send(res, 400, { error: 'Forfait inconnu.' });
    const base = isPlanActive(target) ? target.planUntil : Date.now();
    target.planUntil = base + plan.days * 86400000;
    target.planStarted = Date.now();
    target.planLabel = plan.label;
    log(target, 'plan', `${plan.label} (offert par admin)`, 0);
    save();
    return send(res, 200, { ok: true, email, planUntil: target.planUntil });
  },
};
const PUBLIC_ROUTES = new Set(['POST /api/register', 'POST /api/login']);

const COOKIE_MAX_AGE = 60 * 60 * 24 * 7;
const cookieBase = 'HttpOnly; SameSite=Strict; Path=/' + (process.env.NODE_ENV === 'production' ? '; Secure' : '');

function getToken(req) {
  const m = /(?:^|;\s*)token=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : '';
}

function startSession(res, email) {
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = email;
  db.sessionTimes[token] = Date.now();
  save();
  res.setHeader('Set-Cookie', `token=${token}; ${cookieBase}; Max-Age=${COOKIE_MAX_AGE}`);
  send(res, 200, { ok: true });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
const STATIC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
};

function matchRoute(method, pathname) {
  const direct = routes[`${method} ${pathname}`];
  if (direct) return { handler: direct, params: [] };
  const parts = pathname.split('/');
  if (parts[1] === 'api' && parts[2] === 'files' && parts[3]) {
    const handler = routes[`${method} /api/files/:id`];
    if (handler) return { handler, params: [decodeURIComponent(parts[3])] };
  }
  if (parts[1] === 'api' && parts[2] === 'admin' && parts[3] === 'users' && parts[4]) {
    const email = decodeURIComponent(parts[4]);
    if (parts[5] === 'grant-plan') {
      const handler = routes[`${method} /api/admin/users/:id/grant-plan`];
      if (handler) return { handler, params: [email] };
    } else if (!parts[5]) {
      const handler = routes[`${method} /api/admin/users/:id`];
      if (handler) return { handler, params: [email] };
    }
  }
  return null;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const match = matchRoute(req.method, url.pathname);
  if (match) {
    const body = (req.method === 'POST' || req.method === 'PUT')
      ? await readBody(req, url.pathname === '/api/files' ? 15 * 1024 * 1024 : 1e5)
      : {};
    if (body && body.__tooLarge) return send(res, 413, { error: 'Requete trop volumineuse.' });
    const key = `${req.method} ${url.pathname}`;
    let user = null;
    if (!PUBLIC_ROUTES.has(key)) {
      user = sessionUser(getToken(req));
      if (!user) return send(res, 401, { error: 'Non connecte.' });
    }
    if (url.pathname.startsWith('/api/admin/') && !user.isAdmin) {
      return send(res, 403, { error: 'Acces reserve aux administrateurs.' });
    }
    return match.handler(req, res, body, user, ...match.params);
  }
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { ...STATIC_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error('Erreur requete :', err);
    if (!res.headersSent) send(res, 500, { error: 'Erreur interne.' });
    else res.end();
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Le port ${PORT} est deja utilise. Arretez l'autre instance ou lancez avec PORT=<autre port>.`);
  } else {
    console.error('Erreur serveur :', err);
  }
  process.exit(1);
});

purgeSessions();
setInterval(purgeSessions, 3600000).unref();

server.listen(PORT, () => console.log(`Banque de donnees : http://localhost:${PORT}`));
