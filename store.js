/**
 * In-Memory Storage
 *
 * Two separate Maps are the heart of the performance design:
 *
 *   productStore  →  Map<id, ProductCore>
 *     { id, name, sku, image_count, video_count, thumbnail_url, created_at }
 *     No URL arrays. List queries only touch this Map.
 *
 *   mediaStore    →  Map<id, ProductMedia>
 *     { image_urls: string[], video_urls: string[] }
 *     Only loaded on GET /products/:id (detail) and media-append calls.
 *
 *   skuIndex      →  Map<sku, id>
 *     O(1) duplicate-SKU checks without scanning productStore.
 *
 * With 1,000 products × 10 images each, GET /products?limit=20 reads
 * exactly 20 ProductCore objects and never touches mediaStore at all.
 */

'use strict';

/** @type {Map<string, import('../types').ProductCore>} */
const productStore = new Map();

/** @type {Map<string, import('../types').ProductMedia>} */
const mediaStore = new Map();

/** @type {Map<string, string>} SKU → product id */
const skuIndex = new Map();

module.exports = { productStore, mediaStore, skuIndex };
