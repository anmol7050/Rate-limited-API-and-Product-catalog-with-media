package store_test

import (
	"sync"
	"testing"
	"time"

	"github.com/source-asia/backend-assignment/internal/store"
)

func TestTryAccept_BasicLimit(t *testing.T) {
	s := store.New()
	rec := s.GetOrCreate("alice")

	for i := 0; i < store.RateLimit; i++ {
		if !rec.TryAccept() {
			t.Fatalf("expected accept on call %d", i+1)
		}
	}
	if rec.TryAccept() {
		t.Fatal("expected rejection after limit reached")
	}
}

func TestTryAccept_RejectedCountIncrement(t *testing.T) {
	s := store.New()
	rec := s.GetOrCreate("bob")

	for i := 0; i < store.RateLimit; i++ {
		rec.TryAccept()
	}
	rec.TryAccept() // rejected
	rec.TryAccept() // rejected

	_, rej := rec.Snapshot()
	if rej != 2 {
		t.Fatalf("expected 2 cumulative rejections, got %d", rej)
	}
}

func TestTryAccept_WindowExpiry(t *testing.T) {
	// This test overrides the window by manipulating time indirectly:
	// because we cannot monkey-patch time.Now in the store without
	// injecting a clock, we instead verify that the count drops to 0
	// after more than WindowDuration has passed since the first accept.
	// (Skipped in short test runs because it sleeps >1 min.)
	if testing.Short() {
		t.Skip("skipping window-expiry test in short mode")
	}

	s := store.New()
	rec := s.GetOrCreate("charlie")

	for i := 0; i < store.RateLimit; i++ {
		rec.TryAccept()
	}
	// Confirm full — should be rejected.
	if rec.TryAccept() {
		t.Fatal("expected rejection at limit")
	}

	time.Sleep(store.WindowDuration + 2*time.Second)

	// After the window the old timestamps are pruned; should be accepted again.
	if !rec.TryAccept() {
		t.Fatal("expected accept after window expired")
	}
}

func TestTryAccept_Concurrent(t *testing.T) {
	s := store.New()
	rec := s.GetOrCreate("concurrent-user")

	const goroutines = 50
	results := make([]bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)

	for i := 0; i < goroutines; i++ {
		i := i
		go func() {
			defer wg.Done()
			results[i] = rec.TryAccept()
		}()
	}
	wg.Wait()

	accepted := 0
	for _, ok := range results {
		if ok {
			accepted++
		}
	}
	if accepted != store.RateLimit {
		t.Fatalf("expected exactly %d accepted under concurrency, got %d", store.RateLimit, accepted)
	}
}

func TestGetOrCreate_Idempotent(t *testing.T) {
	s := store.New()
	r1 := s.GetOrCreate("user-x")
	r2 := s.GetOrCreate("user-x")
	if r1 != r2 {
		t.Fatal("GetOrCreate must return the same pointer for the same user")
	}
}

func TestAllSnapshots(t *testing.T) {
	s := store.New()
	s.GetOrCreate("u1").TryAccept()
	s.GetOrCreate("u1").TryAccept()
	s.GetOrCreate("u2").TryAccept()

	snaps := s.AllSnapshots()
	if snaps["u1"][0] != 2 {
		t.Fatalf("expected u1 accepted=2, got %d", snaps["u1"][0])
	}
	if snaps["u2"][0] != 1 {
		t.Fatalf("expected u2 accepted=1, got %d", snaps["u2"][0])
	}
}
