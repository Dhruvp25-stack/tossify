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

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ─── Static: user frontend (public) ───────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── HIDDEN Admin panel – secret URL only ─────────────────────
const ADMIN_PATH = '/panel25';          // ← change this secret!
app.use(ADMIN_PATH, express.static(path.join(__dirname, 'admin')));

// Block obvious admin guesses
['admin','panel','dashboard','cp','control','backend','manage'].forEach(slug => {
  app.get([`/${slug}`, `/${slug}/*`], (_, res) => res.status(404).send('Not Found'));
});

// ─── DB helpers ───────────────────────────────────────────────
const DB_FILE      = path.join(__dirname, 'data', 'db.json');
const MATCHES_FILE = path.join(__dirname, 'data', 'live_matches.json');

// ─── Admin deposit account (editable from admin panel) ────────
const ADMIN_DEPOSIT_FILE = path.join(__dirname, 'data', 'deposit_account.json');
function loadDepositAccount() {
  try {
    if (fs.existsSync(ADMIN_DEPOSIT_FILE)) return JSON.parse(fs.readFileSync(ADMIN_DEPOSIT_FILE, 'utf8'));
  } catch(e) {}
  return { bank:'CANARA BANK', acc:'110217291024', ifsc:'CNRB0017040', upi:'dhpatnu@okicici' };
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
    users: [],
    bets: [],
    deposits: [],
    withdrawals: [],
    tickets: [],
    adminMatches: []       // manually added by admin
  };
}
function saveDB() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2)); } catch(e) {}
}

let DB = loadDB();

// ─── In-memory scraped matches (survives Render restarts via re-scrape) ──
let inMemoryMatches = [];

// ─── Matches: merge in-memory + file + admin-added ────────────────────
function getLiveMatches() {
  let scraped = [];
  try {
    // First try in-memory (fastest, always fresh)
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
          logo1: m.logo1 || null,
          logo2: m.logo2 || null,
          time:  m.bet_closing_time || 'TBD',
          source: 'scraped',
          active: true
        };
      });
    }
  } catch(e) {}

  const adminOnes = (DB.adminMatches || []).filter(m => m.active);
  // Merge: admin ones first, then scraped (dedupe by teamA+teamB)
  const seen = new Set(adminOnes.map(m => `${m.teamA}|${m.teamB}`));
  const merged = [...adminOnes];
  scraped.forEach(m => {
    const key = `${m.teamA}|${m.teamB}`;
    if (!seen.has(key)) { seen.add(key); merged.push(m); }
  });
  return merged;
}

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

// ─── Wager requirement ────────────────────────────────────────
// User must wager 70% of total deposited before withdrawing
function canWithdraw(user) {
  const totalDeposited = (user.deposits || [])
    .filter(d => d.status === 'Approved')
    .reduce((s, d) => s + d.amount, 0);
  const totalWagered   = (user.bets || [])
    .filter(b => b.status !== 'Void')
    .reduce((s, b) => s + b.amount, 0);
  const required = totalDeposited * 0.70;
  return { ok: totalWagered >= required, wagered: totalWagered, required, totalDeposited };
}

// ══════════════════════════════════════════════════════════════
//  USER API
// ══════════════════════════════════════════════════════════════

// Register
app.post('/api/register', (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password)
    return res.json({ ok: false, msg: 'All fields are required' });
  if (username.toLowerCase() === 'demo')
    return res.json({ ok: false, msg: 'Username "demo" is reserved' });
  if (DB.users.find(u => u.username === username.toLowerCase()))
    return res.json({ ok: false, msg: 'Username already taken' });

  const user = {
    id: genId('u'), name, username: username.toLowerCase(), password,
    email: '', mobile: '', joined: new Date().toLocaleDateString('en-IN'),
    balance: 0, bankSaved: false, bankDetails: {},
    bets: [], transactions: [], tickets: [],
    deposits: [],   // track approved deposits for wager calc
    blocked: false
  };
  DB.users.push(user); saveDB();
  res.json({ ok: true });
});

// Login
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  // Demo user
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

