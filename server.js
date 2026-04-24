// ═══════════════════════════════════════════════════════════════
//  TOSSIFY SERVER  –  Node.js + Express + Socket.io
// ═══════════════════════════════════════════════════════════════
const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const fs       = require('fs');
const { v4: uuidv4 } = require('uuid');
const cron     = require('node-cron');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static: user frontend (public) ───────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── HIDDEN Admin panel – secret URL only ─────────────────────
const ADMIN_PATH = '/panel25';
app.use(ADMIN_PATH, express.static(path.join(__dirname, 'admin')));

['admin','panel','dashboard','cp','control','backend','manage'].forEach(slug => {
  app.get([`/${slug}`, `/${slug}/*`], (_, res) => res.status(404).send('Not Found'));
});

// ─── DB helpers ───────────────────────────────────────────────
const DB_FILE      = path.join(__dirname, 'data', 'db.json');
const MATCHES_FILE = path.join(__dirname, 'data', 'live_matches.json');
const ADMIN_DEPOSIT_FILE = path.join(__dirname, 'data', 'deposit_account.json');

function loadDepositAccount() {
  try {
    if (fs.existsSync(ADMIN_DEPOSIT_FILE)) return JSON.parse(fs.readFileSync(ADMIN_DEPOSIT_FILE, 'utf8'));
  } catch(e) {}
  return { bank:'CANARA BANK', acc:'110217291024', ifsc:'CNRB0017040', upi:'dhpatnu@okicici', qrImage: null };
}
function saveDepositAccount() {
  try { fs.writeFileSync(ADMIN_DEPOSIT_FILE, JSON.stringify(depositAccount, null, 2)); } catch(e) {}
}
let depositAccount = loadDepositAccount();

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch(e) {}
  return {
    users: [], bets: [], deposits: [], withdrawals: [], tickets: [],
    adminMatches: [],
    settledMatches: {},   // matchId -> { winnerTeam | 'cancelled', settledAt }
  };
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch(e) {}
}
let DB = loadDB();
if (!DB.settledMatches) DB.settledMatches = {};

// ─── Maintenance mode ─────────────────────────────────────────
let maintenanceMode = false;

// ─── In-memory scraped matches ────────────────────────────────
let inMemoryMatches = [];

// ─── Parse a "time" string into a Date (IST-aware) ────────────
// Supports: "7:30 PM", "19:30", "23 Apr 08:25 AM", "22 Apr 2025 7:30 PM"
// All times from scraper are in IST (UTC+5:30). Render runs UTC.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // 5h30m in ms

function nowIST() {
  return new Date(Date.now() + IST_OFFSET_MS);
}

