#!/usr/bin/env node
/**
 * Integration test suite — no test framework required.
 * Starts the server in-process, runs all checks, reports results, then exits.
 *
 * Usage:
 *   node test.js
 */

'use strict';

// Silence server startup banner during tests
const original = console.log;
console.log = () => {};
const server = require('./src/server');
console.log = original;

const http = require('http');
const PORT = process.env.PORT || 3001;

// ─── Tiny test harness ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✓  ${label}`);
    passed++;
  } else {
    console.error(`  ✗  ${label}`);
    failed++;
  }
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);

    const req = http.request(
      { hostname: 'localhost', port: PORT, path, method, headers },
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
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

async function run() {
  // Give the server a moment to bind
  await new Promise((r) => setTimeout(r, 100));

  console.log('\n═══════════════════════════════════════');
  console.log('  Product Catalog API — Integration Tests');
  console.log('═══════════════════════════════════════\n');

  // ── Health ────────────────────────────────────────────────────────────────
  console.log('Health check');
  const health = await request('GET', '/health');
  assert(health.status === 200, 'GET /health → 200');
  assert(health.body.status === 'ok', 'body.status === "ok"');

  // ── POST /products — happy path ───────────────────────────────────────────
  console.log('\nPOST /products — create');
  const created = await request('POST', '/products', {
    name: 'Widget A',
    sku: 'SKU-001',
    image_urls: [
      'https://cdn.example.com/products/sku-001/img-1.jpg',
      'https://cdn.example.com/products/sku-001/img-2.jpg',
    ],
    video_urls: ['https://cdn.example.com/products/sku-001/demo.mp4'],
  });
  assert(created.status === 201, 'POST /products → 201');
  assert(typeof created.body.id === 'string', 'response has id');
  assert(created.body.sku === 'SKU-001', 'sku echoed back');
  assert(created.body.image_count === 2, 'image_count === 2');
  assert(created.body.video_count === 1, 'video_count === 1');
  assert(Array.isArray(created.body.image_urls), 'image_urls array present on create');
  assert(
    created.body.thumbnail_url === 'https://cdn.example.com/products/sku-001/img-1.jpg',
    'thumbnail_url = first image'
  );
  const productId = created.body.id;

  // ── POST /products — no media ──────────────────────────────────────────────
  const noMedia = await request('POST', '/products', { name: 'Widget B', sku: 'SKU-002' });
  assert(noMedia.status === 201, 'POST /products no media → 201');
  assert(noMedia.body.image_count === 0, 'image_count === 0 when no images');
  assert(noMedia.body.thumbnail_url === null, 'thumbnail_url === null when no images');

  // ── POST /products — duplicate SKU ────────────────────────────────────────
  console.log('\nPOST /products — duplicate SKU');
  const dup = await request('POST', '/products', { name: 'Another Widget', sku: 'SKU-001' });
  assert(dup.status === 409, 'Duplicate SKU → 409 Conflict');
  assert(dup.body.error?.message?.includes('SKU-001'), 'error message mentions the sku');

  // ── POST /products — validation failures ──────────────────────────────────
  console.log('\nPOST /products — validation');
  const missingName = await request('POST', '/products', { sku: 'SKU-999' });
  assert(missingName.status === 400, 'Missing name → 400');

  const emptySku = await request('POST', '/products', { name: 'X', sku: '   ' });
  assert(emptySku.status === 400, 'Whitespace-only sku → 400');

  const badUrl = await request('POST', '/products', {
    name: 'X', sku: 'SKU-BAD',
    image_urls: ['not-a-url'],
  });
  assert(badUrl.status === 400, 'Invalid URL → 400');

  const ftpUrl = await request('POST', '/products', {
    name: 'X', sku: 'SKU-FTP',
    image_urls: ['ftp://cdn.example.com/file.jpg'],
  });
  assert(ftpUrl.status === 400, 'ftp:// URL → 400');

  const tooManyUrls = await request('POST', '/products', {
    name: 'X', sku: 'SKU-MANY',
    image_urls: Array.from({ length: 21 }, (_, i) =>
      `https://cdn.example.com/img-${i}.jpg`
    ),
  });
  assert(tooManyUrls.status === 400, '>20 URLs → 400');

  const noBody = await request('POST', '/products');
  assert(noBody.status === 400, 'Empty body → 400');

  // ── GET /products — list ──────────────────────────────────────────────────
  console.log('\nGET /products — list');
  const list = await request('GET', '/products');
  assert(list.status === 200, 'GET /products → 200');
  assert(Array.isArray(list.body.data), 'data is array');
  assert(typeof list.body.pagination === 'object', 'pagination object present');
  assert(list.body.pagination.total >= 2, 'total ≥ 2');

  const firstItem = list.body.data[0];
  assert(!('image_urls' in firstItem), 'image_urls NOT in list items (perf rule)');
  assert(!('video_urls' in firstItem), 'video_urls NOT in list items (perf rule)');
  assert(typeof firstItem.image_count === 'number', 'image_count present in list');
  assert(typeof firstItem.video_count === 'number', 'video_count present in list');

  // ── GET /products — pagination ────────────────────────────────────────────
  console.log('\nGET /products — pagination');
  const page1 = await request('GET', '/products?limit=1&offset=0');
  assert(page1.status === 200, 'limit=1 → 200');
  assert(page1.body.data.length === 1, 'returns exactly 1 item');
  assert(page1.body.pagination.has_more === true, 'has_more true');

  const page2 = await request('GET', '/products?limit=1&offset=1');
  assert(page2.body.data[0].id !== page1.body.data[0].id, 'page 2 has different item');

  const badLimit = await request('GET', '/products?limit=9999');
  assert(
    badLimit.body.pagination.limit <= 100,
    'limit capped at 100'
  );

  // ── GET /products/:id — detail ────────────────────────────────────────────
  console.log('\nGET /products/:id — detail');
  const detail = await request('GET', `/products/${productId}`);
  assert(detail.status === 200, 'GET /products/:id → 200');
  assert(Array.isArray(detail.body.image_urls), 'image_urls array in detail');
  assert(detail.body.image_urls.length === 2, 'all image_urls returned');
  assert(Array.isArray(detail.body.video_urls), 'video_urls array in detail');

  const notFound = await request('GET', '/products/nonexistent-id-xyz');
  assert(notFound.status === 404, 'Unknown id → 404');

  // ── POST /products/:id/media ──────────────────────────────────────────────
  console.log('\nPOST /products/:id/media — add media');
  const addImg = await request('POST', `/products/${productId}/media`, {
    image_urls: ['https://cdn.example.com/products/sku-001/img-3.jpg'],
  });
  assert(addImg.status === 200, 'Add image → 200');
  assert(addImg.body.image_count === 3, 'image_count updated to 3 after append');
  assert(addImg.body.image_urls.length === 3, 'all 3 image_urls in response');

  const addVid = await request('POST', `/products/${productId}/media`, {
    video_urls: ['https://cdn.example.com/products/sku-001/demo-2.mp4'],
  });
  assert(addVid.status === 200, 'Add video → 200');
  assert(addVid.body.video_count === 2, 'video_count updated to 2');

  const emptyMedia = await request('POST', `/products/${productId}/media`, {});
  assert(emptyMedia.status === 400, 'Empty media body → 400');

  const mediaNotFound = await request('POST', '/products/no-such-id/media', {
    image_urls: ['https://cdn.example.com/x.jpg'],
  });
  assert(mediaNotFound.status === 404, 'Media on unknown product → 404');

  // Verify counts also updated in list view
  const afterList = await request('GET', '/products');
  const updated = afterList.body.data.find((p) => p.id === productId);
  assert(updated?.image_count === 3, 'List reflects updated image_count');

  // ─── Summary ──────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  const total = passed + failed;
  if (failed === 0) {
    console.log(`  All ${total} tests passed ✓`);
  } else {
    console.log(`  ${passed}/${total} passed   ${failed} failed ✗`);
  }
  console.log('═══════════════════════════════════════\n');

  server.close();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner crashed:', err);
  server.close();
  process.exit(1);
});
