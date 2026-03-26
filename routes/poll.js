const router = require('express').Router();
const db     = require('../config/db');

// GET /api/poll/:name — HTTP polling (Receiver extension keepalive)
router.get('/:name', (req, res) => {
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
    id:        j.id,
    accountNo: j.accountNo,
    bankName:  j.bankName,
    sentBy:    j.sentBy
  }))});
});

module.exports = router;
