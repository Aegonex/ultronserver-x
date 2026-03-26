require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const Database = require('better-sqlite3');
const http   = require('http');
const path   = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// ===== SQLite + WAL mode =====
const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY,
    accountNo     TEXT NOT NULL,
    bankName      TEXT NOT NULL,
    sentBy        TEXT NOT NULL,
    target        TEXT NOT NULL,
    status        TEXT DEFAULT 'pending',
    recipientName TEXT,
    errorMessage  TEXT,
    resultRead    INTEGER DEFAULT 0,
    assignedAt    INTEGER DEFAULT 0,
    createdAt     INTEGER NOT NULL,
    doneAt        INTEGER DEFAULT 0
  )
`);

// ===== bank_configs table =====
db.exec(`
  CREATE TABLE IF NOT EXISTS bank_configs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    digits   TEXT NOT NULL,
    keywords TEXT NOT NULL
  )
`);
// Seed defaults if empty
if (db.prepare('SELECT COUNT(*) as n FROM bank_configs').get().n === 0) {
  const ins = db.prepare('INSERT INTO bank_configs (name, digits, keywords) VALUES (?,?,?)');
  [
    ['กสิกรไทย',       '[10]',     '["kbank","k bank","kasikorn","กสิกร"]'],
    ['กรุงเทพ',         '[10]',     '["bbl","bangkok bank","กรุงเทพ"]'],
    ['กรุงไทย',         '[10]',     '["ktb","krungthai","กรุงไทย","กรุงไท"]'],
    ['ทหารไทยธนชาต',   '[10]',     '["ttb","ทหารไทย","ธนชาต","tmb"]'],
    ['ไทยพาณิชย์',     '[10]',     '["scb","siam commercial","พาณิชย์"]'],
    ['กรุงศรีอยุธยา',  '[10]',     '["bay","krungsri","กรุงศรี","อยุธยา"]'],
    ['ออมสิน',          '[12,15]',  '["gsb","government savings","ออมสิน"]'],
    ['ธ.ก.ส.',          '[12]',     '["baac","ธกส","เกษตร"]'],
    ['เกียรตินาคินภัทร','[10,14]', '["kkp","kiatnakin","เกียรตินาคิน"]'],
  ].forEach(d => ins.run(...d));
  console.log('✅ Seeded default bank configs');
}

// ===== SSE Clients =====
// Map: name → res (Express response object)
const sseClients = new Map();

function pushSSE(name, data) {
  const res = sseClients.get(name);
  if (!res) return false;
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  } catch(e) {
    sseClients.delete(name);
    return false;
  }
}

// ===== GET /api/stream/:name — SSE =====
app.get('/api/stream/:name', (req, res) => {
  const { name } = req.params;

  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // สำหรับ Nginx/Railway
  res.flushHeaders();

  // Keepalive ping ทุก 25s (ป้องกัน proxy ตัด connection)
  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  // ลงทะเบียน client
  sseClients.set(name, res);
  console.log(`📡 SSE connected: ${name} (${sseClients.size} online)`);

  // ส่ง pending jobs ทันทีเมื่อ connect (รับงานที่ค้างไว้)
  const pending = db.prepare(
    `SELECT * FROM jobs WHERE target = ? AND status = 'pending' ORDER BY id ASC`
  ).all(name);
  pending.forEach(job => {
    res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`);
  });

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(name);
    console.log(`📡 SSE disconnected: ${name} (${sseClients.size} online)`);

    // คืน assigned jobs กลับเป็น pending เมื่อ receiver ขาด
    db.prepare(
      `UPDATE jobs SET status = 'pending', assignedAt = 0
       WHERE target = ? AND status = 'assigned'`
    ).run(name);
  });
});

