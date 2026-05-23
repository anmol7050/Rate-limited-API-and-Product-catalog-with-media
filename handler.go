package handler

import (
	"encoding/json"
	"net/http"

	"github.com/source-asia/backend-assignment/internal/store"
)

// ---- shared helpers --------------------------------------------------------

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

type errBody struct {
	Error string `json:"error"`
}

// ---- /request --------------------------------------------------------------

// RequestHandler handles POST /request.
type RequestHandler struct {
	Store *store.Store
}

// requestResponse is returned on a successful 201.
type requestResponse struct {
	Status  string `json:"status"`
	UserID  string `json:"user_id"`
	Message string `json:"message"`
}

func (h *RequestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeJSON(w, http.StatusMethodNotAllowed, errBody{Error: "method not allowed; use POST"})
		return
	}

	// Decode the top-level JSON object manually so we can give fine-grained
	// 400 messages and still allow payload to be *any* JSON value.
	var raw map[string]json.RawMessage
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "invalid JSON body: " + err.Error()})
		return
	}

	// Validate user_id.
	userIDRaw, exists := raw["user_id"]
	if !exists {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "missing required field: user_id"})
		return
	}
	var userID string
	if err := json.Unmarshal(userIDRaw, &userID); err != nil || userID == "" {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "user_id must be a non-empty string"})
		return
	}

	// Validate payload (must be present and valid JSON — any type).
	payloadRaw, exists := raw["payload"]
	if !exists || payloadRaw == nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "missing required field: payload"})
		return
	}
	// Ensure payload is actually valid JSON (not just null bytes).
	var tmp any
	if err := json.Unmarshal(payloadRaw, &tmp); err != nil {
		writeJSON(w, http.StatusBadRequest, errBody{Error: "payload must be a valid JSON value"})
		return
	}

	// Rate-limit check.
	rec := h.Store.GetOrCreate(userID)
	if !rec.TryAccept() {
		writeJSON(w, http.StatusTooManyRequests, errBody{
			Error: "rate limit exceeded: maximum 5 accepted requests per user per 1-minute rolling window",
		})
		return
	}

	// 201 Created — request accepted.
	writeJSON(w, http.StatusCreated, requestResponse{
		Status:  "accepted",
		UserID:  userID,
		Message: "request accepted and recorded successfully",
	})
}

// ---- /stats ----------------------------------------------------------------

// StatsHandler handles GET /stats.
type StatsHandler struct {
	Store *store.Store
}

// userStatEntry is one user's entry in the stats response.
type userStatEntry struct {
	AcceptedInCurrentWindow int `json:"accepted_in_current_window"`
	RejectedCumulative      int `json:"rejected_cumulative"`
}

// globalTotals aggregates across all users.
type globalTotals struct {
	AcceptedInCurrentWindow int `json:"accepted_in_current_window"`
	RejectedCumulative      int `json:"rejected_cumulative"`
}

// statsResponse is the full response body.
type statsResponse struct {
	Users  map[string]userStatEntry `json:"users"`
	Global globalTotals             `json:"global"`
}

func (h *StatsHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeJSON(w, http.StatusMethodNotAllowed, errBody{Error: "method not allowed; use GET"})
		return
	}

	snapshots := h.Store.AllSnapshots()

	users := make(map[string]userStatEntry, len(snapshots))
	var g globalTotals

	for id, pair := range snapshots {
		acc, rej := pair[0], pair[1]
		users[id] = userStatEntry{
			AcceptedInCurrentWindow: acc,
			RejectedCumulative:      rej,
		}
		g.AcceptedInCurrentWindow += acc
		g.RejectedCumulative += rej
	}

	writeJSON(w, http.StatusOK, statsResponse{
		Users:  users,
		Global: g,
	})
}