function parseMatchTime(timeStr) {
  if (!timeStr || timeStr === 'TBD') return null;
  try {
    const s = timeStr.trim();
    const now = nowIST(); // Use IST "now" for comparison base

    // "23 Apr 08:25 AM" or "22 Apr 7:30 PM" (with optional year)
    const withDate = s.match(/(\d{1,2})\s+([A-Za-z]{3})(?:\s+\d{4})?\s+(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (withDate) {
      const day   = parseInt(withDate[1]);
      const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
                    .indexOf(withDate[2].toLowerCase());
      let h = parseInt(withDate[3]);
      const m = parseInt(withDate[4]);
      const p = withDate[5] ? withDate[5].toUpperCase() : null;
      if (p === 'PM' && h < 12) h += 12;
      if (p === 'AM' && h === 12) h = 0;
      // Build as IST time then convert to UTC for JS Date comparison
      const istMs = Date.UTC(now.getFullYear(), month >= 0 ? month : now.getMonth(), day, h, m, 0) - IST_OFFSET_MS;
      const dt = new Date(istMs);
      return isNaN(dt.getTime()) ? null : dt;
    }

    // "7:30 PM" or "08:25 AM" or "19:30" — time only, assume today IST
    const timeOnly = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    if (timeOnly) {
      let h = parseInt(timeOnly[1]);
      const m = parseInt(timeOnly[2]);
      const p = timeOnly[3] ? timeOnly[3].toUpperCase() : null;
      if (p === 'PM' && h < 12) h += 12;
      if (p === 'AM' && h === 12) h = 0;
      const istMs = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0) - IST_OFFSET_MS;
      const dt = new Date(istMs);
      return isNaN(dt.getTime()) ? null : dt;
    }
  } catch(e) {}
  return null;
}

// ─── Is betting open for a match? ────────────────────────────
function isBettingOpen(match) {
  // If match already settled/cancelled, no
  if (DB.settledMatches[match.id]) return false;
  const t = parseMatchTime(match.time);
  if (!t) return true; // TBD = open
  return new Date() < t;
}

// ─── Matches: merge in-memory + file + admin-added ────────────
function buildAllMatches() {
  let scraped = [];
  try {
    if (inMemoryMatches.length > 0) {
      scraped = inMemoryMatches;
    } else if (fs.existsSync(MATCHES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(MATCHES_FILE, 'utf8'));
      scraped = (raw.matches || []).map(m => {
        const parts = m.match ? m.match.split(/\s+vs\s+/i) : ['Team A', 'Team B'];
        return {
          id: 'sc_' + Buffer.from(m.match||'').toString('base64').slice(0,10),
          teamA: parts[0]?.trim() || 'Team A',
          teamB: parts[1]?.trim() || 'Team B',
          logo1: m.logo1 || null, logo2: m.logo2 || null,
          time:  m.bet_closing_time || 'TBD',
          source: 'scraped', active: true
        };
      });
    }
  } catch(e) {}

  const adminOnes = (DB.adminMatches || []).filter(m => m.active !== false);
  const seen = new Set(adminOnes.map(m => `${m.teamA}|${m.teamB}`));
  const merged = [...adminOnes];
  scraped.forEach(m => {
    const key = `${m.teamA}|${m.teamB}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  });
  return merged.map(m => ({
    ...m,
    bettingOpen: isBettingOpen(m),
    settled: DB.settledMatches[m.id] || null
  }));
}

// Admin sees ALL matches (settled + unsettled)
function getLiveMatchesAdmin() {
  return buildAllMatches();
}

// Users ONLY see unsettled matches — settled never reappear
function getLiveMatches() {
  return buildAllMatches().filter(m => !DB.settledMatches[m.id]);
}

// ─── Cron: auto-close betting when time passes ────────────────
cron.schedule('* * * * *', () => {
  // Users get filtered (no settled), admin gets all
  io.emit('matches:update', { matches: getLiveMatches() });
  io.emit('matches:admin:update', { matches: getLiveMatchesAdmin() });
});

// ─── Session tokens ───────────────────────────────────────────
const sessions = {};
function makeToken(userId, isAdmin = false) {
  const t = uuidv4(); sessions[t] = { userId, isAdmin }; return t;
}
function getSession(t) { return sessions[t] || null; }
function killSession(t) { delete sessions[t]; }

// ─── Helpers ──────────────────────────────────────────────────
function genId(p) { return p + uuidv4().replace(/-/g,'').slice(0,10).toUpperCase(); }
function findUser(id) { return DB.users.find(u => u.id === id); }
function pub(u) { const { password, ...s } = u; return s; }

function canWithdraw(user) {
  const totalDeposited = (user.deposits || []).filter(d => d.status === 'Approved').reduce((s, d) => s + d.amount, 0);
  const totalWagered   = (user.bets || []).filter(b => b.status !== 'Void').reduce((s, b) => s + b.amount, 0);
  const required = totalDeposited * 0.70;
  return { ok: totalWagered >= required, wagered: totalWagered, required, totalDeposited };
}

// ══════════════════════════════════════════════════════════════
//  USER API
// ══════════════════════════════════════════════════════════════

app.post('/api/register', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) return res.json({ ok: false, msg: 'All fields are required' });
  if (username.toLowerCase() === 'demo') return res.json({ ok: false, msg: 'Username "demo" is reserved' });
  if (DB.users.find(u => u.username === username.toLowerCase()))
    return res.json({ ok: false, msg: 'Username already taken' });
  const user = {
    id: genId('u'), name, username: username.toLowerCase(), password,
    email: '', mobile: '', joined: new Date().toLocaleDateString('en-IN'),
    balance: 0, bankSaved: false, bankDetails: {},
    bets: [], transactions: [], tickets: [], deposits: [], blocked: false
  };
  DB.users.push(user); saveDB();
  res.json({ ok: true });
});

app.post('/api/login', (req, res) => {
  // Maintenance mode blocks regular user login (not demo, not admin)
  const { username, password } = req.body;
  if (maintenanceMode && username.toLowerCase() !== 'demo') {
    return res.json({ ok: false, msg: '🔧 Site is under maintenance. Please try again later.' });
  }
  if (username.toLowerCase() === 'demo') {
    const token = makeToken('demo_user', false);
    return res.json({
      ok: true, token, isDemo: true,
      user: { id:'demo_user', name:'Demo User', username:'demo', email:'', mobile:'', joined:'—', balance: 0, bankSaved:false, bankDetails:{}, bets:[], transactions:[], tickets:[], blocked:false, isDemo:true }
    });
  }
  const user = DB.users.find(u => u.username === username.toLowerCase() && u.password === password);
  if (!user) return res.json({ ok: false, msg: 'Invalid credentials' });
  if (user.blocked) return res.json({ ok: false, msg: 'Account blocked. Contact support.' });
  const token = makeToken(user.id);
  res.json({ ok: true, token, isDemo: false, user: pub(user) });
});

function auth(req, res, next) {
  const sess = getSession(req.headers['x-token']);
  if (!sess) return res.json({ ok: false, msg: 'Unauthorized' });
  if (sess.userId === 'demo_user') {
    req.isDemo = true; req.user = { id:'demo_user', isDemo:true }; return next();
  }
  const user = findUser(sess.userId);
  if (!user) return res.json({ ok: false, msg: 'User not found' });
  if (user.blocked) return res.json({ ok: false, msg: 'Account blocked' });
  req.user = user; req.isDemo = false; next();
}
function demoBlock(req, res, next) {
  if (req.isDemo) return res.json({ ok: false, msg: 'Demo users cannot use this feature. Please register.' });
  next();
}

app.post('/api/logout', auth, (req, res) => { killSession(req.headers['x-token']); res.json({ ok: true }); });

// ─── Maintenance mode status (public) ─────────────────────────
app.get('/api/maintenance', (req, res) => res.json({ maintenance: maintenanceMode }));
app.get('/api/me', auth, (req, res) => {
  if (req.isDemo) return res.json({ ok: true, user: req.user });
  res.json({ ok: true, user: pub(req.user) });
});

app.post('/api/contact', auth, demoBlock, (req, res) => {
  const { email, mobile } = req.body;
  if (!email || !mobile || mobile.length !== 10) return res.json({ ok: false, msg: 'Enter valid email and 10-digit mobile' });
  req.user.email = email; req.user.mobile = mobile; saveDB();
  res.json({ ok: true, user: pub(req.user) });
});

app.post('/api/bank', auth, demoBlock, (req, res) => {
  if (req.user.bankSaved) return res.json({ ok: false, msg: 'Bank details already saved and locked' });
  const { holder, bank, acc, ifsc } = req.body;
  if (!holder || !bank || !acc || !ifsc) return res.json({ ok: false, msg: 'All fields required' });
  req.user.bankDetails = { holder, bank, acc, ifsc };
  req.user.bankSaved = true; saveDB();
  res.json({ ok: true, user: pub(req.user) });
});

// Get live matches — only show unsettled ones to users (getLiveMatches already filters settled)
app.get('/api/matches', (req, res) => {
  res.json({ ok: true, matches: getLiveMatches() });
});

app.get('/api/deposit-account', (req, res) => res.json({ ok: true, account: depositAccount }));

// Place bet
app.post('/api/bet', auth, demoBlock, (req, res) => {
  const { matchId, team, amount } = req.body;
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 50)    return res.json({ ok: false, msg: 'Minimum bet is ₹50' });
  if (amt > 10000)               return res.json({ ok: false, msg: 'Maximum bet per match is ₹10,000' });
  if (amt > req.user.balance)    return res.json({ ok: false, msg: 'Insufficient balance' });

  const allM = getLiveMatches();
  const match = allM.find(m => m.id === matchId);
  if (!match) return res.json({ ok: false, msg: 'Match not found' });
  if (DB.settledMatches[matchId]) return res.json({ ok: false, msg: 'This match has already been settled.' });

  // Check user has not already bet ₹10,000 on this match
  const existingBets = DB.bets.filter(b => b.userId === req.user.id && b.matchId === matchId && b.status === 'Pending');
  const alreadyBet   = existingBets.reduce((s, b) => s + b.amount, 0);
  if (alreadyBet + amt > 10000) {
    return res.json({ ok: false, msg: `Bet limit per match is ₹10,000. You've already bet ₹${alreadyBet.toFixed(0)} on this match.` });
  }

  // Bet closing time check
  if (!isBettingOpen(match)) {
    return res.json({ ok: false, msg: 'Bet closing time has passed. Bets are no longer accepted for this match.' });
  }

  const bet = {
    id: genId('b'), userId: req.user.id, userName: req.user.name,
    matchId, match: `${match.teamA} vs ${match.teamB}`,
    team, amount: amt, odds: 1.95,
    potential: parseFloat((amt * 1.95).toFixed(2)),
    status: 'Pending', time: new Date().toLocaleString('en-IN'),
    closingTime: match.time || 'TBD'
  };

  req.user.balance -= amt;
  req.user.bets.unshift(bet);
  DB.bets.unshift({ ...bet });
  saveDB();

  io.to('admin').emit('db:bets', DB.bets);
  io.to(req.user.id).emit('balance:update', { balance: req.user.balance });
  res.json({ ok: true, bet, balance: req.user.balance });
});

// Deposit
app.post('/api/deposit', auth, demoBlock, (req, res) => {
  const { utr, amount, screenshot } = req.body;
  const amt = parseFloat(amount);
  if (!utr || utr.length < 10) return res.json({ ok: false, msg: 'Enter valid 12-digit UTR' });
  if (isNaN(amt) || amt < 300) return res.json({ ok: false, msg: 'Minimum deposit is ₹300' });
  if (!screenshot) return res.json({ ok: false, msg: 'Please upload a payment screenshot' });

  const dep = {
    id: genId('d'), userId: req.user.id, userName: req.user.name,
    utr, amount: amt, screenshot, status: 'Pending', time: new Date().toLocaleString('en-IN')
  };
  DB.deposits.unshift(dep);
  req.user.transactions.unshift({ id: dep.id, type: 'Deposit', amount: amt, status: 'Pending', time: dep.time });
  saveDB();
  io.to('admin').emit('db:deposits', DB.deposits);
  res.json({ ok: true });
});

// Withdraw
app.post('/api/withdraw', auth, demoBlock, (req, res) => {
  if (!req.user.bankSaved) return res.json({ ok: false, msg: 'Add bank details in Profile first' });
  const amt = parseFloat(req.body.amount);
  if (isNaN(amt) || amt < 300) return res.json({ ok: false, msg: 'Minimum withdrawal is ₹300' });
  if (amt > req.user.balance) return res.json({ ok: false, msg: 'Insufficient balance' });
  const { ok: wOk, wagered, required } = canWithdraw(req.user);
  if (!wOk) return res.json({ ok: false, msg: `You must wager ₹${required.toFixed(0)} (70% of deposits) before withdrawing. You've wagered ₹${wagered.toFixed(0)} so far.` });

  const w = {
    id: genId('w'), userId: req.user.id, userName: req.user.name,
    amount: amt, status: 'Pending', time: new Date().toLocaleString('en-IN'),
    bank: req.user.bankDetails
  };
  req.user.balance -= amt;
  req.user.transactions.unshift({ id: w.id, type: 'Withdrawal', amount: amt, status: 'Pending', time: w.time });
  DB.withdrawals.unshift(w);
  saveDB();
  io.to('admin').emit('db:withdrawals', DB.withdrawals);
  io.to(req.user.id).emit('balance:update', { balance: req.user.balance });
  res.json({ ok: true, balance: req.user.balance });
});

app.get('/api/wager-status', auth, demoBlock, (req, res) => {
  res.json({ ok: true, ...canWithdraw(req.user) });
});

app.post('/api/ticket', auth, demoBlock, (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message || message.length < 5) return res.json({ ok: false, msg: 'Subject and message required' });
  const tk = {
    id: genId('TK'), userId: req.user.id, userName: req.user.name,
    subject, message, status: 'Open', reply: '', time: new Date().toLocaleString('en-IN')
  };
  DB.tickets.unshift(tk);
  req.user.tickets.unshift(tk.id);
  saveDB();
  io.to('admin').emit('db:tickets', DB.tickets);
  res.json({ ok: true, ticket: tk });
});