// ===== POST /api/jobs — Sender สร้าง job =====
app.post('/api/jobs', (req, res) => {
  const { accountNo, bankName, sentBy, target } = req.body;
  if (!accountNo || !bankName || !sentBy || !target)
    return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบ' });

  const id        = Date.now();
  const createdAt = id;

  db.prepare(
    `INSERT INTO jobs (id, accountNo, bankName, sentBy, target, createdAt)
     VALUES (?,?,?,?,?,?)`
  ).run(id, accountNo, bankName, sentBy, target, createdAt);

  // ลบ jobs เก่าเมื่อเกิน 500 รายการ
  db.prepare(
    `DELETE FROM jobs WHERE id NOT IN
     (SELECT id FROM jobs ORDER BY id DESC LIMIT 500)`
  ).run();

  // Push SSE ไปหา Receiver ทันที
  const pushed = pushSSE(target, {
    type: 'job',
    job: { id, accountNo, bankName, sentBy, target, status: 'pending', createdAt }
  });

  console.log(`📨 [${sentBy}→${target}] ${bankName} ${accountNo} ${pushed ? '⚡SSE' : '⏳queue'}`);
  res.json({ success: true, id });
});

// ===== POST /api/jobs/:id/ack — Receiver ยืนยันรับ job =====
app.post('/api/jobs/:id/ack', (req, res) => {
  const id = parseInt(req.params.id);
  db.prepare(
    `UPDATE jobs SET status = 'assigned', assignedAt = ?
     WHERE id = ? AND status = 'pending'`
  ).run(Date.now(), id);
  res.json({ success: true });
});

// ===== POST /api/jobs/:id/done — Receiver ส่งผลกลับ =====
app.post('/api/jobs/:id/done', (req, res) => {
  const id = parseInt(req.params.id);
  const { status, recipientName, errorMessage } = req.body;

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  if (!job) return res.status(404).json({ success: false, error: 'ไม่พบ job' });

  db.prepare(
    `UPDATE jobs SET status = ?, recipientName = ?, errorMessage = ?, doneAt = ?
     WHERE id = ?`
  ).run(status || 'done', recipientName || null, errorMessage || null, Date.now(), id);

  if (status === 'done' && recipientName) {
    console.log(`✅ [${job.target}→${job.sentBy}] ${recipientName}`);
    pushSSE(job.sentBy, { type: 'result', id, recipientName });
  } else {
    console.log(`❌ [${job.target}→${job.sentBy}] ${errorMessage || ''}`);
    pushSSE(job.sentBy, { type: 'error', id, errorMessage: errorMessage || 'เกิดข้อผิดพลาด' });
  }

  res.json({ success: true });
});

// ===== GET /api/jobs/:id — Sender poll ผล (fallback) =====
app.get('/api/jobs/:id', (req, res) => {
  const job = db.prepare(
    `SELECT id, status, recipientName, errorMessage FROM jobs WHERE id = ?`
  ).get(parseInt(req.params.id));

  if (!job) return res.json({ success: false });

  if (job.status === 'done' || job.status === 'error') {
    db.prepare(`UPDATE jobs SET resultRead = 1 WHERE id = ?`).run(job.id);
  }
  res.json({ success: true, job });
});

// ===== GET /api/poll/:name — HTTP polling endpoint (Receiver extension) =====
app.get('/api/poll/:name', (req, res) => {
  const target = req.params.name;
  const jobs = db.prepare(
    `SELECT * FROM jobs WHERE target=? AND status='pending' ORDER BY createdAt LIMIT 10`
  ).all(target);

  if (jobs.length > 0) {
    const now = Date.now();
    db.prepare(
      `UPDATE jobs SET status='assigned', assignedAt=? WHERE id IN (${jobs.map(() => '?').join(',')})`
    ).run(now, ...jobs.map(j => j.id));
  }

  res.json({ success: true, items: jobs.map(j => ({
    id:       j.id,
    accountNo:j.accountNo,
    bankName: j.bankName,
    sentBy:   j.sentBy
  }))});
});

// ===== GET /api/bank-rules =====
app.get('/api/bank-rules', (_req, res) => {
  const rows = db.prepare('SELECT * FROM bank_configs ORDER BY id').all();
  res.json(rows.map(r => ({ id: r.id, name: r.name, digits: JSON.parse(r.digits), keywords: JSON.parse(r.keywords) })));
});

