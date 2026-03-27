const db = require('../config/db');
const { pushSSE } = require('../utils/sse');

function startPeriodic() {
  setInterval(() => {
    const timeout = Date.now() - 60000;
    const result  = db.prepare(
      `UPDATE jobs SET status = 'pending', assignedAt = 0
       WHERE status = 'assigned' AND assignedAt > 0 AND assignedAt < ?`
    ).run(timeout);

    if (result.changes > 0) {
      console.log(`⚠️ Reset ${result.changes} stuck jobs → pending`);
      db.prepare(`SELECT DISTINCT target FROM jobs WHERE status = 'pending'`).all()
        .forEach(({ target }) => {
          db.prepare(`SELECT * FROM jobs WHERE target = ? AND status = 'pending' ORDER BY id ASC`).all(target)
            .forEach(job => pushSSE(target, { type: 'job', job }));
        });
    }
  }, 15000);

  setInterval(() => {
    const oneDayAgo = Date.now() - 86400000;
    const result = db.prepare(
      `DELETE FROM jobs WHERE createdAt < ? AND status IN ('done', 'error')`
    ).run(oneDayAgo);
    if (result.changes > 0) console.log(`🗑️ Auto-deleted ${result.changes} old jobs`);
  }, 3600000);
}

module.exports = { startPeriodic };