app.get('/api/tickets',      auth, demoBlock, (req, res) => res.json({ ok: true, tickets: DB.tickets.filter(t => t.userId === req.user.id) }));
app.get('/api/transactions', auth, demoBlock, (req, res) => res.json({ ok: true, transactions: req.user.transactions || [] }));
app.get('/api/bets',         auth, demoBlock, (req, res) => res.json({ ok: true, bets: req.user.bets || [] }));
app.get('/api/deposit-history',    auth, demoBlock, (req, res) => res.json({ ok: true, deposits:    DB.deposits.filter(d => d.userId === req.user.id) }));
app.get('/api/withdrawal-history', auth, demoBlock, (req, res) => res.json({ ok: true, withdrawals: DB.withdrawals.filter(w => w.userId === req.user.id) }));

// ══════════════════════════════════════════════════════════════
//  ADMIN API
// ══════════════════════════════════════════════════════════════
const ADMIN_CREDS = { username: 'admin', password: 'DDR252429' };

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username !== ADMIN_CREDS.username || password !== ADMIN_CREDS.password)
    return res.json({ ok: false, msg: 'Invalid admin credentials' });
  res.json({ ok: true, token: makeToken('__admin__', true) });
});

function adminAuth(req, res, next) {
  const sess = getSession(req.headers['x-token']);
  if (!sess || !sess.isAdmin) return res.json({ ok: false, msg: 'Unauthorized' });
  next();
}

