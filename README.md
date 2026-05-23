# Rate-limited-API-and-Product-catalog-with-media
This is a Backend Assignment.
# Source Asia — Backend Assignment (Part 1)

> Built with Go · In-memory storage · Zero external dependencies

---

## Table of Contents

1. [Project structure](#project-structure)
2. [How to run](#how-to-run)
3. [Design decisions](#design-decisions)
4. [API reference](#api-reference)
5. [Stats schema](#stats-schema)
6. [curl examples](#curl-examples)
7. [Running tests](#running-tests)
8. [Production limitations](#production-limitations)
9. [AI tool usage](#ai-tool-usage)

---

## Project structure

```
.
├── main.go                        # Entry point + HTTP server wiring
├── go.mod
├── internal/
│   ├── store/
│   │   ├── store.go               # In-memory store (UserRecord, Store)
│   │   └── store_test.go          # Unit tests for rate-limit logic
│   └── handler/
│       ├── handler.go             # HTTP handlers for /request and /stats
│       └── handler_test.go        # Integration tests (httptest)
└── README.md
```

---

## How to run

**Prerequisites:** Go 1.22 or later (`go version` to check).

```bash
# Clone / unzip the repo, then:
cd source-asia-backend

# Run on default port 8080
go run .

# Run on a custom port
go run . -addr :9090
```

The server prints `Server listening on :8080` when ready.  
Stop it with **Ctrl-C** — it shuts down gracefully.

---

## Design decisions

| Topic | Choice | Rationale |
|---|---|---|
| **HTTP status on success** | **201 Created** | A new rate-limit record is created/updated on each accepted request; 201 reflects that semantic more accurately than 200. |
| **Rate-limit algorithm** | **Sliding (rolling) window** | Fairer than a fixed window — avoids the "burst at boundary" problem where a client can fire 10 requests in 2 seconds by straddling two fixed windows. |
| **Window duration** | 1 minute (60 s) | Stated in the brief. Configurable as a constant in `store/store.go`. |
| **Limit** | 5 accepted requests per user per rolling window | Stated in the brief. |
| **429 body** | JSON `{"error": "..."}` | Machine-readable; consistent with the error shape used for 400s. |
| **Rejected count** | **Cumulative** (across all windows, from server start) | More useful for operators — a per-window rejected count resets with accepted counts, hiding chronic abusers. Documented in stats schema. |
| **Concurrency** | Per-user `sync.Mutex` + top-level `sync.RWMutex` | Avoids a single global lock. Reads (stats) don't block each other; only writes to the same user contend. Double-checked locking prevents duplicate record creation. |
| **Graceful shutdown** | `http.Server.Shutdown` on SIGINT/SIGTERM | Lets in-flight requests finish; good practice even for dev servers. |

---

## API reference

### POST /request

Accepts a request payload on behalf of a user, subject to rate limiting.

**Request**

```
POST /request
Content-Type: application/json
```

```json
{
  "user_id": "alice",
  "payload": <any valid JSON value>
}
```

| Field | Type | Rules |
|---|---|---|
| `user_id` | string | Required, non-empty |
| `payload` | any JSON | Required, must be valid JSON (object, array, string, number, boolean, or null) |

**Success — 201 Created**

```json
{
  "status": "accepted",
  "user_id": "alice",
  "message": "request accepted and recorded successfully"
}
```

**Rate limit exceeded — 429 Too Many Requests**

```json
{
  "error": "rate limit exceeded: maximum 5 accepted requests per user per 1-minute rolling window"
}
```

**Validation error — 400 Bad Request**

```json
{
  "error": "missing required field: user_id"
}
```

Possible 400 messages:

- `invalid JSON body: …`
- `missing required field: user_id`
- `user_id must be a non-empty string`
- `missing required field: payload`
- `payload must be a valid JSON value`

---

### GET /stats

Returns per-user statistics and global aggregated totals.

**Request**

```
GET /stats
```

No body, no query parameters.

**Success — 200 OK**

See [Stats schema](#stats-schema) below.

---

## Stats schema

```json
{
  "users": {
    "<user_id>": {
      "accepted_in_current_window": 3,
      "rejected_cumulative": 7
    }
  },
  "global": {
    "accepted_in_current_window": 3,
    "rejected_cumulative": 7
  }
}
```

| Field | Description |
|---|---|
| `users` | Map of every user who has ever sent a request. |
| `users.<id>.accepted_in_current_window` | Number of accepted requests still inside the 1-minute rolling window at the moment the endpoint is called. |
| `users.<id>.rejected_cumulative` | **Cumulative** count of rejected requests since the server started (not per window). |
| `global.accepted_in_current_window` | Sum of all users' current-window accepted counts. |
| `global.rejected_cumulative` | Sum of all users' cumulative rejected counts. |

---

## curl examples

> The server must be running (`go run .`) before executing these.

### 1. Single accepted request

```bash
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"alice","payload":{"action":"buy","item":"coffee"}}'
```

Expected: `HTTP 201`

---

### 2. Hit the rate limit (run 6 times in quick succession)

```bash
for i in $(seq 1 6); do
  echo -n "Request $i: "
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST http://localhost:8080/request \
    -H "Content-Type: application/json" \
    -d '{"user_id":"bob","payload":null}'
  echo
done
```

Expected output:
```
Request 1: 201
Request 2: 201
Request 3: 201
Request 4: 201
Request 5: 201
Request 6: 429
```

---

### 3. Simulate concurrent requests (requires GNU parallel or xargs)

```bash
# Send 20 concurrent requests for the same user
seq 1 20 | xargs -P 20 -I{} \
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST http://localhost:8080/request \
    -H "Content-Type: application/json" \
    -d '{"user_id":"concurrent-user","payload":{}}'
```

Expected: exactly **five** `201` responses and fifteen `429` responses (in any order).

---

### 4. Check stats

```bash
curl -s http://localhost:8080/stats | python3 -m json.tool
```

---

### 5. Validation errors

```bash
# Missing user_id
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"payload":42}'

# Empty user_id
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"","payload":{}}'

# Invalid JSON
curl -s -w "\nHTTP %{http_code}\n" \
  -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d 'not json'
```

All should return `HTTP 400`.

---

### 6. Different payload types (all valid)

```bash
# Object
curl -s -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dave","payload":{"nested":true}}'

# Array
curl -s -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dave","payload":[1,2,3]}'

# Number
curl -s -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dave","payload":99}'

# Boolean
curl -s -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dave","payload":true}'

# null
curl -s -X POST http://localhost:8080/request \
  -H "Content-Type: application/json" \
  -d '{"user_id":"dave","payload":null}'
```

---

## Running tests

```bash
# All tests (unit + integration), verbose
go test ./... -v

# Skip the slow window-expiry test (which sleeps 62 seconds)
go test ./... -v -short

# With race detector (recommended for concurrency correctness)
go test ./... -race -short
```

The **concurrency test** (`TestTryAccept_Concurrent` / `TestRequest_RateLimit_Concurrent`) fires 20–50 goroutines simultaneously at the same user and asserts that exactly 5 are accepted. Run with `-race` to prove there are no data races.

---

## Production limitations

This service is intentionally simple. Before deploying it to production, the following limitations must be addressed:

| Limitation | Details | Possible remedy |
|---|---|---|
| **Single instance only** | All state lives in Go process memory. A second instance has no knowledge of the first's rate-limit counters. | Move state to a shared store — Redis (with Lua scripts or INCR+TTL) or a distributed key-value store. |
| **Restart loses all state** | Restarting the process resets every user's counter and accepted request history. | Persist state to Redis, a database, or a write-ahead log, and replay on startup. |
| **Memory grows unboundedly** | `UserRecord` entries accumulate forever — a `UserRecord` is never deleted even after a user goes quiet. | Run a background goroutine that evicts records idle for > N minutes. |
| **No authentication / authorisation** | Any caller can claim any `user_id`. | Add API-key or JWT auth so `user_id` is derived from a verified identity. |
| **No HTTPS** | Traffic is plain HTTP. | Put a TLS-terminating reverse proxy (nginx, Caddy, AWS ALB) in front. |
| **No observability** | There is no metrics endpoint (Prometheus), structured logging, or tracing. | Add `slog`-based structured logging, a `/metrics` endpoint, and OpenTelemetry tracing. |
| **No request-size limit** | A huge `payload` value is read entirely into memory. | Add `http.MaxBytesReader` to cap request body size. |
| **Fixed configuration** | Rate limit and window are compile-time constants. | Read them from environment variables or a config file. |

---

## AI tool usage

Claude (Anthropic) was used to assist with:

- Scaffolding the initial project directory layout
- Drafting the `store.go` sliding-window implementation and concurrency approach
- Generating the curl examples in this README

All generated code was reviewed and the concurrency model (per-user mutex + double-checked locking) was verified by hand.




Product Catalog API
REST API for a product catalog with media (image and video URLs).
Zero external dependencies — built entirely on Node.js built-ins (http, crypto).

Quick Start
bashnode src/server.js          # start on port 3001
node test.js                # run 46 integration tests (starts server in-process)
node seed.js                # create 1,000 products × 10 images (server must be running)
node seed.js 500 5          # 500 products, 5 images each
PORT=4000 node src/server.js
No npm install required.

Endpoints
POST /products
Creates a product. Media fields are optional.
Request body:
json{
  "name":       "Widget A",
  "sku":        "SKU-001",
  "image_urls": ["https://cdn.example.com/products/sku-001/img-1.jpg"],
  "video_urls": ["https://cdn.example.com/products/sku-001/demo.mp4"]
}
Success — 201 Created (full detail including URL arrays):
json{
  "id":            "a1b2c3d4-...",
  "name":          "Widget A",
  "sku":           "SKU-001",
  "image_count":   1,
  "video_count":   1,
  "thumbnail_url": "https://cdn.example.com/products/sku-001/img-1.jpg",
  "created_at":    "2025-01-01T00:00:00.000Z",
  "image_urls":    ["https://cdn.example.com/products/sku-001/img-1.jpg"],
  "video_urls":    ["https://cdn.example.com/products/sku-001/demo.mp4"]
}
Errors:
StatusCondition400Validation failure (see Validation section)409Duplicate sku

GET /products
List endpoint — safe for grids/tables with thousands of products.
Never returns image_urls or video_urls arrays.
Query parameters:
ParameterDefaultMaxNoteslimit20100Clamped to max silentlyoffset0—Negative values reset to 0
Response — 200 OK:
json{
  "data": [
    {
      "id":            "a1b2c3d4-...",
      "name":          "Widget A",
      "sku":           "SKU-001",
      "image_count":   2,
      "video_count":   1,
      "thumbnail_url": "https://cdn.example.com/products/sku-001/img-1.jpg",
      "created_at":    "2025-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "total":    1000,
    "limit":    20,
    "offset":   0,
    "has_more": true
  }
}

GET /products/:id
Detail endpoint — returns the full product including all URL arrays.
Response — 200 OK:
json{
  "id":            "a1b2c3d4-...",
  "name":          "Widget A",
  "sku":           "SKU-001",
  "image_count":   2,
  "video_count":   1,
  "thumbnail_url": "https://cdn.example.com/products/sku-001/img-1.jpg",
  "created_at":    "2025-01-01T00:00:00.000Z",
  "image_urls":    [
    "https://cdn.example.com/products/sku-001/img-1.jpg",
    "https://cdn.example.com/products/sku-001/img-2.jpg"
  ],
  "video_urls":    ["https://cdn.example.com/products/sku-001/demo.mp4"]
}
Errors:
StatusCondition404Unknown id

POST /products/:id/media
Appends new media URLs to an existing product. Does not replace existing URLs.
At least one of image_urls or video_urls must be present and non-empty.
Request body:
json{
  "image_urls": ["https://cdn.example.com/products/sku-001/img-3.jpg"],
  "video_urls": ["https://cdn.example.com/products/sku-001/demo-2.mp4"]
}
Response — 200 OK: Full product detail (same shape as GET /products/:id).
Errors:
StatusCondition400Empty body / no URLs provided / invalid URLs404Unknown id

Validation Rules
All rules are enforced on POST /products and POST /products/:id/media.
Text fields
FieldRulesnameRequired. Non-empty after trim. Max 500 characters.skuRequired. Non-empty after trim. Max 200 characters. Globally unique.
URL arrays
RuleDetailSchemaMust start with http:// or https:// (case-insensitive)StructureMust pass new URL() — valid host, no broken percent-encoding, etc.Max length2048 characters per URL (browser address-bar limit; CDN path constraint)Max per array20 URLs per array per request (applies to both image_urls and video_urls)TypeMust be strings; array items that are numbers, objects, etc. are rejected
The 20-URL cap is a per-request limit, not a per-product cap.
Products may accumulate unlimited URLs via multiple POST /products/:id/media calls.
What is NOT accepted

File uploads or multipart form data
Base64-encoded images or binary bodies
Non-HTTP/HTTPS schemes (ftp://, s3://, etc.)
Bodies over 1 MB


Error Envelope
All errors follow a consistent shape:
json{
  "error": {
    "status":  400,
    "message": "Validation failed",
    "details": [
      "name must not be empty",
      "image_urls[0]: URL must start with http:// or https://"
    ]
  }
}
details is only present when there is more than one specific sub-error to report.

Data Model
In-Memory Storage (current implementation)
Three data structures live in src/storage/store.js:
productStore  →  Map<id, ProductCore>
mediaStore    →  Map<id, ProductMedia>
skuIndex      →  Map<sku, id>
ProductCore — stored for every product, accessed by list queries:
js{
  id:            "uuid",
  name:          "Widget A",
  sku:           "SKU-001",
  image_count:   2,         // maintained counter — never requires counting the array
  video_count:   1,
  thumbnail_url: "https://...", // first image URL, or null
  created_at:    "ISO8601"
}
ProductMedia — stored separately, only loaded on detail/media routes:
js{
  image_urls: ["https://cdn.example.com/..."],
  video_urls: ["https://cdn.example.com/..."]
}
skuIndex — O(1) duplicate-SKU detection without a full table scan.
How list vs detail queries differ
QueryReads fromMedia loaded?Cost at 1,000 products × 10 imagesGET /products?limit=20productStore only✗ Never20 lightweight objectsGET /products/:idproductStore + mediaStore✓ For that one product1 core + 1 media recordPOST /products/:id/mediaBoth stores✓ For that one product1 core + 1 media record
With 1,000 products and 10 images each (10,000 URL strings total),
GET /products?limit=20 reads exactly 20 ProductCore objects and never
touches mediaStore. The 9,980 unread products' URL arrays are never allocated
in the serialisation path.

Production Design Notes
What I would change with PostgreSQL + a CDN
Schema
sql-- Core product — the "list table"
CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT        NOT NULL CHECK (char_length(name) <= 500),
  sku           TEXT        NOT NULL UNIQUE CHECK (char_length(sku) <= 200),
  image_count   INT         NOT NULL DEFAULT 0,
  video_count   INT         NOT NULL DEFAULT 0,
  thumbnail_url TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Media — one row per URL; never JOINed in list queries
CREATE TABLE product_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  media_type  TEXT        NOT NULL CHECK (media_type IN ('image', 'video')),
  url         TEXT        NOT NULL CHECK (char_length(url) <= 2048),
  position    INT         NOT NULL DEFAULT 0,  -- ordering within type
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON product_media(product_id, media_type, position);
Why this mirrors the in-memory split

GET /products?limit=N becomes SELECT … FROM products LIMIT N OFFSET M —
never touches product_media. Query time is constant regardless of media volume.
GET /products/:id adds one WHERE product_id = $1 query on product_media
which is index-covered and returns only that product's rows.
image_count and video_count are denormalised counters updated with the
same transaction that inserts rows in product_media, keeping list queries
aggregation-free.

CDN integration

Store only the CDN path key (e.g. products/sku-001/img-1.jpg), not the full URL.
Build the full URL at response time using an environment variable prefix
(CDN_BASE_URL). This lets you change CDN providers without a data migration.
thumbnail_url in products would store the path key too, resolved at read time.

Additional production concerns

Add a deleted_at (soft-delete) column with a partial index so that WHERE deleted_at IS NULL stays fast.
Enforce the per-request URL cap in the API layer (as now); enforce a per-product cap via a database CHECK constraint or trigger to prevent unbounded growth.
Use a database sequence or RETURNING id on INSERT rather than application-generated UUIDs to avoid unlikely but possible collisions under concurrent load.
Rate-limit media-append calls per product to prevent a single product from consuming disproportionate storage.


File Structure
product-catalog-api/
├── src/
│   ├── server.js              # HTTP server, routing entry point
│   ├── routes/
│   │   └── products.js        # All four product endpoints
│   ├── storage/
│   │   └── store.js           # productStore, mediaStore, skuIndex
│   ├── validators/
│   │   └── product.js         # All validation logic (documented inline)
│   └── utils/
│       ├── http.js            # readJson, sendJson, sendError, parseQuery
│       └── id.js              # UUID v4 generator (crypto built-in)
├── test.js                    # 46 integration tests (no test framework)
├── seed.js                    # Optional: creates N products × M images
├── package.json
└── README.md
