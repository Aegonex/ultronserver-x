require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const path    = require('path');

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Static React build
app.use(express.static(path.join(__dirname, 'dist')));

// API routes
app.use('/api/stream',     require('./routes/stream'));
app.use('/api/jobs',       require('./routes/jobs'));
app.use('/api/poll',       require('./routes/poll'));
app.use('/api/bank-rules', require('./routes/bankRules'));
app.use('/api',            require('./routes/status'));

// Serve React app for all non-API routes
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

require('./middleware/periodic').startPeriodic();

const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`\n✅ Bank Relay Server พร้อมใช้งาน`);
  console.log(`   Server   : http://localhost:${PORT}`);
  console.log(`   Dashboard: http://localhost:${PORT}/`);
  console.log(`   Config   : http://localhost:${PORT}/config\n`);
});