app.post('/api/admin/logout', adminAuth, (req, res) => { killSession(req.headers['x-token']); res.json({ ok: true }); });

// ─── Admin: toggle maintenance mode ───────────────────────────
app.post('/api/admin/maintenance', adminAuth, (req, res) => {
  maintenanceMode = !!req.body.enabled;
  io.emit('maintenance:update', { maintenance: maintenanceMode });
  res.json({ ok: true, maintenance: maintenanceMode });
});

app.get('/api/admin/data', adminAuth, (req, res) => {
  // Admin sees ALL matches including already-settled ones
  res.json({
    ok: true,
    users: DB.users.map(pub),
    adminMatches: DB.adminMatches || [],
    allMatches: getLiveMatchesAdmin(), // admin sees ALL including settled
    bets: DB.bets,
    deposits: DB.deposits,
    withdrawals: DB.withdrawals,
    tickets: DB.tickets,
    depositAccount: depositAccount,
    settledMatches: DB.settledMatches || {},
    maintenance: maintenanceMode
  });
});

app.post('/api/admin/user/block', adminAuth, (req, res) => {
  const u = findUser(req.body.userId);
  if (!u) return res.json({ ok: false });
  u.blocked = !u.blocked; saveDB();
  io.to(u.id).emit('account:blocked', { blocked: u.blocked });
  res.json({ ok: true, blocked: u.blocked });
});