// ===== POST /api/bank-rules =====
app.post('/api/bank-rules', (req, res) => {
  const { name, digits, keywords } = req.body;
  if (!name || !digits || !keywords) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const r = db.prepare('INSERT INTO bank_configs (name, digits, keywords) VALUES (?,?,?)').run(
    name, JSON.stringify(digits), JSON.stringify(keywords)
  );
  res.json({ success: true, id: r.lastInsertRowid });
});

// ===== PUT /api/bank-rules/:id =====
app.put('/api/bank-rules/:id', (req, res) => {
  const { name, digits, keywords } = req.body;
  db.prepare('UPDATE bank_configs SET name=?, digits=?, keywords=? WHERE id=?').run(
    name, JSON.stringify(digits), JSON.stringify(keywords), parseInt(req.params.id)
  );
  res.json({ success: true });
});

// ===== DELETE /api/bank-rules/:id =====
app.delete('/api/bank-rules/:id', (req, res) => {
  db.prepare('DELETE FROM bank_configs WHERE id=?').run(parseInt(req.params.id));
  res.json({ success: true });
});

// ===== GET /api/status =====
app.get('/api/status', (_req, res) => {
  const users = db.prepare(`SELECT COUNT(DISTINCT sentBy) as count FROM jobs`).get();
  res.json({ success: true, online: sseClients.size, users: users.count });
});

// ===== GET /api/data — Dashboard =====
app.get('/api/data', (_req, res) => {
  const jobs   = db.prepare(`SELECT * FROM jobs ORDER BY id DESC`).all();
  const online = [...sseClients.keys()];
  res.json({ jobs, online });
});

// ===== DELETE /api/jobs — ล้างข้อมูลทั้งหมด =====
app.delete('/api/jobs', (_req, res) => {
  db.prepare(`DELETE FROM jobs`).run();
  res.json({ success: true });
});

// ===== Periodic: reset stuck assigned jobs (60s timeout) =====
setInterval(() => {
  const timeout = Date.now() - 60000;
  const result  = db.prepare(
    `UPDATE jobs SET status = 'pending', assignedAt = 0
     WHERE status = 'assigned' AND assignedAt > 0 AND assignedAt < ?`
  ).run(timeout);

  if (result.changes > 0) {
    console.log(`⚠️ Reset ${result.changes} stuck jobs → pending`);
    // Re-push ไปหา receiver ที่ online
    const pending = db.prepare(
      `SELECT DISTINCT target FROM jobs WHERE status = 'pending'`
    ).all();
    pending.forEach(({ target }) => {
      const jobs = db.prepare(
        `SELECT * FROM jobs WHERE target = ? AND status = 'pending' ORDER BY id ASC`
      ).all(target);
      jobs.forEach(job => pushSSE(target, { type: 'job', job }));
    });
  }
}, 15000);

