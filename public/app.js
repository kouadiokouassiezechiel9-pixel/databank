const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
let mode = 'login';
let lastMe = null;

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* reponse vide */ }
  if (!res.ok) {
    const err = new Error(data.error || 'Erreur de connexion au serveur.');
    err.status = res.status;
    throw err;
  }
  return data;
}

function say(text, kind) {
  const el = $('msg');
  if (!text) { el.hidden = true; return; }
  el.textContent = text;
  el.className = 'msg ' + (kind || '');
  el.hidden = false;
}

function showAuth() {
  $('auth').hidden = false;
  $('app').hidden = true;
  $('who').hidden = true;
}

function setMode(next) {
  mode = next;
  const login = mode === 'login';
  $('authTitle').textContent = login ? 'Connexion' : 'Creer un compte';
  $('authBtn').textContent = login ? 'Se connecter' : 'Creer mon compte';
  $('authSwitch').textContent = login ? 'Pas de compte ? Creer un compte' : 'Deja un compte ? Se connecter';
  $('f-pwd').autocomplete = login ? 'current-password' : 'new-password';
}

function render(me) {
  lastMe = me;
  $('auth').hidden = true;
  $('app').hidden = false;
  $('who').hidden = false;
  $('email').textContent = me.email;

  const badge = $('statusBadge');
  if (me.planActive) {
    badge.textContent = (me.planLabel || 'Forfait illimite') + ' actif';
    badge.className = 'statusBadge active';
    $('statusSub').textContent = 'Valable jusqu\u2019au ' + new Date(me.planUntil).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } else {
    badge.textContent = 'Aucun forfait illimite actif';
    badge.className = 'statusBadge';
    $('statusSub').textContent = 'Choisis un forfait ci-dessous, ou utilise ton stock de Mo.';
  }

  $('stock').textContent = nf.format(me.stockMb);
  const pct = Math.min((me.stockMb / 8000) * 100, 100);
  $('fill').style.height = pct + '%';

  renderPlans(me);
  renderRecharges(me);
  renderPremium(me);
  renderFiles(me);
  renderHistory(me.history);
}

function renderPlans(me) {
  const ul = $('plans');
  ul.textContent = '';
  me.plans.forEach((p) => {
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = p.label;
    const detail = document.createElement('span');
    detail.textContent = p.amount + ' F';
    info.append(name, detail);
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = me.planActive ? 'Prolonger' : 'Activer';
    b.addEventListener('click', () => activatePlan(p.id));
    li.append(info, b);
    ul.appendChild(li);
  });
}

function renderRecharges(me) {
  const ul = $('recharges');
  ul.textContent = '';
  me.recharges.forEach((r) => {
    const mb = me.premium ? r.mbPremium : r.mbStandard;
    const li = document.createElement('li');
    const info = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = r.amount + ' F';
    const detail = document.createElement('span');
    detail.textContent = nf.format(mb) + ' Mo' + (me.premium ? ' (tarif premium)' : '');
    info.append(name, detail);
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'alt';
    b.textContent = 'Recharger';
    b.addEventListener('click', () => recharge(r.amount));
    li.append(info, b);
    ul.appendChild(li);
  });
}

function renderPremium(me) {
  const p = me.premiumOffer;
  $('premiumHint').textContent = me.premium
    ? 'Ton premium ameliore deja le rendement de chaque recharge. Tu peux prolonger de ' + p.days + ' jours pour ' + p.price + ' F.'
    : 'Pour ' + p.price + ' F, chaque recharge donne plus de donnees pendant ' + p.days + ' jours.';
  $('premiumBtn').className = me.premium ? 'gold' : 'alt';
  $('premiumBtn').textContent = (me.premium ? 'Prolonger le premium (' : 'Activer le premium (') + p.price + ' F)';
}

function renderFiles(me) {
  const ul = $('files');
  ul.textContent = '';
  if (!me.files.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aucun fichier enregistre.';
    ul.appendChild(li);
  } else {
    me.files.slice().reverse().forEach((f) => {
      const li = document.createElement('li');
      const info = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = f.name;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = nf.format(f.mb) + ' Mo \u00b7 ' + new Date(f.created).toLocaleDateString('fr-FR');
      info.append(name, meta);
      const actions = document.createElement('div');
      actions.className = 'actions';
      const dl = document.createElement('button');
      dl.type = 'button';
      dl.className = 'alt';
      dl.textContent = 'Ouvrir';
      dl.addEventListener('click', () => openFile(f.id, f.name));
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Supprimer';
      del.addEventListener('click', () => removeFile(f.id));
      actions.append(dl, del);
      li.append(info, actions);
      ul.appendChild(li);
    });
  }
  $('storageInfo').textContent = 'Espace utilise : ' + nf.format(me.storageUsedMb) + ' / ' + nf.format(me.storageMaxMb) + ' Mo';
}

