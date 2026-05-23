'use strict';

/**
 * Product Routes
 *
 * POST   /products
 * GET    /products
 * GET    /products/:id
 * POST   /products/:id/media
 */

const { productStore, mediaStore, skuIndex } = require('../storage/store');
const { generateId } = require('../utils/id');
const { readJson, sendJson, sendError, parseQuery } = require('../utils/http');
const {
  validateCreateProduct,
  validateAddMedia,
} = require('../validators/product');

// ─── Pagination defaults & limits ────────────────────────────────────────────
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_OFFSET = 0;

// ─── POST /products ───────────────────────────────────────────────────────────

async function createProduct(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const { errors } = validateCreateProduct(body);
  if (errors.length) {
    return sendError(res, 400, 'Validation failed', errors);
  }

  const sku = body.sku.trim();
  const name = body.name.trim();

  // Duplicate SKU → 409 Conflict
  if (skuIndex.has(sku)) {
    return sendError(
      res,
      409,
      `A product with SKU "${sku}" already exists`,
    );
  }

  const id = generateId();
  const imageUrls = Array.isArray(body.image_urls) ? [...body.image_urls] : [];
  const videoUrls = Array.isArray(body.video_urls) ? [...body.video_urls] : [];
  const now = new Date().toISOString();

  // Core record — no URL arrays stored here
  const productCore = {
    id,
    name,
    sku,
    image_count: imageUrls.length,
    video_count: videoUrls.length,
    // thumbnail_url: first image if provided, otherwise null
    thumbnail_url: imageUrls[0] ?? null,
    created_at: now,
  };

  // Media stored separately
  const productMedia = {
    image_urls: imageUrls,
    video_urls: videoUrls,
  };

  productStore.set(id, productCore);
  mediaStore.set(id, productMedia);
  skuIndex.set(sku, id);

  // Detail response on create (full URLs included)
  return sendJson(res, 201, {
    ...productCore,
    image_urls: imageUrls,
    video_urls: videoUrls,
  });
}

// ─── GET /products ────────────────────────────────────────────────────────────
/**
 * List endpoint.
 *
 * Query params:
 *   limit   integer  1–100  default 20
 *   offset  integer  ≥0     default 0
 *
 * Response shape per item (NO url arrays):
 *   { id, name, sku, image_count, video_count, thumbnail_url, created_at }
 *
 * Performance: iterates productStore only.  mediaStore is never accessed.
 * With 1,000 products and limit=20 this reads 20 lightweight objects.
 */
function listProducts(req, res) {
  const q = parseQuery(req.url);

  let limit = parseInt(q.get('limit') ?? DEFAULT_LIMIT, 10);
  let offset = parseInt(q.get('offset') ?? DEFAULT_OFFSET, 10);

  if (Number.isNaN(limit) || limit < 1) limit = DEFAULT_LIMIT;
  if (limit > MAX_LIMIT) limit = MAX_LIMIT;
  if (Number.isNaN(offset) || offset < 0) offset = DEFAULT_OFFSET;

  // productStore preserves insertion order (Map guarantee)
  const allProducts = [...productStore.values()];
  const total = allProducts.length;
  const page = allProducts.slice(offset, offset + limit);

  return sendJson(res, 200, {
    data: page,       // lightweight core objects only
    pagination: {
      total,
      limit,
      offset,
      has_more: offset + limit < total,
    },
  });
}

// ─── GET /products/:id ────────────────────────────────────────────────────────

function getProduct(req, res, id) {
  const core = productStore.get(id);
  if (!core) {
    return sendError(res, 404, `Product "${id}" not found`);
  }

  // Only here do we load media
  const media = mediaStore.get(id) ?? { image_urls: [], video_urls: [] };

  return sendJson(res, 200, {
    ...core,
    image_urls: media.image_urls,
    video_urls: media.video_urls,
  });
}

// ─── POST /products/:id/media ─────────────────────────────────────────────────

async function addMedia(req, res, id) {
  const core = productStore.get(id);
  if (!core) {
    return sendError(res, 404, `Product "${id}" not found`);
  }

  let body;
  try {
    body = await readJson(req);
  } catch (err) {
    return sendError(res, err.status || 400, err.message);
  }

  const { errors } = validateAddMedia(body);
  if (errors.length) {
    return sendError(res, 400, 'Validation failed', errors);
  }

  const media = mediaStore.get(id) ?? { image_urls: [], video_urls: [] };
  const newImages = Array.isArray(body.image_urls) ? body.image_urls : [];
  const newVideos = Array.isArray(body.video_urls) ? body.video_urls : [];

  // Append
  media.image_urls.push(...newImages);
  media.video_urls.push(...newVideos);
  mediaStore.set(id, media);

  // Update counts and thumbnail on the core record
  core.image_count = media.image_urls.length;
  core.video_count = media.video_urls.length;
  if (!core.thumbnail_url && media.image_urls.length > 0) {
    core.thumbnail_url = media.image_urls[0];
  }
  productStore.set(id, core);

  // Return full detail
  return sendJson(res, 200, {
    ...core,
    image_urls: media.image_urls,
    video_urls: media.video_urls,
  });
}

// ─── Router ───────────────────────────────────────────────────────────────────

/**
 * Routes all /products* requests.
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {string} pathname  e.g. "/products" or "/products/abc-123/media"
 */
async function productRouter(req, res, pathname) {
  const method = req.method.toUpperCase();

  // Strip trailing slash for matching
  const clean = pathname.replace(/\/$/, '') || '/';

  // POST /products
  if (method === 'POST' && clean === '/products') {
    return createProduct(req, res);
  }

  // GET /products
  if (method === 'GET' && clean === '/products') {
    return listProducts(req, res);
  }

  // /products/:id  or  /products/:id/media
  const detailMatch = clean.match(/^\/products\/([^/]+)$/);
  if (detailMatch) {
    const id = decodeURIComponent(detailMatch[1]);
    if (method === 'GET') return getProduct(req, res, id);
    return sendError(res, 405, `Method ${method} not allowed on this endpoint`);
  }

  const mediaMatch = clean.match(/^\/products\/([^/]+)\/media$/);
  if (mediaMatch) {
    const id = decodeURIComponent(mediaMatch[1]);
    if (method === 'POST') return addMedia(req, res, id);
    return sendError(res, 405, `Method ${method} not allowed on this endpoint`);
  }

  return sendError(res, 404, 'Route not found');
}

module.exports = { productRouter };