// ===== GET /config — Bank Rules Config Page =====
app.get('/config', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Bank Rules Config</title>
  <style>
    :root {
      --bg:#0b0b0c; --surface:#161617; --surface2:#1e1e20;
      --border:#2a2a2f; --border2:#3a3a40;
      --text:#ededed; --text2:#888;
      --purple:#7c3aed; --purple-h:#6d28d9; --purple-light:#a78bfa; --purple-dim:rgba(124,58,237,.12);
      --green:#22c55e; --red:#ef4444; --red-dim:rgba(239,68,68,.1);
    }
    *{margin:0;padding:0;box-sizing:border-box;}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--bg);color:var(--text);font-size:14px;min-height:100vh;}
    header{background:var(--surface);border-bottom:1px solid var(--border);padding:14px 28px;display:flex;align-items:center;gap:12px;}
    .logo{width:30px;height:30px;border-radius:7px;background:linear-gradient(135deg,#7c3aed,#a855f7);display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
    header h1{font-size:16px;font-weight:600;}
    header nav{margin-left:auto;display:flex;gap:6px;}
    header a{color:var(--text2);font-size:12px;text-decoration:none;padding:5px 12px;border-radius:6px;border:1px solid var(--border);transition:.15s;}
    header a:hover{background:var(--surface2);color:var(--text);}
    .container{max-width:860px;margin:0 auto;padding:28px 20px;}
    .section-title{font-size:13px;font-weight:600;color:var(--text2);text-transform:uppercase;letter-spacing:.05em;margin-bottom:12px;}
    .card{background:var(--surface);border:1px solid var(--border);border-radius:12px;overflow:hidden;margin-bottom:24px;}
    .card-header{padding:14px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;}
    .card-header-left h2{font-size:14px;font-weight:600;}
    .card-header-left p{font-size:12px;color:var(--text2);margin-top:2px;}
    table{width:100%;border-collapse:collapse;}
    th{padding:9px 16px;text-align:left;font-size:11px;font-weight:500;color:var(--text2);border-bottom:1px solid var(--border);background:var(--surface2);letter-spacing:.04em;}
    td{padding:11px 16px;border-bottom:1px solid var(--border);font-size:13px;vertical-align:middle;}
    tr:last-child td{border-bottom:none;}
    tbody tr:hover td{background:rgba(255,255,255,.02);}
    .badge{display:inline-block;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:500;background:var(--purple-dim);color:var(--purple-light);border:1px solid rgba(124,58,237,.25);margin-right:4px;}
    .kw{display:inline-block;padding:2px 7px;border-radius:4px;font-size:11px;background:var(--surface2);border:1px solid var(--border);color:var(--text2);margin:2px 2px 2px 0;}
    .actions{display:flex;gap:6px;}
    .btn{padding:6px 14px;border:none;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;transition:.15s;font-family:inherit;}
    .btn-sm{padding:4px 10px;font-size:11px;border-radius:5px;}
    .btn-primary{background:var(--purple);color:#fff;}
    .btn-primary:hover{background:var(--purple-h);}
    .btn-ghost{background:transparent;color:var(--text2);border:1px solid var(--border);}
    .btn-ghost:hover{background:var(--surface2);color:var(--text);}
    .btn-danger{background:var(--red-dim);color:var(--red);border:1px solid rgba(239,68,68,.2);}
    .btn-danger:hover{background:rgba(239,68,68,.2);}
    .form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:18px;}
    .form-group{display:flex;flex-direction:column;gap:5px;}
    .form-group.full{grid-column:1/-1;}
    label{font-size:11px;color:var(--text2);font-weight:500;letter-spacing:.03em;}
    input,textarea{background:var(--surface2);border:1px solid var(--border);border-radius:7px;padding:8px 11px;color:var(--text);font-size:13px;outline:none;font-family:inherit;transition:border-color .15s;resize:vertical;}
    input:focus,textarea:focus{border-color:var(--purple);box-shadow:0 0 0 3px var(--purple-dim);}
    input::placeholder,textarea::placeholder{color:var(--text2);}
    .form-hint{font-size:11px;color:var(--text2);margin-top:3px;}
    .form-footer{padding:12px 18px;border-top:1px solid var(--border);display:flex;gap:8px;justify-content:flex-end;}
    .empty{padding:40px;text-align:center;color:var(--text2);font-size:13px;}
    #toast{position:fixed;bottom:24px;right:24px;padding:10px 18px;border-radius:8px;font-size:13px;font-weight:500;box-shadow:0 8px 28px rgba(0,0,0,.5);display:none;z-index:999;animation:slidein .2s ease;}
    #toast.ok{background:rgba(34,197,94,.12);border:1px solid rgba(34,197,94,.3);color:#4ade80;display:block;}
    #toast.err{background:var(--red-dim);border:1px solid rgba(239,68,68,.3);color:#f87171;display:block;}
    @keyframes slidein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    .modal-bd{position:fixed;inset:0;background:rgba(0,0,0,.65);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:200;}
    .modal-bd.open{display:flex;}
    .modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:460px;max-width:95vw;}
    .modal-hd{padding:15px 18px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;}
    .modal-hd h3{font-size:14px;font-weight:600;}
    .modal-x{background:none;border:none;color:var(--text2);font-size:20px;cursor:pointer;padding:0 4px;border-radius:4px;line-height:1;}
    .modal-x:hover{background:var(--surface2);color:var(--text);}
  </style>
</head>
<body>
<header>
  <div class="logo">🏦</div>
  <h1>Bank Rules Config</h1>
  <nav>
    <a href="/">📊 Dashboard</a>
  </nav>
</header>
<div class="container">
  <div class="card">
    <div class="card-header">
      <div class="card-header-left">
        <h2>กฎการจับธนาคาร</h2>
        <p>ตั้งค่าชื่อ, จำนวนหลัก, คีย์เวิร์ด สำหรับแต่ละธนาคาร</p>
      </div>
    </div>
    <table>
      <thead>
        <tr><th>ชื่อธนาคาร</th><th>จำนวนหลัก</th><th>คีย์เวิร์ด</th><th style="width:110px;text-align:right">จัดการ</th></tr>
      </thead>
      <tbody id="rulesBody"><tr><td colspan="4" class="empty">⏳ กำลังโหลด...</td></tr></tbody>
    </table>
  </div>

  <div class="card">
    <div class="card-header">
      <div class="card-header-left">
        <h2>เพิ่มธนาคารใหม่</h2>
        <p>เพิ่มกฎสำหรับธนาคารที่ยังไม่มีในรายการ</p>
      </div>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label>ชื่อธนาคาร</label>
        <input id="aName" placeholder="เช่น กสิกรไทย">
      </div>
      <div class="form-group">
        <label>จำนวนหลัก (คั่นด้วย ,)</label>
        <input id="aDigits" placeholder="เช่น 10 หรือ 12,15">
        <span class="form-hint">หลายค่าคั่นด้วยเครื่องหมาย ,</span>
      </div>
      <div class="form-group full">
        <label>คีย์เวิร์ด (คั่นด้วย ,)</label>
        <input id="aKeywords" placeholder="เช่น kbank,kasikorn,กสิกร">
        <span class="form-hint">ตัวพิมพ์เล็ก, คั่นด้วย ,</span>
      </div>
    </div>
    <div class="form-footer">
      <button class="btn btn-primary" onclick="addRule()">➕ เพิ่มธนาคาร</button>
    </div>
  </div>
</div>

<!-- Edit Modal -->
<div class="modal-bd" id="editModal">
  <div class="modal">
    <div class="modal-hd">
      <h3>แก้ไขข้อมูลธนาคาร</h3>
      <button class="modal-x" onclick="closeModal()">✕</button>
    </div>
    <div class="form-grid">
      <input type="hidden" id="eId">
      <div class="form-group">
        <label>ชื่อธนาคาร</label>
        <input id="eName" placeholder="ชื่อธนาคาร">
      </div>
      <div class="form-group">
        <label>จำนวนหลัก (คั่นด้วย ,)</label>
        <input id="eDigits" placeholder="เช่น 10 หรือ 12,15">
      </div>
      <div class="form-group full">
        <label>คีย์เวิร์ด (คั่นด้วย ,)</label>
        <input id="eKeywords" placeholder="เช่น kbank,kasikorn">
      </div>
    </div>
    <div class="form-footer">
      <button class="btn btn-ghost" onclick="closeModal()">ยกเลิก</button>
      <button class="btn btn-primary" onclick="saveEdit()">💾 บันทึก</button>
    </div>
  </div>
</div>
<div id="toast"></div>

<script>
  async function load() {
    const rows = await (await fetch('/api/bank-rules')).json();
    const tbody = document.getElementById('rulesBody');
    if (!rows.length) { tbody.innerHTML='<tr><td colspan="4" class="empty">ยังไม่มีข้อมูล</td></tr>'; return; }
    tbody.innerHTML = rows.map(r => \`<tr>
      <td><strong>\${r.name}</strong></td>
      <td>\${r.digits.map(d=>\`<span class="badge">\${d} หลัก</span>\`).join('')}</td>
      <td>\${r.keywords.map(k=>\`<span class="kw">\${k}</span>\`).join('')}</td>
      <td style="text-align:right">
        <div class="actions" style="justify-content:flex-end">
          <button class="btn btn-ghost btn-sm" onclick='openEdit(\${JSON.stringify(r)})'>✏️ แก้ไข</button>
          <button class="btn btn-danger btn-sm" onclick="del(\${r.id})">🗑</button>
        </div>
      </td>
    </tr>\`).join('');
  }

  async function addRule() {
    const name     = document.getElementById('aName').value.trim();
    const digitsRaw= document.getElementById('aDigits').value.trim();
    const kwRaw    = document.getElementById('aKeywords').value.trim();
    if (!name || !digitsRaw || !kwRaw) { toast('กรุณากรอกข้อมูลให้ครบ','err'); return; }
    const digits   = digitsRaw.split(',').map(v => parseInt(v.trim())).filter(n => !isNaN(n));
    const keywords = kwRaw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    const res = await fetch('/api/bank-rules', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, digits, keywords })
    });
    if ((await res.json()).success) {
      document.getElementById('aName').value = '';
      document.getElementById('aDigits').value = '';
      document.getElementById('aKeywords').value = '';
      toast('✅ เพิ่มแล้ว!','ok');
      load();
    }
  }

  async function del(id) {
    if (!confirm('ลบธนาคารนี้?')) return;
    await fetch('/api/bank-rules/' + id, { method:'DELETE' });
    toast('🗑 ลบแล้ว','ok');
    load();
  }

  function openEdit(r) {
    document.getElementById('eId').value       = r.id;
    document.getElementById('eName').value     = r.name;
    document.getElementById('eDigits').value   = r.digits.join(',');
    document.getElementById('eKeywords').value = r.keywords.join(',');
    document.getElementById('editModal').classList.add('open');
  }
  function closeModal() { document.getElementById('editModal').classList.remove('open'); }

  async function saveEdit() {
    const id       = document.getElementById('eId').value;
    const name     = document.getElementById('eName').value.trim();
    const digits   = document.getElementById('eDigits').value.split(',').map(v=>parseInt(v.trim())).filter(n=>!isNaN(n));
    const keywords = document.getElementById('eKeywords').value.split(',').map(k=>k.trim().toLowerCase()).filter(Boolean);
    await fetch('/api/bank-rules/' + id, {
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ name, digits, keywords })
    });
    closeModal();
    toast('✅ บันทึกแล้ว!','ok');
    load();
  }

  let toastTimer;
  function toast(msg, type) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = type;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.className = ''; el.style.display = 'none'; }, 3000);
  }

  document.getElementById('editModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  load();
</script>
</body>
</html>`);
});

