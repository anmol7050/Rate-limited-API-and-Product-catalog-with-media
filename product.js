'use strict';

/**
 * Validation rules (all documented here):
 *
 *  URL rules
 *  ─────────
 *  • Must be a non-empty string
 *  • Must start with http:// or https:// (case-insensitive)
 *  • Maximum length: 2048 characters (matches browser URL length limits and
 *    common CDN/storage constraints)
 *  • Must pass Node's URL constructor (ensures well-formed host, path, etc.)
 *
 *  Array limits
 *  ────────────
 *  • Maximum 20 URLs per array per request (image_urls or video_urls)
 *  • This is a per-request cap, not a per-product cap.
 *    Products may accumulate more via successive POST /products/:id/media calls.
 *
 *  Text fields
 *  ───────────
 *  • name:  required, non-empty after trim, max 500 characters
 *  • sku:   required, non-empty after trim, max 200 characters
 */

const MAX_URLS_PER_ARRAY = 20;
const MAX_URL_LENGTH = 2048;
const MAX_NAME_LENGTH = 500;
const MAX_SKU_LENGTH = 200;

/**
 * Validates a single URL string.
 * @param {unknown} url
 * @returns {{ valid: boolean, reason?: string }}
 */
function validateUrl(url) {
  if (typeof url !== 'string') {
    return { valid: false, reason: 'URL must be a string' };
  }
  if (url.length === 0) {
    return { valid: false, reason: 'URL must not be empty' };
  }
  if (url.length > MAX_URL_LENGTH) {
    return {
      valid: false,
      reason: `URL exceeds maximum length of ${MAX_URL_LENGTH} characters`,
    };
  }
  const lower = url.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return {
      valid: false,
      reason: 'URL must start with http:// or https://',
    };
  }
  try {
    new URL(url); // structural validation
  } catch {
    return { valid: false, reason: `Malformed URL: "${url}"` };
  }
  return { valid: true };
}

/**
 * Validates an array of URLs.
 * @param {unknown} arr - the raw value from the request body
 * @param {string} fieldName - e.g. "image_urls"
 * @returns {{ errors: string[] }}
 */
function validateUrlArray(arr, fieldName) {
  const errors = [];

  if (arr === undefined || arr === null) {
    return { errors }; // optional field — absence is fine
  }

  if (!Array.isArray(arr)) {
    errors.push(`${fieldName} must be an array`);
    return { errors };
  }

  if (arr.length > MAX_URLS_PER_ARRAY) {
    errors.push(
      `${fieldName} exceeds maximum of ${MAX_URLS_PER_ARRAY} URLs per request`
    );
    return { errors };
  }

  arr.forEach((url, i) => {
    const result = validateUrl(url);
    if (!result.valid) {
      errors.push(`${fieldName}[${i}]: ${result.reason}`);
    }
  });

  return { errors };
}

/**
 * Validates the body for POST /products.
 * @param {unknown} body
 * @returns {{ errors: string[] }}
 */
function validateCreateProduct(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  // name
  if (body.name === undefined || body.name === null) {
    errors.push('name is required');
  } else if (typeof body.name !== 'string') {
    errors.push('name must be a string');
  } else if (body.name.trim().length === 0) {
    errors.push('name must not be empty');
  } else if (body.name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds maximum length of ${MAX_NAME_LENGTH} characters`);
  }

  // sku
  if (body.sku === undefined || body.sku === null) {
    errors.push('sku is required');
  } else if (typeof body.sku !== 'string') {
    errors.push('sku must be a string');
  } else if (body.sku.trim().length === 0) {
    errors.push('sku must not be empty');
  } else if (body.sku.length > MAX_SKU_LENGTH) {
    errors.push(`sku exceeds maximum length of ${MAX_SKU_LENGTH} characters`);
  }

  // image_urls (optional)
  const imgResult = validateUrlArray(body.image_urls, 'image_urls');
  errors.push(...imgResult.errors);

  // video_urls (optional)
  const vidResult = validateUrlArray(body.video_urls, 'video_urls');
  errors.push(...vidResult.errors);

  return { errors };
}

/**
 * Validates the body for POST /products/:id/media.
 * At least one of image_urls or video_urls must be present and non-empty.
 * @param {unknown} body
 * @returns {{ errors: string[] }}
 */
function validateAddMedia(body) {
  const errors = [];

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: ['Request body must be a JSON object'] };
  }

  const hasImages =
    Array.isArray(body.image_urls) && body.image_urls.length > 0;
  const hasVideos =
    Array.isArray(body.video_urls) && body.video_urls.length > 0;

  if (!hasImages && !hasVideos) {
    errors.push(
      'At least one of image_urls or video_urls must be present and non-empty'
    );
    return { errors };
  }

  const imgResult = validateUrlArray(body.image_urls, 'image_urls');
  errors.push(...imgResult.errors);

  const vidResult = validateUrlArray(body.video_urls, 'video_urls');
  errors.push(...vidResult.errors);

  return { errors };
}

module.exports = {
  validateCreateProduct,
  validateAddMedia,
  MAX_URLS_PER_ARRAY,
  MAX_URL_LENGTH,
};
