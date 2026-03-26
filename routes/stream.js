const router  = require('express').Router();
const db       = require('../config/db');
const { sseClients, pushSSE } = require('../utils/sse');

// GET /api/stream/:name
router.get('/:name', (req, res) => {
  const { name } = req.params;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch(e) {}
  }, 25000);

  sseClients.set(name, res);
  console.log(`📡 SSE connected: ${name} (${sseClients.size} online)`);

  const pending = db.prepare(
    `SELECT * FROM jobs WHERE target = ? AND status = 'pending' ORDER BY id ASC`
  ).all(name);
  pending.forEach(job => res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`));

  req.on('close', () => {
    clearInterval(ping);
    sseClients.delete(name);
    console.log(`📡 SSE disconnected: ${name} (${sseClients.size} online)`);
    db.prepare(
      `UPDATE jobs SET status = 'pending', assignedAt = 0 WHERE target = ? AND status = 'assigned'`
    ).run(name);
  });
});

module.exports = router;