app.post('/api/admin/user/balance', adminAuth, (req, res) => {
  const { userId, amount, type } = req.body;
  const u = findUser(userId);
  if (!u) return res.json({ ok: false });
  const amt = parseFloat(amount);
  if (type === 'add') u.balance += amt;
  else u.balance = Math.max(0, u.balance - amt);
  const tx = { id: genId('tx'), type: type === 'add' ? 'Admin Credit' : 'Admin Debit', amount: amt, status: 'Approved', time: new Date().toLocaleString('en-IN') };
  u.transactions.unshift(tx); saveDB();
  io.to(u.id).emit('balance:update', { balance: u.balance });
  res.json({ ok: true });
});

app.post('/api/admin/user/bank', adminAuth, (req, res) => {
  const { userId, holder, bank, acc, ifsc } = req.body;
  const u = findUser(userId);
  if (!u) return res.json({ ok: false, msg: 'User not found' });
  if (!holder || !bank || !acc || !ifsc) return res.json({ ok: false, msg: 'All bank fields required' });
  u.bankDetails = { holder, bank, acc, ifsc }; u.bankSaved = true; saveDB();
  io.to(u.id).emit('bank:updated', { bankDetails: u.bankDetails });
  res.json({ ok: true });
});

// Admin – edit deposit account (including QR image)
app.post('/api/admin/deposit-account', adminAuth, (req, res) => {
  const { bank, acc, ifsc, upi, qrImage } = req.body;
  if (!bank || !acc || !ifsc || !upi) return res.json({ ok: false, msg: 'All deposit account fields required' });
  depositAccount = { bank, acc, ifsc, upi, qrImage: qrImage !== undefined ? qrImage : (depositAccount.qrImage || null) };
  saveDepositAccount();
  io.emit('deposit-account:updated', { account: depositAccount });
  res.json({ ok: true });
});

