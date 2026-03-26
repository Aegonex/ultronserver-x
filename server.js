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
