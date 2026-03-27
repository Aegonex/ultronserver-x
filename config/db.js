const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '..', 'data.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -32000');
db.pragma('temp_store = MEMORY');
db.pragma('mmap_size = 134217728');

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

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_jobs_target_status ON jobs(target, status);
  CREATE INDEX IF NOT EXISTS idx_jobs_status_assigned ON jobs(status, assignedAt);
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS bank_configs (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    digits   TEXT NOT NULL,
    keywords TEXT NOT NULL
  )
`);

if (db.prepare('SELECT COUNT(*) as n FROM bank_configs').get().n === 0) {
  const ins = db.prepare('INSERT INTO bank_configs (name, digits, keywords) VALUES (?,?,?)');
  [
    ['กสิกรไทย',              '[10]',    '["kbank","k bank","kasikorn","กสิกร"]'],
    ['กรุงเทพ',                '[10]',    '["bbl","bangkok bank","กรุงเทพ"]'],
    ['กรุงไทย',                '[10]',    '["ktb","krungthai","กรุงไทย","กรุงไท"]'],
    ['ทหารไทยธนชาต',          '[10]',    '["ttb","ทหารไทย","ธนชาต","tmb"]'],
    ['ไทยพาณิชย์',            '[10]',    '["scb","siam commercial","พาณิชย์"]'],
    ['กรุงศรีอยุธยา',         '[10]',    '["bay","krungsri","กรุงศรี","อยุธยา"]'],
    ['มิซูโฮ',                 '[11]',    '["mizuho","มิซูโฮ"]'],
    ['ออมสิน',                 '[12]',    '["gsb","government savings","ออมสิน"]'],
    ['ฮ่องกงและเซี่ยงไฮ้',    '[12]',    '["hsbc","ฮ่องกง","เซี่ยงไฮ้","hongkong"]'],
    ['ธ.ก.ส.',                 '[12]',    '["baac","ธกส","เกษตร"]'],
    ['อาคารสงเคราะห์',        '[12]',    '["ghb","อาคารสงเคราะห์","government housing"]'],
    ['เกียรตินาคินภัทร',      '[10,14]', '["kkp","kiatnakin","เกียรตินาคิน"]'],
    ['ทิสโก้',                 '[14]',    '["tisco","ทิสโก้"]'],
  ].forEach(d => ins.run(...d));
  console.log('✅ Seeded default bank configs');
}

module.exports = db;
