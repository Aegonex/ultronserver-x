const router = require('express').Router();
const db     = require('../config/db');
const { sseClients } = require('../utils/sse');

// GET /api/status
router.get('/status', (_req, res) => {
  const users = db.prepare(`SELECT COUNT(DISTINCT sentBy) as count FROM jobs`).get();
  res.json({ success: true, online: sseClients.size, users: users.count });
});

// GET /api/data — Dashboard data
router.get('/data', (_req, res) => {
  const jobs   = db.prepare(`SELECT * FROM jobs ORDER BY id DESC LIMIT 200`).all();
  const online = [...sseClients.keys()];
  res.json({ jobs, online });
});

module.exports = router;
