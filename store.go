package store

import (
	"sync"
	"time"
)

const (
	RateLimit      = 5
	WindowDuration = time.Minute
)

// UserRecord holds per-user sliding-window timestamps and cumulative rejected count.
type UserRecord struct {
	mu          sync.Mutex
	timestamps  []time.Time // timestamps of accepted requests (within the window)
	RejectedAll int         // cumulative rejected count (across all windows)
}

// TryAccept attempts to accept a request for this user under the sliding-window
// rate limit. Returns true if accepted, false if rejected.
func (u *UserRecord) TryAccept() bool {
	u.mu.Lock()
	defer u.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-WindowDuration)

	// Prune timestamps outside the current rolling window.
	valid := u.timestamps[:0]
	for _, t := range u.timestamps {
		if t.After(cutoff) {
			valid = append(valid, t)
		}
	}
	u.timestamps = valid

	if len(u.timestamps) >= RateLimit {
		u.RejectedAll++
		return false
	}

	u.timestamps = append(u.timestamps, now)
	return true
}

// Snapshot returns a point-in-time read of accepted (in current window) and
// cumulative rejected counts. Safe to call concurrently.
func (u *UserRecord) Snapshot() (acceptedInWindow, rejectedTotal int) {
	u.mu.Lock()
	defer u.mu.Unlock()

	now := time.Now()
	cutoff := now.Add(-WindowDuration)

	count := 0
	for _, t := range u.timestamps {
		if t.After(cutoff) {
			count++
		}
	}
	return count, u.RejectedAll
}

// Store is the top-level in-memory store, safe for concurrent use.
type Store struct {
	mu    sync.RWMutex
	users map[string]*UserRecord
}

// New returns an initialised Store.
func New() *Store {
	return &Store{users: make(map[string]*UserRecord)}
}

// GetOrCreate returns the UserRecord for userID, creating it if absent.
func (s *Store) GetOrCreate(userID string) *UserRecord {
	// Fast path: read lock.
	s.mu.RLock()
	u, ok := s.users[userID]
	s.mu.RUnlock()
	if ok {
		return u
	}

	// Slow path: write lock with double-checked locking.
	s.mu.Lock()
	defer s.mu.Unlock()
	if u, ok = s.users[userID]; ok {
		return u
	}
	u = &UserRecord{}
	s.users[userID] = u
	return u
}

// AllSnapshots returns a snapshot of every user's stats.
func (s *Store) AllSnapshots() map[string][2]int {
	s.mu.RLock()
	ids := make([]string, 0, len(s.users))
	records := make([]*UserRecord, 0, len(s.users))
	for id, rec := range s.users {
		ids = append(ids, id)
		records = append(records, rec)
	}
	s.mu.RUnlock()

	out := make(map[string][2]int, len(ids))
	for i, id := range ids {
		acc, rej := records[i].Snapshot()
		out[id] = [2]int{acc, rej}
	}
	return out
}
