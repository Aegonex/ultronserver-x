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

module.exports = { sseClients, pushSSE };
