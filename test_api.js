const http = require('http');

const mockCandles = [];
const now = Date.now();
for (let i = 0; i < 5; i++) {
  mockCandles.push({
    time: now - (5 - i) * 60000,
    open: 30000,
    high: 30010,
    low: 29990,
    close: 30005,
    volume: 1.5
  });
}

console.log(`Sending ${mockCandles.length} candles...`);

const payload = JSON.stringify({
  candles: mockCandles,
  startBalanceSats: 1000000,
  qtyUsd: 25,
  feeRate: 0.001,
  spread: 0.0005
});

const startTime = Date.now();

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/api/optimize',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log(`Finished in ${Date.now() - startTime}ms`);
    console.log('RESPONSE length:', data.length);
    console.log('RESPONSE head:', data.substring(0, 300));
  });
});

req.on('error', (e) => {
  console.error(`problem with request: ${e.message}`);
});

req.write(payload);
req.end();