// ===== GET / — Dashboard =====
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Bank Relay Dashboard</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; font-size:13px; background:#f5f5f5; color:#333; }
    header { background:#1890ff; color:#fff; padding:16px 24px; display:flex; align-items:center; gap:12px; }
    header h1 { font-size:18px; font-weight:700; }
    .stats { display:flex; gap:16px; margin-left:auto; font-size:13px; flex-wrap:wrap; }
    .stat { background:rgba(255,255,255,0.2); padding:4px 12px; border-radius:20px; }
    .container { padding:20px 24px; }
    .online-bar { background:#fff; border-radius:8px; padding:10px 16px; margin-bottom:16px; box-shadow:0 1px 4px rgba(0,0,0,0.08); font-size:12px; }
    .online-bar span { display:inline-block; background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; padding:2px 8px; border-radius:10px; margin:2px 4px; }
    table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,0.08); }
    thead { background:#fafafa; }
    th { padding:12px 14px; text-align:left; font-weight:600; color:#555; border-bottom:1px solid #f0f0f0; }
    td { padding:10px 14px; border-bottom:1px solid #f9f9f9; }
    tr:last-child td { border-bottom:none; }
    tr:hover td { background:#f0f7ff; }
    .tag { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; }
    .tag-sender  { background:#e6f7ff; color:#1890ff; border:1px solid #91d5ff; }
    .tag-target  { background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; }
    .tag-pending    { background:#fff7e6; color:#fa8c16; border:1px solid #ffd591; }
    .tag-assigned   { background:#e6f7ff; color:#1890ff; border:1px solid #91d5ff; }
    .tag-processing { background:#f9f0ff; color:#722ed1; border:1px solid #d3adf7; }
    .tag-done    { background:#f6ffed; color:#52c41a; border:1px solid #b7eb8f; }
    .tag-error   { background:#fff2f0; color:#ff4d4f; border:1px solid #ffa39e; }
    .acct { font-family:monospace; font-size:13px; }
    .empty { padding:48px; text-align:center; color:#aaa; font-size:15px; }
    .dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#52c41a; margin-right:6px; animation:pulse 1.5s infinite; }
    @keyframes pulse { 0%,100%{opacity:1}50%{opacity:0.4} }
  </style>
</head>
<body>
  <header>
    <h1>📤 Bank Relay Dashboard</h1>
    <div class="stats">
      <div class="stat"><span class="dot"></span>Live</div>
      <div class="stat" id="statOnline">0 online</div>
      <div class="stat" id="statJobs">0 jobs</div>
      <div class="stat" id="statPending">0 pending</div>
    </div>
  </header>
  <div class="container">
    <div class="online-bar" id="onlineBar">ออนไลน์: <em>ไม่มี</em></div>
    <div style="text-align:right;margin-bottom:10px">
      <button onclick="clearAll()" style="background:#ff4d4f;color:#fff;border:none;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:13px;font-weight:600">🗑 ล้างข้อมูล</button>
    </div>
    <table>
      <thead>
        <tr><th>#</th><th>เวลา</th><th>ผู้ส่ง</th><th>ผู้รับ</th><th>เลขบัญชี</th><th>ธนาคาร</th><th>ชื่อผู้รับเงิน</th><th>สถานะ</th></tr>
      </thead>
      <tbody id="tbody"><tr><td colspan="8" class="empty">⏳ รอข้อมูล...</td></tr></tbody>
    </table>
  </div>
  <script>
    const STATUS_TAG = {
      pending:    '<span class="tag tag-pending">⏳ Pending</span>',
      assigned:   '<span class="tag tag-assigned">📥 Assigned</span>',
      processing: '<span class="tag tag-processing">⚙️ Processing</span>',
      done:       '<span class="tag tag-done">✅ Done</span>',
      error:      (msg) => \`<span class="tag tag-error">❌ \${msg||'Error'}</span>\`
    };
    async function refresh() {
      try {
        const d = await (await fetch('/api/data')).json();
        document.getElementById('statOnline').textContent  = d.online.length + ' online';
        document.getElementById('statJobs').textContent    = d.jobs.length   + ' jobs';
        document.getElementById('statPending').textContent = d.jobs.filter(j=>j.status==='pending').length + ' pending';
        document.getElementById('onlineBar').innerHTML = 'ออนไลน์: ' +
          (d.online.length ? d.online.map(n=>\`<span>🟢 \${n}</span>\`).join('') : '<em>ไม่มี</em>');
        const tbody = document.getElementById('tbody');
        if (!d.jobs.length) { tbody.innerHTML='<tr><td colspan="8" class="empty">⏳ รอข้อมูล...</td></tr>'; return; }
        tbody.innerHTML = d.jobs.map((j,i) => \`<tr>
          <td>\${d.jobs.length-i}</td>
          <td>\${new Date(j.createdAt).toLocaleString('th-TH',{timeZone:'Asia/Bangkok'})}</td>
          <td><span class="tag tag-sender">\${j.sentBy}</span></td>
          <td><span class="tag tag-target">\${j.target}</span></td>
          <td class="acct">\${j.accountNo}</td>
          <td>\${j.bankName}</td>
          <td>\${j.recipientName||'-'}</td>
          <td>\${j.status==='error'?STATUS_TAG.error(j.errorMessage):STATUS_TAG[j.status]||j.status}</td>
        </tr>\`).join('');
      } catch(e) {}
    }
    async function clearAll() {
      if (!confirm('ล้างข้อมูลทั้งหมด?')) return;
      await fetch('/api/jobs', { method: 'DELETE' });
      refresh();
    }
    refresh();
    setInterval(refresh, 3000);
  </script>
</body>
</html>`);
});

// ===== Start =====
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n✅ Bank Relay Server พร้อมใช้งาน`);
  console.log(`   Server   : http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/\n`);
});