// Deposit approve/reject
app.post('/api/admin/deposit/:action', adminAuth, (req, res) => {
  const dep = DB.deposits.find(d => d.id === req.body.id);
  if (!dep || dep.status !== 'Pending') return res.json({ ok: false, msg: 'Not found or already processed' });
  dep.status = req.params.action === 'approve' ? 'Approved' : 'Rejected';
  const u = findUser(dep.userId);
  if (u) {
    if (dep.status === 'Approved') {
      u.balance += dep.amount;
      if (!u.deposits) u.deposits = [];
      u.deposits.push({ id: dep.id, amount: dep.amount, status: 'Approved' });
    }
    const tx = u.transactions.find(t => t.id === dep.id);
    if (tx) tx.status = dep.status;
    saveDB();
    io.to(u.id).emit('balance:update', { balance: u.balance });
    io.to(u.id).emit('tx:update', { transactions: u.transactions });
  }
  io.to('admin').emit('db:deposits', DB.deposits);
  res.json({ ok: true });
});

// Withdrawal approve/reject
app.post('/api/admin/withdrawal/:action', adminAuth, (req, res) => {
  const w = DB.withdrawals.find(x => x.id === req.body.id);
  if (!w || w.status !== 'Pending') return res.json({ ok: false, msg: 'Not found or already processed' });
  w.status = req.params.action === 'approve' ? 'Approved' : 'Rejected';
  const u = findUser(w.userId);
  if (u) {
    if (w.status === 'Rejected') u.balance += w.amount;
    const tx = u.transactions.find(t => t.id === w.id);
    if (tx) tx.status = w.status;
    saveDB();
    io.to(u.id).emit('balance:update', { balance: u.balance });
    io.to(u.id).emit('tx:update', { transactions: u.transactions });
  }
  io.to('admin').emit('db:withdrawals', DB.withdrawals);
  res.json({ ok: true });
});

// ── SETTLE MATCH — settle ALL bets for a match at once ────────
// result: { action: 'settle', winnerTeam: 'TeamA name' } or { action: 'cancel' }
app.post('/api/admin/match/settle', adminAuth, (req, res) => {
  const { matchId, action, winnerTeam } = req.body;
  if (!matchId || !action) return res.json({ ok: false, msg: 'matchId and action required' });
  if (action === 'settle' && !winnerTeam) return res.json({ ok: false, msg: 'winnerTeam required for settle' });

  // Mark match as settled
  DB.settledMatches[matchId] = {
    action,
    winnerTeam: action === 'settle' ? winnerTeam : null,
    settledAt: new Date().toLocaleString('en-IN')
  };

  // Also mark admin match as inactive if it exists
  const adminMatch = (DB.adminMatches || []).find(m => m.id === matchId);
  if (adminMatch) adminMatch.active = false;

  // Settle all pending bets for this match
  const matchBets = DB.bets.filter(b => b.matchId === matchId && b.status === 'Pending');
  let settled = 0;

  for (const bet of matchBets) {
    let result;
    if (action === 'cancel') {
      result = 'Void';
    } else {
      result = bet.team === winnerTeam ? 'Won' : 'Lost';
    }

    bet.status = result;
    const u = findUser(bet.userId);
    if (u) {
      const ub = u.bets.find(b => b.id === bet.id);
      if (ub) ub.status = result;

      if (result === 'Won')  u.balance += bet.potential;
      if (result === 'Void') u.balance += bet.amount;

      saveDB();
      io.to(bet.userId).emit('balance:update', { balance: u.balance });
      io.to(bet.userId).emit('bets:settled', { betId: bet.id, result, balance: u.balance, match: bet.match });
    }
    settled++;
  }

  saveDB();

  // Notify all clients
  io.emit('matches:update', { matches: getLiveMatches() });
  io.to('admin').emit('db:bets', DB.bets);
  io.emit('match:result', {
    matchId, action,
    match: matchBets[0]?.match || matchId,
    winnerTeam: action === 'settle' ? winnerTeam : null,
    settledCount: settled
  });

  res.json({ ok: true, settled });
});

