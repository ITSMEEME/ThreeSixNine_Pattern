const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const PORT = 3000;
const PUBLIC_DIR = __dirname;

const activeJobs = new Map();

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (req.method === 'POST' && pathname === '/api/optimize') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });

    req.on('end', () => {
      let data;
      try {
        data = JSON.parse(body);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
        return;
      }

      const { candles, startBalanceSats, qtyUsd, feeRate, spread, symbol } = data;
      if (!candles || !Array.isArray(candles) || candles.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Candles array is required' }));
        return;
      }

      // Generate temp filenames and jobId
      const jobId = Date.now() + '_' + Math.floor(Math.random() * 1000);
      const csvPath = path.join(PUBLIC_DIR, `temp_candles_${jobId}.csv`);
      const jsonPath = path.join(PUBLIC_DIR, `temp_results_${jobId}.json`);

      try {
        // Write CSV
        let csvContent = 'time,open,high,low,close,volume\n';
        for (let i = 0; i < candles.length; i++) {
          const c = candles[i];
          csvContent += `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume || 0}\n`;
        }
        fs.writeFileSync(csvPath, csvContent);

        // Run C optimizer using spawn to capture real-time progress
        const args = [
          csvPath,
          jsonPath,
          (startBalanceSats || 1000000.0).toString(),
          (qtyUsd || 25.0).toString(),
          (feeRate || 0.001).toString(),
          (spread || 0.0005).toString(),
          (symbol || 'BTC').toString()
        ];

        const optimizerBinary = path.join(PUBLIC_DIR, 'optimizer');
        const child = spawn(optimizerBinary, args);

        let stdoutBuffer = '';
        child.stdout.on('data', (chunk) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';
          for (const line of lines) {
            if (line.includes('PROGRESS:')) {
              const match = line.match(/PROGRESS:\s*([\d.]+)%/);
              if (match) {
                const percent = parseFloat(match[1]);
                const job = activeJobs.get(jobId);
                if (job) {
                  job.progress = percent;
                }
              }
            }
          }
        });

        let stderrBuffer = '';
        child.stderr.on('data', (chunk) => {
          stderrBuffer += chunk.toString();
        });

        child.on('close', (code) => {
          const job = activeJobs.get(jobId);
          if (!job) return;

          if (code === 0) {
            try {
              const results = fs.readFileSync(jsonPath, 'utf8');
              job.results = JSON.parse(results);
              job.status = 'done';
            } catch (readErr) {
              console.error('Error reading optimizer output:', readErr);
              job.status = 'failed';
              job.error = 'Failed to read optimizer output';
            }
          } else {
            if (job.status !== 'stopped') {
              job.status = 'failed';
              job.error = stderrBuffer.trim() || `Optimizer exited with code ${code}`;
            }
          }

          // Cleanup temp files
          try { if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch(e) {}
          try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch(e) {}
        });

        activeJobs.set(jobId, {
          status: 'running',
          progress: 0,
          startTime: Date.now(),
          csvPath,
          jsonPath,
          process: child,
          error: null,
          results: null
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId }));

      } catch (err) {
        console.error('API Error:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
        try { if (fs.existsSync(csvPath)) fs.unlinkSync(csvPath); } catch(e) {}
        try { if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath); } catch(e) {}
      }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/optimize/status') {
    const jobId = parsedUrl.searchParams.get('jobId');
    const job = activeJobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    const elapsed = Math.round((Date.now() - job.startTime) / 1000);
    let eta = null;
    if (job.progress >= 0.5) {
      const totalEstTime = (elapsed / job.progress) * 100;
      eta = Math.max(0, Math.round(totalEstTime - elapsed));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: job.status,
      progress: job.progress,
      elapsed,
      eta,
      error: job.error,
      results: job.results
    }));

    if (job.status === 'done' || job.status === 'failed' || job.status === 'stopped') {
      setTimeout(() => {
        activeJobs.delete(jobId);
      }, 30000); // Clean up after 30 seconds
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/optimize/stop') {
    const jobId = parsedUrl.searchParams.get('jobId');
    const job = activeJobs.get(jobId);
    if (!job) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Job not found' }));
      return;
    }

    if (job.status === 'running') {
      job.status = 'stopped';
      try {
        job.process.kill('SIGTERM');
      } catch (e) {
        console.error('Failed to kill optimizer process:', e);
      }
      try { if (fs.existsSync(job.csvPath)) fs.unlinkSync(job.csvPath); } catch(e) {}
      try { if (fs.existsSync(job.jsonPath)) fs.unlinkSync(job.jsonPath); } catch(e) {}
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    activeJobs.delete(jobId);
    return;
  }

  // Handle static files
  let filePath = path.join(PUBLIC_DIR, pathname === '/' ? 'paper-perp.html' : pathname);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running at http://localhost:${PORT}`);
});
