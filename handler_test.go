package handler_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/source-asia/backend-assignment/internal/handler"
	"github.com/source-asia/backend-assignment/internal/store"
)

func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := store.New()
	mux := http.NewServeMux()
	mux.Handle("/request", &handler.RequestHandler{Store: s})
	mux.Handle("/stats", &handler.StatsHandler{Store: s})
	return httptest.NewServer(mux)
}

func postRequest(t *testing.T, srv *httptest.Server, body string) *http.Response {
	t.Helper()
	resp, err := http.Post(srv.URL+"/request", "application/json", bytes.NewBufferString(body))
	if err != nil {
		t.Fatalf("POST /request: %v", err)
	}
	return resp
}

// ---- POST /request ---------------------------------------------------------

func TestRequest_Created(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp := postRequest(t, srv, `{"user_id":"alice","payload":{"key":"value"}}`)
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("expected 201, got %d", resp.StatusCode)
	}

	var body map[string]string
	json.NewDecoder(resp.Body).Decode(&body)
	if body["status"] != "accepted" {
		t.Fatalf("expected status=accepted, got %q", body["status"])
	}
}

func TestRequest_MissingUserID(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp := postRequest(t, srv, `{"payload":123}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestRequest_EmptyUserID(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp := postRequest(t, srv, `{"user_id":"","payload":null}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestRequest_MissingPayload(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp := postRequest(t, srv, `{"user_id":"alice"}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestRequest_InvalidJSON(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp := postRequest(t, srv, `not-json`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestRequest_PayloadVariousTypes(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	payloads := []string{
		`{"user_id":"u","payload":42}`,
		`{"user_id":"u","payload":"hello"}`,
		`{"user_id":"u","payload":true}`,
		`{"user_id":"u","payload":[1,2,3]}`,
		`{"user_id":"u","payload":null}`,
	}
	for _, p := range payloads {
		resp := postRequest(t, srv, p)
		if resp.StatusCode != http.StatusCreated {
			t.Errorf("payload %s: expected 201, got %d", p, resp.StatusCode)
		}
	}
}

func TestRequest_RateLimit(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	body := `{"user_id":"limited","payload":{}}`
	for i := 0; i < store.RateLimit; i++ {
		resp := postRequest(t, srv, body)
		if resp.StatusCode != http.StatusCreated {
			t.Fatalf("call %d: expected 201, got %d", i+1, resp.StatusCode)
		}
	}

	resp := postRequest(t, srv, body)
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("expected 429 after limit, got %d", resp.StatusCode)
	}

	var errResp map[string]string
	json.NewDecoder(resp.Body).Decode(&errResp)
	if errResp["error"] == "" {
		t.Fatal("expected non-empty error message in 429 body")
	}
}

func TestRequest_RateLimit_Concurrent(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	const total = 30
	codes := make([]int, total)
	var wg sync.WaitGroup
	wg.Add(total)

	for i := 0; i < total; i++ {
		i := i
		go func() {
			defer wg.Done()
			resp := postRequest(t, srv, `{"user_id":"concurrent","payload":{}}`)
			codes[i] = resp.StatusCode
		}()
	}
	wg.Wait()

	accepted := 0
	for _, c := range codes {
		if c == http.StatusCreated {
			accepted++
		}
	}
	if accepted != store.RateLimit {
		t.Fatalf("expected exactly %d accepted under concurrency, got %d", store.RateLimit, accepted)
	}
}

func TestRequest_MethodNotAllowed(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp, _ := http.Get(srv.URL + "/request")
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", resp.StatusCode)
	}
}

// ---- GET /stats ------------------------------------------------------------

func TestStats_Empty(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/stats")
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}

	var body map[string]any
	json.NewDecoder(resp.Body).Decode(&body)
	if _, ok := body["users"]; !ok {
		t.Fatal("expected 'users' key in stats response")
	}
	if _, ok := body["global"]; !ok {
		t.Fatal("expected 'global' key in stats response")
	}
}

func TestStats_AfterRequests(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	// 3 accepted for alice, then 4 more (3 accepted + 1 rejected... wait, alice already has 3).
	// Let's do: alice → 5 accepted, 2 rejected.
	for i := 0; i < 7; i++ {
		postRequest(t, srv, `{"user_id":"alice","payload":{}}`)
	}

	resp, _ := http.Get(srv.URL + "/stats")
	var body struct {
		Users map[string]struct {
			AcceptedInCurrentWindow int `json:"accepted_in_current_window"`
			RejectedCumulative      int `json:"rejected_cumulative"`
		} `json:"users"`
		Global struct {
			AcceptedInCurrentWindow int `json:"accepted_in_current_window"`
			RejectedCumulative      int `json:"rejected_cumulative"`
		} `json:"global"`
	}
	json.NewDecoder(resp.Body).Decode(&body)

	alice := body.Users["alice"]
	if alice.AcceptedInCurrentWindow != 5 {
		t.Fatalf("expected alice accepted=5, got %d", alice.AcceptedInCurrentWindow)
	}
	if alice.RejectedCumulative != 2 {
		t.Fatalf("expected alice rejected=2, got %d", alice.RejectedCumulative)
	}

	// Global totals should match.
	if body.Global.AcceptedInCurrentWindow != 5 {
		t.Fatalf("expected global accepted=5, got %d", body.Global.AcceptedInCurrentWindow)
	}
}

func TestStats_MultipleUsers(t *testing.T) {
	srv := newTestServer(t)
	defer srv.Close()

	users := []string{"u1", "u2", "u3"}
	for _, u := range users {
		for i := 0; i < 2; i++ {
			postRequest(t, srv, fmt.Sprintf(`{"user_id":%q,"payload":{}}`, u))
		}
	}

	resp, _ := http.Get(srv.URL + "/stats")
	var body struct {
		Users  map[string]map[string]int `json:"users"`
		Global map[string]int            `json:"global"`
	}
	json.NewDecoder(resp.Body).Decode(&body)

	if len(body.Users) != 3 {
		t.Fatalf("expected 3 users, got %d", len(body.Users))
	}
	if body.Global["accepted_in_current_window"] != 6 {
		t.Fatalf("expected global accepted=6, got %d", body.Global["accepted_in_current_window"])
	}
}
