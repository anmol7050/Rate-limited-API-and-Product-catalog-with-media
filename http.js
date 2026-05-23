'use strict';

/**
 * Reads and parses the JSON body from an IncomingMessage.
 * Rejects if body exceeds 1 MB, is not valid JSON, or Content-Type is wrong.
 *
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<unknown>}
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const MAX_BODY = 1_048_576; // 1 MB
    let raw = '';
    let size = 0;

    req.setEncoding('utf8');

    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk, 'utf8');
      if (size > MAX_BODY) {
        req.destroy();
        reject(Object.assign(new Error('Request body too large (max 1 MB)'), { status: 413 }));
        return;
      }
      raw += chunk;
    });

    req.on('end', () => {
      if (!raw.trim()) {
        // Empty body — treat as empty object; callers handle validation
        return resolve({});
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Invalid JSON in request body'), { status: 400 }));
      }
    });

    req.on('error', reject);
  });
}

/**
 * Sends a JSON response.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Sends a standardised error envelope.
 *
 * @param {import('http').ServerResponse} res
 * @param {number} status
 * @param {string} message
 * @param {string[]} [details]
 */
function sendError(res, status, message, details) {
  const body = { error: { status, message } };
  if (details && details.length) body.error.details = details;
  sendJson(res, status, body);
}

/**
 * Parses query-string parameters from a URL string.
 * @param {string} urlStr
 * @returns {URLSearchParams}
 */
function parseQuery(urlStr) {
  const idx = urlStr.indexOf('?');
  return new URLSearchParams(idx === -1 ? '' : urlStr.slice(idx + 1));
}

module.exports = { readJson, sendJson, sendError, parseQuery };
