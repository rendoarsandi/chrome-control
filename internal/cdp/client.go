package cdp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

// Event represents an incoming CDP notification.
type Event struct {
	SessionID string
	Method    string
	Params    json.RawMessage
}

type cdpRequest struct {
	ID        int64  `json:"id"`
	SessionID string `json:"sessionId,omitempty"`
	Method    string `json:"method"`
	Params    any    `json:"params,omitempty"`
}

type cdpMessage struct {
	ID        int64           `json:"id,omitempty"`
	SessionID string          `json:"sessionId,omitempty"`
	Method    string          `json:"method,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     *cdpError       `json:"error,omitempty"`
}

type cdpError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    string `json:"data,omitempty"`
}

func (e *cdpError) Error() string {
	if e.Data != "" {
		return fmt.Sprintf("CDP error (%d): %s (%s)", e.Code, e.Message, e.Data)
	}
	return fmt.Sprintf("CDP error (%d): %s", e.Code, e.Message)
}

type pendingCall struct {
	ch chan cdpResponse
}

type cdpResponse struct {
	result json.RawMessage
	err    error
}

type listener struct {
	id        int64
	sessionID string // "" matches all sessions; "*" matches all; specific matches exact
	method    string // "" matches all methods
	fn        func(Event)
}

// Client is a multiplexed direct Chrome DevTools Protocol WebSocket client.
type Client struct {
	conn      *websocket.Conn
	writeMu   sync.Mutex
	mu        sync.Mutex
	nextID    atomic.Int64
	nextSubID atomic.Int64
	pending   map[int64]pendingCall
	listeners map[int64]listener
	closed    bool
	closedCh  chan struct{}
	closeErr  error
}

// Dial connects to an HTTP CDP discovery URL (resolving /json/version) or directly to a ws/wss URL.
func Dial(ctx context.Context, endpoint string) (*Client, error) {
	wsURL, err := resolveWebSocketURL(ctx, endpoint)
	if err != nil {
		return nil, err
	}
	dialer := websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		ReadBufferSize:   64 * 1024,
		WriteBufferSize:  64 * 1024,
	}
	conn, resp, err := dialer.DialContext(ctx, wsURL, nil)
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		return nil, err
	}
	// Allow large CDP payloads (screenshots, PDFs, media blobs up to 100 MiB).
	conn.SetReadLimit(100 * 1024 * 1024)

	c := &Client{
		conn:      conn,
		pending:   make(map[int64]pendingCall),
		listeners: make(map[int64]listener),
		closedCh:  make(chan struct{}),
	}
	go c.readLoop()
	return c, nil
}

func resolveWebSocketURL(ctx context.Context, endpoint string) (string, error) {
	u, err := url.Parse(endpoint)
	if err != nil {
		return "", fmt.Errorf("invalid CDP endpoint: %w", err)
	}
	if u.Scheme == "ws" || u.Scheme == "wss" {
		return endpoint, nil
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("unsupported CDP scheme: %s", u.Scheme)
	}
	versionURL := *u
	versionURL.Path = strings.TrimRight(versionURL.Path, "/") + "/json/version"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, versionURL.String(), nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("CDP discovery returned HTTP %d.", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
	if err != nil {
		return "", err
	}
	var ver struct {
		WebSocketDebuggerURL string `json:"webSocketDebuggerUrl"`
	}
	if err := json.Unmarshal(body, &ver); err != nil {
		return "", fmt.Errorf("invalid /json/version JSON: %w", err)
	}
	if ver.WebSocketDebuggerURL == "" {
		return "", errors.New("CDP /json/version omitted webSocketDebuggerUrl")
	}
	// If discovery happened on 127.0.0.1:PORT and Chrome reported a different host or missing port, preserve endpoint host when needed.
	wsParsed, err := url.Parse(ver.WebSocketDebuggerURL)
	if err != nil {
		return "", err
	}
	if wsParsed.Host == "" {
		wsParsed.Host = u.Host
	}
	return wsParsed.String(), nil
}

func (c *Client) readLoop() {
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			c.failAll(err)
			return
		}
		var msg cdpMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			c.failAll(fmt.Errorf("invalid CDP JSON frame: %w", err))
			return
		}
		if msg.ID != 0 {
			c.mu.Lock()
			call, ok := c.pending[msg.ID]
			if ok {
				delete(c.pending, msg.ID)
			}
			c.mu.Unlock()
			if ok {
				if msg.Error != nil {
					call.ch <- cdpResponse{err: msg.Error}
				} else {
					call.ch <- cdpResponse{result: msg.Result}
				}
			}
			continue
		}
		if msg.Method != "" {
			ev := Event{
				SessionID: msg.SessionID,
				Method:    msg.Method,
				Params:    msg.Params,
			}
			c.dispatchEvent(ev)
		}
	}
}

func (c *Client) dispatchEvent(ev Event) {
	c.mu.Lock()
	matched := make([]func(Event), 0, 4)
	for _, l := range c.listeners {
		if l.sessionID != "*" && l.sessionID != ev.SessionID {
			continue
		}
		if l.method != "" && l.method != ev.Method {
			continue
		}
		matched = append(matched, l.fn)
	}
	c.mu.Unlock()

	for _, fn := range matched {
		fn(ev)
	}
}

func (c *Client) failAll(err error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	c.closed = true
	if err == nil {
		err = errors.New("browser disconnected: CDP connection closed")
	}
	c.closeErr = err
	pending := c.pending
	c.pending = make(map[int64]pendingCall)
	close(c.closedCh)
	c.mu.Unlock()

	_ = c.conn.Close()
	for _, call := range pending {
		call.ch <- cdpResponse{err: err}
	}
}

// IsConnected reports whether the underlying WebSocket is still open.
func (c *Client) IsConnected() bool {
	if c == nil {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.closed
}

// Closed returns a channel that closes when the CDP connection closes.
func (c *Client) Closed() <-chan struct{} {
	return c.closedCh
}

// Close closes the CDP WebSocket without closing Chrome or any of its tabs.
func (c *Client) Close() error {
	c.failAll(errors.New("browser disconnected: client closed"))
	return nil
}

// Subscribe registers an event callback. Pass sessionID="*" to match all sessions,
// sessionID="" to match browser-level events only, or an exact sessionID.
// Pass method="" to match all methods. Returns an unsubscribe function.
func (c *Client) Subscribe(sessionID, method string, fn func(Event)) func() {
	id := c.nextSubID.Add(1)
	c.mu.Lock()
	c.listeners[id] = listener{
		id:        id,
		sessionID: sessionID,
		method:    method,
		fn:        fn,
	}
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.listeners, id)
		c.mu.Unlock()
	}
}

// Call sends a CDP command on the browser session (sessionID == "") or a specific target session.
func (c *Client) Call(ctx context.Context, sessionID, method string, params any, out any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	id := c.nextID.Add(1)
	ch := make(chan cdpResponse, 1)

	c.mu.Lock()
	if c.closed {
		err := c.closeErr
		c.mu.Unlock()
		return err
	}
	c.pending[id] = pendingCall{ch: ch}
	c.mu.Unlock()

	req := cdpRequest{
		ID:        id,
		SessionID: sessionID,
		Method:    method,
		Params:    params,
	}
	payload, err := json.Marshal(req)
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return err
	}

	c.writeMu.Lock()
	err = c.conn.WriteMessage(websocket.TextMessage, payload)
	c.writeMu.Unlock()
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		c.failAll(err)
		return err
	}

	select {
	case resp := <-ch:
		if resp.err != nil {
			return resp.err
		}
		if out != nil && len(resp.result) > 0 {
			if err := json.Unmarshal(resp.result, out); err != nil {
				return fmt.Errorf("decoding CDP %s response: %w", method, err)
			}
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// CallRaw sends a CDP command and returns its raw JSON result.
func (c *Client) CallRaw(ctx context.Context, sessionID, method string, params any) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.Call(ctx, sessionID, method, params, &raw); err != nil {
		return nil, err
	}
	if len(raw) == 0 {
		return json.RawMessage(`{}`), nil
	}
	return raw, nil
}
