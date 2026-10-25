'use strict';

const path = require('node:path');

const { createApp } = require('./lib/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const DATA_FILE = process.env.DATA_FILE
  ? path.resolve(process.env.DATA_FILE)
  : path.join(__dirname, 'data', 'requests.json');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`Invalid PORT "${process.env.PORT}". Use a number between 1 and 65535.`);
  process.exit(1);
}

let app;
try {
  app = createApp({ dataFile: DATA_FILE });
} catch (err) {
  console.error('Could not start:', err.message);
  process.exit(1);
}

app.server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `Port ${PORT} is already in use. Stop the other process or run with a different port, e.g. ` +
        `PowerShell: $env:PORT=3001; npm start`
    );
  } else {
    console.error('Server error:', err.message);
  }
  process.exit(1);
});

app.server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  BIFM shopping requests - local only');
  console.log(`  Dashboard:  http://${HOST}:${PORT}`);
  console.log(`  Data file:  ${app.dataFile}`);
  console.log('');
  console.log('  Bound to loopback only. Do not expose this server to the internet.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    app.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