// ── MATCHES (admin add/toggle/delete) ────────────────────────
app.post('/api/admin/match/add', adminAuth, (req, res) => {
  const { teamA, teamB, time } = req.body;
  if (!teamA || !teamB) return res.json({ ok: false, msg: 'Team names required' });
  if (!DB.adminMatches) DB.adminMatches = [];
  const m = {
    id: genId('m'), teamA: teamA.trim(), teamB: teamB.trim(),
    teamAEmoji:'🏏', teamBEmoji:'🏏',
    time: time || 'TBD', source:'admin', active: true
  };
  DB.adminMatches.unshift(m); saveDB();
  io.emit('matches:update', { matches: getLiveMatches() });
  res.json({ ok: true, match: m });
});

app.post('/api/admin/match/toggle', adminAuth, (req, res) => {
  const m = (DB.adminMatches||[]).find(x => x.id === req.body.id);
  if (!m) return res.json({ ok: false });
  m.active = !m.active; saveDB();
  io.emit('matches:update', { matches: getLiveMatches() });
  res.json({ ok: true, active: m.active });
});

app.post('/api/admin/match/delete', adminAuth, (req, res) => {
  DB.adminMatches = (DB.adminMatches||[]).filter(x => x.id !== req.body.id);
  saveDB();
  io.emit('matches:update', { matches: getLiveMatches() });
  res.json({ ok: true });
});

// ── TICKETS ──────────────────────────────────────────────────
app.post('/api/admin/ticket/reply', adminAuth, (req, res) => {
  const { id, reply } = req.body;
  const tk = DB.tickets.find(t => t.id === id);
  if (!tk) return res.json({ ok: false });
  tk.reply = reply; tk.status = 'Replied'; saveDB();
  io.to(tk.userId).emit('ticket:update', { id, reply, status: 'Replied' });
  io.to('admin').emit('db:tickets', DB.tickets);
  res.json({ ok: true });
});

app.post('/api/admin/ticket/close', adminAuth, (req, res) => {
  const tk = DB.tickets.find(t => t.id === req.body.id);
  if (!tk) return res.json({ ok: false });
  tk.status = 'Closed'; saveDB();
  io.to(tk.userId).emit('ticket:update', { id: tk.id, reply: tk.reply, status: 'Closed' });
  io.to('admin').emit('db:tickets', DB.tickets);
  res.json({ ok: true });
});

// ── Scraper push ──────────────────────────────────────────────
app.post('/api/scraper/push', (req, res) => {
  const secret = req.headers['x-scraper-key'];
  const validSecret = process.env.SCRAPER_SECRET || 'my_new_scraper';
  if (secret !== validSecret) return res.status(403).json({ ok: false });
  try {
    const rawMatches = req.body.matches || [];
    inMemoryMatches = rawMatches.map(m => {
      const parts = m.match ? m.match.split(/\s+vs\s+/i) : ['Team A', 'Team B'];
      return {
        id: 'sc_' + Buffer.from(m.match||'').toString('base64').slice(0,10),
        teamA: parts[0]?.trim() || 'Team A',
        teamB: parts[1]?.trim() || 'Team B',
        logo1: m.logo1 || null, logo2: m.logo2 || null,
        time:  m.bet_closing_time || 'TBD',
        source: 'scraped', active: true
      };
    });
    try { fs.writeFileSync(MATCHES_FILE, JSON.stringify(req.body, null, 2)); } catch(e) {}
    io.emit('matches:update', { matches: getLiveMatches() });
    res.json({ ok: true, count: inMemoryMatches.length });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

app.get('/api/matches/raw', (_, res) => {
  if (fs.existsSync(MATCHES_FILE)) res.sendFile(MATCHES_FILE);
  else res.json({ matches: [] });
});

// ─── Socket.io ────────────────────────────────────────────────
io.on('connection', socket => {
  socket.on('user:join',  userId => socket.join(userId));
  socket.on('admin:join', token  => {
    const sess = getSession(token);
    if (sess && sess.isAdmin) socket.join('admin');
  });
});

// ─── Cron: clear old scraped matches at 1AM ───────────────────
cron.schedule('0 1 * * *', () => {
  try {
    const empty = { updated_at: new Date().toISOString(), total_matches: 0, matches: [] };
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(empty, null, 2));
    inMemoryMatches = [];
    io.emit('matches:update', { matches: getLiveMatches() });
    console.log('[Tossify] Scraped matches cleared at 1AM');
  } catch(e) {}
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🪙  Tossify  →  http://localhost:${PORT}`);
  console.log(`🔐  Admin    →  http://localhost:${PORT}${ADMIN_PATH}/`);
});