// Auth middleware
function auth(req, res, next) {
  const sess = getSession(req.headers['x-token']);
  if (!sess) return res.json({ ok: false, msg: 'Unauthorized' });
  if (sess.userId === 'demo_user') {
    req.isDemo = true; req.user = { id:'demo_user', isDemo:true }; return next();
  }
  const user = findUser(sess.userId);
  if (!user) return res.json({ ok: false, msg: 'User not found' });
  if (user.blocked) return res.json({ ok: false, msg: 'Account blocked' });
  req.user = user; req.isDemo = false;
  next();
}

function demoBlock(req, res, next) {
  if (req.isDemo) return res.json({ ok: false, msg: 'Demo users cannot use this feature. Please register.' });
  next();
}

app.post('/api/logout', auth, (req, res) => { killSession(req.headers['x-token']); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => {
  if (req.isDemo) return res.json({ ok: true, user: req.user });
  res.json({ ok: true, user: pub(req.user) });
});

// Save email + mobile
app.post('/api/contact', auth, demoBlock, (req, res) => {
  const { email, mobile } = req.body;
  if (!email || !mobile || mobile.length !== 10)
    return res.json({ ok: false, msg: 'Enter valid email and 10-digit mobile' });
  req.user.email = email; req.user.mobile = mobile; saveDB();
  res.json({ ok: true, user: pub(req.user) });
});

// Save bank details (once only)
app.post('/api/bank', auth, demoBlock, (req, res) => {
  if (req.user.bankSaved) return res.json({ ok: false, msg: 'Bank details already saved and locked' });
  const { holder, bank, acc, ifsc } = req.body;
  if (!holder || !bank || !acc || !ifsc) return res.json({ ok: false, msg: 'All fields required' });
  req.user.bankDetails = { holder, bank, acc, ifsc };
  req.user.bankSaved = true; saveDB();
  res.json({ ok: true, user: pub(req.user) });
});

// Get live matches
app.get('/api/matches', (req, res) => res.json({ ok: true, matches: getLiveMatches() }));

// Get deposit account info (public)
app.get('/api/deposit-account', (req, res) => res.json({ ok: true, account: depositAccount }));

// Place bet
app.post('/api/bet', auth, demoBlock, (req, res) => {
  const { matchId, team, amount } = req.body;
  const amt = parseFloat(amount);
  if (isNaN(amt) || amt < 50) return res.json({ ok: false, msg: 'Minimum bet is ₹50' });
  if (amt > req.user.balance) return res.json({ ok: false, msg: 'Insufficient balance' });

  const allM = getLiveMatches();
  const match = allM.find(m => m.id === matchId && m.active);
  if (!match) return res.json({ ok: false, msg: 'Match not found or already ended' });

  // ─── Bet closing time check ───────────────────────────────
  if (match.time && match.time !== 'TBD') {
    try {
      // Parse time like "7:30 PM" or "19:30" or full datetime
      const timeStr = match.time.trim();
      const now = new Date();
      // Try parsing as a time (HH:MM AM/PM or HH:MM)
      const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const mins = parseInt(timeMatch[2]);
        const period = timeMatch[3] ? timeMatch[3].toUpperCase() : null;
        if (period === 'PM' && hours < 12) hours += 12;
        if (period === 'AM' && hours === 12) hours = 0;
        const closing = new Date(now);
        closing.setHours(hours, mins, 0, 0);
        if (now > closing) {
          return res.json({ ok: false, msg: 'Bet closing time has passed. Bets are no longer accepted for this match.' });
        }
      }
    } catch(e) { /* if parsing fails, allow bet */ }
  }
  // ─────────────────────────────────────────────────────────

  const bet = {
    id: genId('b'), userId: req.user.id, userName: req.user.name,
    matchId, match: `${match.teamA} vs ${match.teamB}`,
    team, amount: amt, odds: 1.95,
    potential: parseFloat((amt * 1.95).toFixed(2)),
    status: 'Pending', time: new Date().toLocaleString('en-IN')
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
  const { utr, amount } = req.body;
  const amt = parseFloat(amount);
  if (!utr || utr.length < 10) return res.json({ ok: false, msg: 'Enter valid 12-digit UTR' });
  if (isNaN(amt) || amt < 300) return res.json({ ok: false, msg: 'Minimum deposit is ₹300' });

  const dep = {
    id: genId('d'), userId: req.user.id, userName: req.user.name,
    utr, amount: amt, status: 'Pending', time: new Date().toLocaleString('en-IN')
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

  // Wager check
  const { ok: wOk, wagered, required } = canWithdraw(req.user);
  if (!wOk) {
    return res.json({
      ok: false,
      msg: `You must wager ₹${required.toFixed(0)} (70% of deposits) before withdrawing. You've wagered ₹${wagered.toFixed(0)} so far.`
    });
  }

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

// Get wager status
app.get('/api/wager-status', auth, demoBlock, (req, res) => {
  const info = canWithdraw(req.user);
  res.json({ ok: true, ...info });
});

// Support ticket
app.post('/api/ticket', auth, demoBlock, (req, res) => {
  const { subject, message } = req.body;
  if (!subject || !message || message.length < 5)
    return res.json({ ok: false, msg: 'Subject and message required' });
  const tk = {
    id: genId('TK'), userId: req.user.id, userName: req.user.name,
    subject, message, status: 'Open', reply: '',
    time: new Date().toLocaleString('en-IN')
  };
  DB.tickets.unshift(tk);
  req.user.tickets.unshift(tk.id);
  saveDB();
  io.to('admin').emit('db:tickets', DB.tickets);
  res.json({ ok: true, ticket: tk });
});

app.get('/api/tickets',      auth, demoBlock, (req, res) => {
  res.json({ ok: true, tickets: DB.tickets.filter(t => t.userId === req.user.id) });
});
app.get('/api/transactions', auth, demoBlock, (req, res) => {
  res.json({ ok: true, transactions: req.user.transactions || [] });
});
app.get('/api/bets',         auth, demoBlock, (req, res) => {
  res.json({ ok: true, bets: req.user.bets || [] });
});

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

app.post('/api/admin/logout', adminAuth, (req, res) => {
  killSession(req.headers['x-token']); res.json({ ok: true });
});

// All data
app.get('/api/admin/data', adminAuth, (req, res) => {
  res.json({
    ok: true,
    users: DB.users.map(pub),
    adminMatches: DB.adminMatches || [],
    allMatches: getLiveMatches(),
    bets: DB.bets,
    deposits: DB.deposits,
    withdrawals: DB.withdrawals,
    tickets: DB.tickets,
    depositAccount: depositAccount
  });
});

// User – block/unblock
app.post('/api/admin/user/block', adminAuth, (req, res) => {
  const u = findUser(req.body.userId);
  if (!u) return res.json({ ok: false });
  u.blocked = !u.blocked; saveDB();
  io.to(u.id).emit('account:blocked', { blocked: u.blocked });
  res.json({ ok: true, blocked: u.blocked });
});

// User – balance
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

// User – edit bank/withdrawal details (admin override)
app.post('/api/admin/user/bank', adminAuth, (req, res) => {
  const { userId, holder, bank, acc, ifsc } = req.body;
  const u = findUser(userId);
  if (!u) return res.json({ ok: false, msg: 'User not found' });
  if (!holder || !bank || !acc || !ifsc) return res.json({ ok: false, msg: 'All bank fields required' });
  u.bankDetails = { holder, bank, acc, ifsc };
  u.bankSaved = true;
  saveDB();
  io.to(u.id).emit('bank:updated', { bankDetails: u.bankDetails });
  res.json({ ok: true });
});

// Admin – edit own deposit account details
app.post('/api/admin/deposit-account', adminAuth, (req, res) => {
  const { bank, acc, ifsc, upi } = req.body;
  if (!bank || !acc || !ifsc || !upi) return res.json({ ok: false, msg: 'All deposit account fields required' });
  depositAccount = { bank, acc, ifsc, upi };
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
      // Track for wager calculation
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
    if (w.status === 'Rejected') u.balance += w.amount; // refund
    const tx = u.transactions.find(t => t.id === w.id);
    if (tx) tx.status = w.status;
    saveDB();
    io.to(u.id).emit('balance:update', { balance: u.balance });
    io.to(u.id).emit('tx:update', { transactions: u.transactions });
  }
  io.to('admin').emit('db:withdrawals', DB.withdrawals);
  res.json({ ok: true });
});

// Settle bet ← KEY FEATURE
app.post('/api/admin/bet/settle', adminAuth, (req, res) => {
  const { id, result } = req.body; // Won / Lost / Void
  const bet = DB.bets.find(b => b.id === id);
  if (!bet || bet.status !== 'Pending')
    return res.json({ ok: false, msg: 'Bet not found or already settled' });

  bet.status = result;
  const u = findUser(bet.userId);
  if (u) {
    const ub = u.bets.find(b => b.id === id);
    if (ub) ub.status = result;
    if (result === 'Won')  u.balance += bet.potential;
    if (result === 'Void') u.balance += bet.amount;
    saveDB();
    // Emit to that specific user room
    io.to(bet.userId).emit('balance:update', { balance: u.balance });
    io.to(bet.userId).emit('bets:settled', { betId: id, result, balance: u.balance });
  }
  io.to('admin').emit('db:bets', DB.bets);
  // Broadcast to ALL users that a result is out (for live feel)
  io.emit('match:result', { match: bet.match, team: bet.team, result });
  res.json({ ok: true });
});

// ── MATCHES (admin) ──────────────────────────────────────────
app.post('/api/admin/match/add', adminAuth, (req, res) => {
  const { teamA, teamB, time } = req.body;
  if (!teamA || !teamB) return res.json({ ok: false, msg: 'Team names required' });
  if (!DB.adminMatches) DB.adminMatches = [];
  const m = { id: genId('m'), teamA: teamA.trim(), teamB: teamB.trim(), teamAEmoji:'🏏', teamBEmoji:'🏏', time: time||'TBD', source:'admin', active: true };
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

// ── TICKETS (admin) ──────────────────────────────────────────
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

// ── Live matches JSON endpoint (for Python scraper to POST to) ──
app.post('/api/scraper/push', (req, res) => {
  const secret = req.headers['x-scraper-key'];
  if (secret !== 'my_new_scraper') return res.status(403).json({ ok: false });
  try {
    // Store in memory (works even if filesystem is ephemeral on Render)
    const rawMatches = req.body.matches || [];
    inMemoryMatches = rawMatches.map(m => {
      const parts = m.match ? m.match.split(/\s+vs\s+/i) : ['Team A', 'Team B'];
      return {
        id: 'sc_' + Buffer.from(m.match||'').toString('base64').slice(0,10),
        teamA: parts[0]?.trim() || 'Team A',
        teamB: parts[1]?.trim() || 'Team B',
        logo1: m.logo1 || null,
        logo2: m.logo2 || null,
        time:  m.bet_closing_time || 'TBD',
        source: 'scraped',
        active: true
      };
    });
    // Also try to write file as backup
    try { fs.writeFileSync(MATCHES_FILE, JSON.stringify(req.body, null, 2)); } catch(e) {}
    io.emit('matches:update', { matches: getLiveMatches() });
    res.json({ ok: true, count: inMemoryMatches.length });
  } catch(e) { res.json({ ok: false, msg: e.message }); }
});

// Serve live_matches.json publicly (for debugging)
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

// ─── Cron: clear old scraped matches every 1 AM ──────────────
cron.schedule('0 1 * * *', () => {
  try {
    const empty = { updated_at: new Date().toISOString(), total_matches: 0, matches: [] };
    fs.writeFileSync(MATCHES_FILE, JSON.stringify(empty, null, 2));
    io.emit('matches:update', { matches: getLiveMatches() });
    console.log('[Tossify] Scraped matches cleared at 1AM');
  } catch(e) {}
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🪙  Tossify  →  http://localhost:${PORT}`);
  console.log(`🔐  Admin    →  http://localhost:${PORT}${ADMIN_PATH}/`);
  console.log(`    Creds    →  admin / Admin@Tossify25\n`);
});
