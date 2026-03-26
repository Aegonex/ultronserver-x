const router = require('express').Router();
const db     = require('../config/db');

const parse = r => ({ id: r.id, name: r.name, digits: JSON.parse(r.digits), keywords: JSON.parse(r.keywords) });

// GET /api/bank-rules
router.get('/', (_req, res) => {
  res.json(db.prepare('SELECT * FROM bank_configs ORDER BY id').all().map(parse));
});

// POST /api/bank-rules
router.post('/', (req, res) => {
  const { name, digits, keywords } = req.body;
  if (!name || !digits || !keywords) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const r = db.prepare('INSERT INTO bank_configs (name, digits, keywords) VALUES (?,?,?)').run(
    name, JSON.stringify(digits), JSON.stringify(keywords)
  );
  res.json({ success: true, id: r.lastInsertRowid });
});

// PUT /api/bank-rules/:id
router.put('/:id', (req, res) => {
  const { name, digits, keywords } = req.body;
  db.prepare('UPDATE bank_configs SET name=?, digits=?, keywords=? WHERE id=?').run(
    name, JSON.stringify(digits), JSON.stringify(keywords), parseInt(req.params.id)
  );
  res.json({ success: true });
});

// DELETE /api/bank-rules/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM bank_configs WHERE id=?').run(parseInt(req.params.id));
  res.json({ success: true });
});

module.exports = router;
