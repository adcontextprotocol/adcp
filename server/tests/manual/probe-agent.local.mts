import express from 'express';
import http from 'node:http';
const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
const srv = http.createServer(app);
srv.listen(45998, '127.0.0.1', async () => {
  const res = await fetch('http://127.0.0.1:45998/api/training-agent/sales/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '0' } } }),
  });
  console.log('STATUS', res.status);
  const text = await res.text();
  console.log('BODY', text.slice(0, 500));
  process.exit(0);
});
