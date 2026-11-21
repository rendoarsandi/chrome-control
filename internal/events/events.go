package events

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/errs"
)

const (
	MaxQueueEvents = 256
	MaxQueueBytes  = 262144
	MaxFieldLen    = 4000
)

type queuedItem struct {
	value map[string]any
	bytes int
}

// PageEvents captures bounded selected-page CDP network, console, exception, and navigation events.
type PageEvents struct {
	mu           sync.Mutex
	queue        []queuedItem
	bytes        int
	dropped      int
	inflight     map[string]struct{}
	lastActivity time.Time
	closed       bool
	unsub        []func()
}

// New creates a new PageEvents buffer.
func New() *PageEvents {
	return &PageEvents{
		inflight:     make(map[string]struct{}),
		lastActivity: time.Now(),
	}
}

// AddUnsub registers a cleanup callback executed on Close.
func (p *PageEvents) AddUnsub(fn func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		fn()
		return
	}
	p.unsub = append(p.unsub, fn)
}

// Push appends a bounded event to the ring buffer.
func (p *PageEvents) Push(ev map[string]any) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	bounded := make(map[string]any, len(ev)+1)
	bounded["timestamp"] = time.Now().UnixMilli()
	for k, v := range ev {
		if s, ok := v.(string); ok && len(s) > MaxFieldLen {
			bounded[k] = s[:MaxFieldLen]
		} else {
			bounded[k] = v
		}
	}
	raw, _ := json.Marshal(bounded)
	sz := len(raw)
	p.queue = append(p.queue, queuedItem{value: bounded, bytes: sz})
	p.bytes += sz
	for len(p.queue) > MaxQueueEvents || p.bytes > MaxQueueBytes {
		p.bytes -= p.queue[0].bytes
		p.queue = p.queue[1:]
		p.dropped++
	}
}

// NoteRequestStart tracks an in-flight request for network idle detection.
func (p *PageEvents) NoteRequestStart(requestID, resourceType string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.lastActivity = time.Now()
	if resourceType != "WebSocket" && resourceType != "EventSource" {
		p.inflight[requestID] = struct{}{}
	}
}

// NoteRequestEnd removes a finished or failed request from the in-flight set.
func (p *PageEvents) NoteRequestEnd(requestID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return
	}
	p.lastActivity = time.Now()
	delete(p.inflight, requestID)
}

// DrainResult is returned by Drain.
type DrainResult struct {
	Events    []map[string]any `json:"events"`
	Dropped   int              `json:"dropped"`
	Remaining int              `json:"remaining"`
}

// Drain consumes up to maxEvents matching the optional types filter.
func (p *PageEvents) Drain(types []string, maxEvents int) DrainResult {
	p.mu.Lock()
	defer p.mu.Unlock()
	if maxEvents <= 0 {
		maxEvents = 100
	}
	var typeSet map[string]bool
	if len(types) > 0 {
		typeSet = make(map[string]bool, len(types))
		for _, t := range types {
			typeSet[t] = true
		}
	}
	out := make([]map[string]any, 0)
	kept := make([]queuedItem, 0, len(p.queue))
	for _, item := range p.queue {
		t, _ := item.value["type"].(string)
		if len(out) >= maxEvents || (typeSet != nil && !typeSet[t]) {
			kept = append(kept, item)
			continue
		}
		out = append(out, item.value)
		p.bytes -= item.bytes
	}
	p.queue = kept
	dropped := p.dropped
	p.dropped = 0
	return DrainResult{
		Events:    out,
		Dropped:   dropped,
		Remaining: len(p.queue),
	}
}

// IdleResult is returned by Idle.
type IdleResult struct {
	Matched         bool   `json:"matched"`
	IdleMS          int    `json:"idle_ms,omitempty"`
	TimeoutMS       int    `json:"timeout_ms,omitempty"`
	PendingRequests int    `json:"pending_requests,omitempty"`
	Recovery        string `json:"recovery,omitempty"`
}

// Idle waits until no non-streaming requests are in flight for at least idleMS.
func (p *PageEvents) Idle(ctx context.Context, idleMS, timeoutMS int) (IdleResult, error) {
	if idleMS <= 0 {
		idleMS = 500
	}
	if timeoutMS <= 0 {
		timeoutMS = 5000
	}
	started := time.Now()
	idleDur := time.Duration(idleMS) * time.Millisecond
	timeoutDur := time.Duration(timeoutMS) * time.Millisecond
	deadline := started.Add(timeoutDur)

	for {
		p.mu.Lock()
		closed := p.closed
		inflightCount := len(p.inflight)
		lastAct := p.lastActivity
		p.mu.Unlock()

		if closed {
			return IdleResult{}, errs.New(
				"EVENT_STREAM_CLOSED",
				"The watched page disconnected.",
				"Select the intended tab and call watch_events() again.",
				nil,
			)
		}
		ref := lastAct
		if started.After(ref) {
			ref = started
		}
		if inflightCount == 0 && time.Since(ref) >= idleDur {
			return IdleResult{Matched: true, IdleMS: idleMS}, nil
		}
		now := time.Now()
		if !now.Before(deadline) {
			return IdleResult{
				Matched:         false,
				TimeoutMS:       timeoutMS,
				PendingRequests: inflightCount,
				Recovery:        "Inspect the page and drain_events(); input is not repeated.",
			}, nil
		}
		sleep := 50 * time.Millisecond
		if rem := deadline.Sub(now); rem < sleep {
			sleep = rem
		}
		select {
		case <-ctx.Done():
			return IdleResult{}, ctx.Err()
		case <-time.After(sleep):
		}
	}
}

// Close stops recording events and runs unsubscribe callbacks.
func (p *PageEvents) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	unsubs := p.unsub
	p.unsub = nil
	p.queue = nil
	p.bytes = 0
	p.mu.Unlock()

	for _, fn := range unsubs {
		fn()
	}
}
