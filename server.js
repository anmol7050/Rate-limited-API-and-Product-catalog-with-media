'use strict';

const http = require('http');
const { productRouter } = require('./routes/products');
const { sendError } = require('./utils/http');

const PORT = process.env.PORT || 3001;

const server = http.createServer(async (req, res) => {
  // CORS headers (development convenience)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Parse pathname (strip query string)
  const pathname = req.url.split('?')[0] || '/';

  // Health check
  if (pathname === '/health') {
    const { sendJson } = require('./utils/http');
    return sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
  }

  // All product routes
  if (pathname.startsWith('/products')) {
    try {
      return await productRouter(req, res, pathname);
    } catch (err) {
      console.error('[Unhandled error]', err);
      return sendError(res, 500, 'Internal server error');
    }
  }

  return sendError(res, 404, 'Route not found');
});

server.listen(PORT, () => {
  console.log(`\n  Product Catalog API`);
  console.log(`  ───────────────────`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Health:       GET  /health`);
  console.log(`  Create:       POST /products`);
  console.log(`  List:         GET  /products?limit=20&offset=0`);
  console.log(`  Detail:       GET  /products/:id`);
  console.log(`  Add media:    POST /products/:id/media\n`);
});

module.exports = server; // exported for testing