function renderHistory(items) {
  const ul = $('history');
  ul.textContent = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Aucune activite pour le moment.';
    ul.appendChild(li);
    return;
  }
  items.forEach((h) => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.append(document.createTextNode(h.label));
    const when = document.createElement('span');
    when.className = 'when';
    when.textContent = new Date(h.at).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    left.appendChild(when);
    const right = document.createElement('div');
    if (h.type === 'recharge') { right.className = 'pos'; right.textContent = '+' + nf.format(h.mb) + ' Mo'; }
    else if (h.type === 'withdraw' && h.mb > 0) { right.className = 'neg'; right.textContent = '\u2212' + nf.format(h.mb) + ' Mo'; }
    else if (h.type === 'plan') { right.textContent = 'Illimite'; }
    else { right.textContent = 'Premium'; }
    li.append(left, right);
    ul.appendChild(li);
  });
}

async function run(fn) {
  try {
    await fn();
  } catch (err) {
    if (err.status === 401 && !$('app').hidden) { showAuth(); say('Session expiree. Reconnecte-toi.', 'err'); return; }
    say(err.message, 'err');
  }
}

async function loadMe() {
  try {
    render(await api('GET', '/api/me'));
  } catch {
    showAuth();
  }
}

$('authSwitch').addEventListener('click', () => { say(''); setMode(mode === 'login' ? 'register' : 'login'); });

$('authForm').addEventListener('submit', (e) => {
  e.preventDefault();
  run(async () => {
    say('');
    await api('POST', mode === 'login' ? '/api/login' : '/api/register', {
      email: $('f-email').value,
      password: $('f-pwd').value,
    });
    $('f-pwd').value = '';
    render(await api('GET', '/api/me'));
  });
});

$('logout').addEventListener('click', () => run(async () => {
  await api('POST', '/api/logout');
  say('');
  showAuth();
}));

function activatePlan(planId) {
  run(async () => {
    const me = await api('POST', '/api/plan', { planId });
    render(me);
    say((me.planLabel || 'Forfait') + ' actif jusqu\u2019au ' + new Date(me.planUntil).toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' (simulation).', 'ok');
  });
}

function recharge(amount) {
  run(async () => {
    const me = await api('POST', '/api/recharge', { amount });
    render(me);
    say('Recharge simulee : ' + nf.format(me.tick.mb) + ' Mo ajoutes (ne perime jamais).', 'ok');
  });
}

$('premiumBtn').addEventListener('click', () => run(async () => {
  const me = await api('POST', '/api/premium');
  render(me);
  say('Premium actif jusqu\u2019au ' + new Date(me.premiumUntil).toLocaleDateString('fr-FR') + ' (simulation).', 'ok');
}));

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
}

$('addFile').addEventListener('click', () => run(async () => {
  const input = $('fileInput');
  const file = input.files && input.files[0];
  if (!file) { say('Choisis un fichier d\u2019abord.', 'err'); return; }
  const needMb = file.size / 1048576;
  if (lastMe && !lastMe.planActive && lastMe.stockMb < needMb) {
    say('Stock insuffisant : ce fichier demande ' + nf.format(needMb) + ' Mo, il te reste ' + nf.format(lastMe.stockMb) + ' Mo. Active un forfait illimite ou recharge ton stock.', 'err');
    return;
  }
  const data = await readFileAsDataUrl(file);
  const me = await api('POST', '/api/files', { name: file.name, type: file.type, data });
  input.value = '';
  render(me);
  say(file.name + (me.planActive ? ' enregistre hors ligne (forfait illimite, aucun Mo deduit).' : ' enregistre hors ligne (' + nf.format(needMb) + ' Mo deduits de ton stock).'), 'ok');
}));

async function openFile(id, name) {
  await run(async () => {
    const file = await api('GET', '/api/files/' + id);
    const a = document.createElement('a');
    a.href = file.data;
    a.download = name;
    a.target = '_blank';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
}

function removeFile(id) {
  run(async () => {
    const me = await api('DELETE', '/api/files/' + id);
    render(me);
    say(me.removed + ' supprime.', 'ok');
  });
}

setMode('login');
loadMe();
