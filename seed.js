#!/usr/bin/env node
/**
 * Seed Script — creates N products with M images each
 * Usage:
 *   node seed.js                  # 1000 products, 10 images each
 *   node seed.js 500 5            # 500 products, 5 images each
 *   PORT=3001 node seed.js        # target a different port
 *
 * Run this AFTER starting the server: node src/server.js
 * The script uses only Node's built-in http module.
 */

'use strict';

const http = require('http');

const PORT = process.env.PORT || 3001;
const TOTAL_PRODUCTS = parseInt(process.argv[2] ?? '1000', 10);
const IMAGES_PER_PRODUCT = parseInt(process.argv[3] ?? '10', 10);
const CONCURRENCY = 10; // simultaneous requests

function post(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { hostname: 'localhost', port: PORT, path, method: 'POST',
        headers: { 'Content-Type': 'application/json',
                   'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode, body: raw }); }
        });
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function seed() {
  console.log(`\nSeeding ${TOTAL_PRODUCTS} products × ${IMAGES_PER_PRODUCT} images …\n`);
  const start = Date.now();
  let created = 0;
  let failed = 0;

  // Work in batches of CONCURRENCY
  for (let i = 0; i < TOTAL_PRODUCTS; i += CONCURRENCY) {
    const batch = [];
    for (let j = i; j < Math.min(i + CONCURRENCY, TOTAL_PRODUCTS); j++) {
      const n = j + 1;
      const sku = `SKU-${String(n).padStart(6, '0')}`;
      const slug = sku.toLowerCase();
      const imageUrls = Array.from({ length: IMAGES_PER_PRODUCT }, (_, k) =>
        `https://cdn.example.com/products/${slug}/img-${k + 1}.jpg`
      );
      batch.push(
        post('/products', {
          name: `Product ${n}`,
          sku,
          image_urls: imageUrls,
          video_urls: [`https://cdn.example.com/products/${slug}/demo.mp4`],
        })
      );
    }
    const results = await Promise.all(batch);
    results.forEach((r) => {
      if (r.status === 201) created++;
      else failed++;
    });

    if ((i + CONCURRENCY) % 100 === 0 || i + CONCURRENCY >= TOTAL_PRODUCTS) {
      process.stdout.write(
        `  ${Math.min(i + CONCURRENCY, TOTAL_PRODUCTS)} / ${TOTAL_PRODUCTS}\r`
      );
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(2);
  console.log(`\n\n  Done in ${elapsed}s — created: ${created}  failed: ${failed}`);

  // Quick list performance check
  console.log('\n  Checking GET /products?limit=20 …');
  const t0 = Date.now();
  await new Promise((resolve) => {
    http.get(
      `http://localhost:${PORT}/products?limit=20`,
      (res) => { res.resume(); res.on('end', resolve); }
    );
  });
  console.log(`  List responded in ${Date.now() - t0} ms\n`);
}

seed().catch((err) => {
  console.error('Seed failed:', err.message);
  console.error('Is the server running?  node src/server.js');
  process.exit(1);
});
