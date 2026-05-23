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
