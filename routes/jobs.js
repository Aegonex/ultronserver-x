const router = require('express').Router();
const db     = require('../config/db');
const { pushSSE } = require('../utils/sse');

// POST /api/jobs — Sender สร้าง job
router.post('/', (req, res) => {
  const { accountNo, bankName, sentBy, target } = req.body;
  if (!accountNo || !bankName || !sentBy || !target)
    return res.status(400).json({ success: false, error: 'ข้อมูลไม่ครบ' });

  const id = Date.now();
  db.prepare(
    `INSERT INTO jobs (id, accountNo, bankName, sentBy, target, createdAt) VALUES (?,?,?,?,?,?)`
  ).run(id, accountNo, bankName, sentBy, target, id);

  db.prepare(
    `DELETE FROM jobs WHERE id NOT IN (SELECT id FROM jobs ORDER BY id DESC LIMIT 500)`
  ).run();

  const pushed = pushSSE(target, {
    type: 'job',
    job: { id, accountNo, bankName, sentBy, target, status: 'pending', createdAt: id }
  });

  console.log(`📨 [${sentBy}→${target}] ${bankName} ${accountNo} ${pushed ? '⚡SSE' : '⏳queue'}`);
  res.json({ success: true, id });
});

// GET /api/jobs/:id — Sender poll ผล (fallback)
router.get('/:id', (req, res) => {
  const job = db.prepare(
    `SELECT id, status, recipientName, errorMessage FROM jobs WHERE id = ?`
  ).get(parseInt(req.params.id));

  if (!job) return res.json({ success: false });
  if (job.status === 'done' || job.status === 'error')
    db.prepare(`UPDATE jobs SET resultRead = 1 WHERE id = ?`).run(job.id);
  res.json({ success: true, job });
});

// POST /api/jobs/:id/ack — Receiver ยืนยันรับ job
router.post('/:id/ack', (req, res) => {
  db.prepare(
    `UPDATE jobs SET status = 'assigned', assignedAt = ? WHERE id = ? AND status = 'pending'`
  ).run(Date.now(), parseInt(req.params.id));
  res.json({ success: true });
});

// POST /api/jobs/:id/done — Receiver ส่งผลกลับ
router.post('/:id/done', (req, res) => {
  const id = parseInt(req.params.id);
  const { status, recipientName, errorMessage } = req.body;

  const job = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id);
  if (!job) return res.status(404).json({ success: false, error: 'ไม่พบ job' });

  db.prepare(
    `UPDATE jobs SET status = ?, recipientName = ?, errorMessage = ?, doneAt = ? WHERE id = ?`
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

// DELETE /api/jobs — ล้างข้อมูลทั้งหมด
router.delete('/', (_req, res) => {
  db.prepare(`DELETE FROM jobs`).run();
  res.json({ success: true });
});

module.exports = router;
