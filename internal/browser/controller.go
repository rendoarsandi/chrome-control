package browser

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/adb"
	"github.com/rendoarsandi/chrome-control/internal/cdp"
	"github.com/rendoarsandi/chrome-control/internal/config"
	"github.com/rendoarsandi/chrome-control/internal/errs"
	"github.com/rendoarsandi/chrome-control/internal/events"
	"github.com/rendoarsandi/chrome-control/internal/flow"
)

const defaultSnapshotKey = `{"filter":null,"format":"json","include_bbox":false,"roles":null,"scope":null,"viewport_only":false}`

// TargetInfo mirrors CDP Target.TargetInfo.
type TargetInfo struct {
	TargetID string `json:"targetId"`
	Type     string `json:"type"`
	Title    string `json:"title"`
	URL      string `json:"url"`
	OpenerID string `json:"openerId,omitempty"`
}

// FrameInfo tracks a frame inside an attached page.
type FrameInfo struct {
	ID       string
	ParentID string
	URL      string
	Name     string
}

// DialogInfo describes an open JavaScript alert/confirm/prompt.
type DialogInfo struct {
	Type         string `json:"type"`
	Message      string `json:"message"`
	DefaultValue string `json:"default_value"`
}

// FileChooserInfo holds an intercepted file chooser event.
type FileChooserInfo struct {
	FrameID       string
	BackendNodeID int
	Multiple      bool
}

// DownloadRecord tracks a download captured on a page.
type DownloadRecord struct {
	DownloadID        string `json:"download_id"`
	GUID              string `json:"-"`
	TabID             string `json:"tab_id"`
	URL               string `json:"url"`
	SuggestedFilename string `json:"suggested_filename"`
	Status            string `json:"status"`
	Path              string `json:"path,omitempty"`
	SavedPath         string `json:"saved_path,omitempty"`
	Error             string `json:"error,omitempty"`
	CreatedAt         int64  `json:"created_at"`
}

// RouteEntry describes an active request interception route on a page.
type RouteEntry struct {
	Pattern     string            `json:"pattern"`
	RouteAction string            `json:"route_action"`
	Status      int               `json:"status,omitempty"`
	ContentType string            `json:"content_type,omitempty"`
	Body        string            `json:"-"`
	BodyBytes   int               `json:"body_bytes,omitempty"`
	Headers     map[string]string `json:"headers,omitempty"`
	ErrorCode   string            `json:"error_code,omitempty"`
}

// PageState holds live state for an attached Chrome page target.
type PageState struct {
	TabID     string
	TargetID  string
	SessionID string

	mu            sync.Mutex
	mainFrameID   string
	frames        map[string]*FrameInfo
	frameOrder    []string
	frameContexts map[string]int // frameID -> default world executionContextId
	url           string
	title         string
	dialog        *DialogInfo
	dialogWaiters []chan struct{}
	fileChooser   *FileChooserInfo
	navListeners  []func(frameID string)
	downloads     []*DownloadRecord
	routes        []RouteEntry
	fetchEnabled  bool
	unsubs        []func()
	closed        bool
}

func (p *PageState) currentURL() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if f := p.frames[p.mainFrameID]; f != nil && f.URL != "" {
		return f.URL
	}
	return p.url
}

func (p *PageState) currentTitle() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.title != "" {
		return p.title
	}
	return "(loading)"
}

func (p *PageState) hasDialog() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.dialog != nil
}

func (p *PageState) getDialog() *DialogInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.dialog == nil {
		return nil
	}
	cp := *p.dialog
	return &cp
}

func (p *PageState) orderedFrames() []FrameInfo {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]FrameInfo, 0, len(p.frameOrder))
	seen := make(map[string]bool, len(p.frameOrder))
	if p.mainFrameID != "" {
		if mf := p.frames[p.mainFrameID]; mf != nil {
			out = append(out, *mf)
			seen[mf.ID] = true
		}
	}
	for _, id := range p.frameOrder {
		if seen[id] {
			continue
		}
		if f := p.frames[id]; f != nil {
			out = append(out, *f)
			seen[id] = true
		}
	}
	return out
}

func (p *PageState) frameByIndex(idx int) (FrameInfo, bool) {
	frames := p.orderedFrames()
	if idx < 0 || idx >= len(frames) {
		return FrameInfo{}, false
	}
	return frames[idx], true
}

func (p *PageState) contextIDForFrame(frameID string) int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.frameContexts[frameID]
}

func (p *PageState) addNavListener(fn func(string)) func() {
	p.mu.Lock()
	idx := len(p.navListeners)
	p.navListeners = append(p.navListeners, fn)
	p.mu.Unlock()
	return func() {
		p.mu.Lock()
		if idx < len(p.navListeners) {
			p.navListeners[idx] = nil
		}
		p.mu.Unlock()
	}
}

func (p *PageState) close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	unsubs := p.unsubs
	p.unsubs = nil
	p.mu.Unlock()
	for _, fn := range unsubs {
		fn()
	}
}

type refEntry struct {
	SessionID     string
	FrameID       string
	NodesObjectID string
	Index         int
	TabID         string
}

type snapshotFrameEntry struct {
	SessionID     string
	FrameID       string
	NodesObjectID string
	Stamp         string
	Labels        []string
}

// Options configures a BrowserController.
type Options struct {
	RepairForward bool
	FlowStore     *flow.Store
	ADBRunner     adb.Runner
}

// BrowserController manages a direct CDP connection to Chrome, tabs, snapshots, actions, and auxiliary tools.
type BrowserController struct {
	Config        config.Config
	FlowStore     *flow.Store
	adbRunner     adb.Runner
	repairForward bool

	prefix   string
	sequence atomic.Int64

	mu                sync.Mutex
	client            *cdp.Client
	stopped           bool
	selected          string
	pages             map[string]*PageState // tabID -> attached PageState
	tabInfo           map[string]TargetInfo // tabID -> latest TargetInfo
	tabOrder          []string              // deterministic tab ordering
	targetTabs        map[string]string     // targetID -> tabID
	refs              map[string]refEntry
	snapshotFrames    []snapshotFrameEntry
	lastSnapshot      map[string]any
	lastSnapshotByTab map[string]map[string]any
	snapshotFilterKey string
	snapshotCount     int
	eventStreams      map[string]*events.PageEvents // tabID -> stream
	flowCaptures      map[string]*flow.FlowCapture  // tabID -> capture
	downloadDir       string
	downloadsByGUID   map[string]*DownloadRecord
	globalUnsubs      []func()

	// Outcome tracks partial execution metadata for structured error reporting.
	Outcome map[string]any
}

// NewController creates a new BrowserController.
func NewController(cfg config.Config, opts Options) *BrowserController {
	var b [4]byte
	_, _ = rand.Read(b[:])
	fs := opts.FlowStore
	if fs == nil {
		fs = flow.NewStore(cfg.FlowDir)
	}
	return &BrowserController{
		Config:            cfg,
		FlowStore:         fs,
		adbRunner:         opts.ADBRunner,
		repairForward:     opts.RepairForward,
		prefix:            hex.EncodeToString(b[:]),
		pages:             make(map[string]*PageState),
		tabInfo:           make(map[string]TargetInfo),
		targetTabs:        make(map[string]string),
		refs:              make(map[string]refEntry),
		lastSnapshotByTab: make(map[string]map[string]any),
		snapshotFilterKey: defaultSnapshotKey,
		eventStreams:      make(map[string]*events.PageEvents),
		flowCaptures:      make(map[string]*flow.FlowCapture),
		downloadsByGUID:   make(map[string]*DownloadRecord),
		Outcome:           map[string]any{},
	}
}

// SnapshotCount returns the number of snapshots taken by this controller.
func (c *BrowserController) SnapshotCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.snapshotCount
}

// HasSelectedTab reports whether a tab is currently selected.
func (c *BrowserController) HasSelectedTab() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.selected != ""
}

// InvalidateLastSnapshot clears cached snapshot reuse without releasing DOM refs.
func (c *BrowserController) InvalidateLastSnapshot() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastSnapshot = nil
}

// IsConnected reports whether the underlying CDP client is connected.
func (c *BrowserController) IsConnected() bool {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	return cl != nil && cl.IsConnected()
}

func (c *BrowserController) assertActive() error {
	c.mu.Lock()
	stopped := c.stopped
	c.mu.Unlock()
	if stopped {
		return errs.New("CONNECTION_RESET", "This browser connection was reset.", "Call browser_status and select the intended tab again. Old element refs are invalid.", nil)
	}
	return nil
}

// NoteInput records that a mutating operation may have been sent to Chrome.
func (c *BrowserController) NoteInput(action, tabID string) error {
	if err := c.assertActive(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.Outcome["action"] == "batch" {
		c.Outcome["current_action"] = action
		c.Outcome["may_have_executed"] = true
	} else {
		m := map[string]any{
			"action":            action,
			"may_have_executed": true,
		}
		if tabID != "" {
			m["tab_id"] = tabID
		}
		c.Outcome = m
	}
	return nil
}

// SetOutcomeExecuted marks the current outcome as executed.
func (c *BrowserController) SetOutcomeExecuted() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Outcome["executed"] = true
}

// ResetOutcome resets the per-request outcome map.
func (c *BrowserController) ResetOutcome() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Outcome = map[string]any{}
}

// CopyOutcome returns a shallow copy of the current outcome map.
func (c *BrowserController) CopyOutcome() map[string]any {
	c.mu.Lock()
	defer c.mu.Unlock()
	cp := make(map[string]any, len(c.Outcome))
	for k, v := range c.Outcome {
		cp[k] = v
	}
	return cp
}

// Connect establishes (or reuses) the direct CDP WebSocket connection, running ADB recovery when configured.
func (c *BrowserController) Connect(ctx context.Context) (*cdp.Client, error) {
	if err := c.assertActive(); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.client != nil && c.client.IsConnected() {
		cl := c.client
		c.mu.Unlock()
		return cl, nil
	}
	c.mu.Unlock()

	c.clearStateLocked(false)

	dialOnce := func(timeout time.Duration) (*cdp.Client, error) {
		if err := c.assertActive(); err != nil {
			return nil, err
		}
		dctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return cdp.Dial(dctx, c.Config.Endpoint)
	}

	forwarded := false
	if c.repairForward && c.Config.AutoADB && adb.CanForward(c.Config.Endpoint) {
		if _, err := adb.ForwardChrome(ctx, c.Config, c.adbRunner, true); err != nil {
			return nil, err
		}
		forwarded = true
		c.repairForward = false
	}

	cl, err := dialOnce(5 * time.Second)
	if err != nil {
		if aerr := c.assertActive(); aerr != nil {
			return nil, aerr
		}
		if !c.Config.AutoADB {
			return nil, errs.New(
				"CDP_UNAVAILABLE",
				"Could not connect to Chrome: "+err.Error(),
				"Check CHROME_CDP_URL. For Android, keep Chrome foregrounded with the screen unlocked and forward its debugging socket with adb.",
				nil,
			)
		}
		if !forwarded {
			if _, ferr := adb.ForwardChrome(ctx, c.Config, c.adbRunner, false); ferr != nil {
				return nil, ferr
			}
		}
		until := time.Now().Add(6 * time.Second)
		lastErr := err
		for time.Now().Before(until) {
			if aerr := c.assertActive(); aerr != nil {
				return nil, aerr
			}
			rem := time.Until(until)
			if rem > 5*time.Second {
				rem = 5 * time.Second
			}
			if rem < 200*time.Millisecond {
				rem = 200 * time.Millisecond
			}
			cl, lastErr = dialOnce(rem)
			if lastErr == nil {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
		}
		if cl == nil {
			return nil, errs.New(
				"CDP_UNAVAILABLE",
				"ADB forwarding completed, but Chrome is still unreachable: "+lastErr.Error(),
				"Keep Chrome foregrounded with the screen unlocked, then call browser_status with reconnect: true. Check the current wireless debugging port and Chrome debugging socket.",
				map[string]any{"phase": "connecting", "endpoint": c.Config.Endpoint},
			)
		}
	}

	if err := c.assertActive(); err != nil {
		_ = cl.Close()
		return nil, err
	}

	dlDir, _ := os.MkdirTemp("", "chrome-control-downloads-*")
	c.mu.Lock()
	c.client = cl
	c.downloadDir = dlDir
	c.mu.Unlock()

	if dlDir != "" {
		bctx, cancel := context.WithTimeout(ctx, 1500*time.Millisecond)
		_ = cl.Call(bctx, "", "Browser.setDownloadBehavior", map[string]any{
			"behavior":      "allowAndName",
			"downloadPath":  dlDir,
			"eventsEnabled": true,
		}, nil)
		cancel()
	}

	unsubBegin := cl.Subscribe("*", "Browser.downloadWillBegin", c.onDownloadWillBegin)
	unsubProg := cl.Subscribe("*", "Browser.downloadProgress", c.onDownloadProgress)
	unsubPageBegin := cl.Subscribe("*", "Page.downloadWillBegin", c.onDownloadWillBegin)
	unsubPageProg := cl.Subscribe("*", "Page.downloadProgress", c.onDownloadProgress)
	c.mu.Lock()
	c.globalUnsubs = append(c.globalUnsubs, unsubBegin, unsubProg, unsubPageBegin, unsubPageProg)
	c.mu.Unlock()

	return cl, nil
}

func (c *BrowserController) onDownloadWillBegin(ev cdp.Event) {
	var p struct {
		FrameID           string `json:"frameId"`
		GUID              string `json:"guid"`
		URL               string `json:"url"`
		SuggestedFilename string `json:"suggestedFilename"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil || p.GUID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	var targetPage *PageState
	for _, ps := range c.pages {
		if ps.SessionID == ev.SessionID && ev.SessionID != "" {
			targetPage = ps
			break
		}
		ps.mu.Lock()
		_, hasFrame := ps.frames[p.FrameID]
		ps.mu.Unlock()
		if hasFrame {
			targetPage = ps
			break
		}
	}
	if targetPage == nil && c.selected != "" {
		targetPage = c.pages[c.selected]
	}
	tabID := ""
	if targetPage != nil {
		tabID = targetPage.TabID
	}
	rec := &DownloadRecord{
		DownloadID:        fmt.Sprintf("dl_%s_%d", c.prefix, c.sequence.Add(1)),
		GUID:              p.GUID,
		TabID:             tabID,
		URL:               p.URL,
		SuggestedFilename: p.SuggestedFilename,
		Status:            "pending",
		CreatedAt:         time.Now().UnixMilli(),
	}
	c.downloadsByGUID[p.GUID] = rec
	if targetPage != nil {
		targetPage.mu.Lock()
		targetPage.downloads = append(targetPage.downloads, rec)
		if len(targetPage.downloads) > 20 {
			targetPage.downloads = targetPage.downloads[len(targetPage.downloads)-20:]
		}
		targetPage.mu.Unlock()
	}
}

func (c *BrowserController) onDownloadProgress(ev cdp.Event) {
	var p struct {
		GUID  string `json:"guid"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil || p.GUID == "" {
		return
	}
	c.mu.Lock()
	rec := c.downloadsByGUID[p.GUID]
	dlDir := c.downloadDir
	c.mu.Unlock()
	if rec == nil {
		return
	}
	switch p.State {
	case "completed":
		rec.Status = "completed"
		if dlDir != "" {
			candidate := filepath.Join(dlDir, p.GUID)
			if _, err := os.Stat(candidate); err == nil {
				rec.Path = candidate
			}
		}
	case "canceled":
		rec.Status = "failed"
		rec.Error = "Download was canceled."
	}
}

// ClearRefs invalidates snapshot references and releases retained DOM nodes asynchronously.
func (c *BrowserController) ClearRefs() {
	c.mu.Lock()
	c.lastSnapshot = nil
	frames := c.snapshotFrames
	c.snapshotFrames = nil
	c.refs = make(map[string]refEntry)
	cl := c.client
	c.mu.Unlock()

	if cl != nil && cl.IsConnected() && len(frames) > 0 {
		seen := make(map[string]bool)
		for _, f := range frames {
			if seen[f.SessionID] {
				continue
			}
			seen[f.SessionID] = true
			sid := f.SessionID
			go func() {
				rctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
				defer cancel()
				_ = cl.Call(rctx, sid, "Runtime.releaseObjectGroup", map[string]any{"objectGroup": "chrome-control-refs"}, nil)
			}()
		}
	}
}

func (c *BrowserController) clearStateLocked(markStopped bool) {
	c.mu.Lock()
	if markStopped {
		c.stopped = true
	}
	cl := c.client
	c.client = nil
	unsubs := c.globalUnsubs
	c.globalUnsubs = nil
	pages := c.pages
	c.pages = make(map[string]*PageState)
	streams := c.eventStreams
	c.eventStreams = make(map[string]*events.PageEvents)
	captures := c.flowCaptures
	c.flowCaptures = make(map[string]*flow.FlowCapture)
	c.tabInfo = make(map[string]TargetInfo)
	c.tabOrder = nil
	c.targetTabs = make(map[string]string)
	c.refs = make(map[string]refEntry)
	c.snapshotFrames = nil
	c.lastSnapshot = nil
	c.lastSnapshotByTab = make(map[string]map[string]any)
	c.selected = ""
	c.downloadsByGUID = make(map[string]*DownloadRecord)
	dlDir := c.downloadDir
	c.downloadDir = ""
	c.mu.Unlock()

	for _, fn := range unsubs {
		fn()
	}
	for _, s := range streams {
		s.Close()
	}
	for _, fc := range captures {
		fc.Close()
	}
	for _, ps := range pages {
		ps.close()
	}
	if cl != nil {
		_ = cl.Close()
	}
	if dlDir != "" {
		_ = os.RemoveAll(dlDir)
	}
}

// Disconnect closes the CDP WebSocket while preserving Chrome and all open tabs.
func (c *BrowserController) Disconnect() {
	c.clearStateLocked(true)
}

// SyncPages queries browser target metadata without attaching to background renderers.
func (c *BrowserController) SyncPages(ctx context.Context) ([]TargetInfo, error) {
	cl, err := c.Connect(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.assertActive(); err != nil {
		return nil, err
	}
	tctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	var res struct {
		TargetInfos []TargetInfo `json:"targetInfos"`
	}
	if err := cl.Call(tctx, "", "Target.getTargets", nil, &res); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errs.New("SESSION_TIMEOUT", "Chrome did not answer a browser metadata request.", "Call browser_status with reconnect: true. Keep Chrome foregrounded and the screen unlocked.", nil)
		}
		return nil, err
	}
	if err := c.assertActive(); err != nil {
		return nil, err
	}

	available := make([]TargetInfo, 0, len(res.TargetInfos))
	liveTargets := make(map[string]bool)
	for _, info := range res.TargetInfos {
		if info.Type == "page" && info.URL != "" && info.URL != ":" {
			available = append(available, info)
			liveTargets[info.TargetID] = true
		}
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	for targetID, tabID := range c.targetTabs {
		if !liveTargets[targetID] {
			delete(c.targetTabs, targetID)
			delete(c.tabInfo, tabID)
			if ps, ok := c.pages[tabID]; ok {
				ps.close()
				delete(c.pages, tabID)
			}
			delete(c.lastSnapshotByTab, tabID)
			if st, ok := c.eventStreams[tabID]; ok {
				st.Close()
				delete(c.eventStreams, tabID)
			}
			if fc, ok := c.flowCaptures[tabID]; ok {
				fc.Close()
				delete(c.flowCaptures, tabID)
			}
		}
	}

	var newOrder []string
	seenTab := make(map[string]bool)
	for _, existing := range c.tabOrder {
		if _, ok := c.tabInfo[existing]; ok {
			newOrder = append(newOrder, existing)
			seenTab[existing] = true
		}
	}

	for _, info := range available {
		tabID, ok := c.targetTabs[info.TargetID]
		if !ok {
			tabID = fmt.Sprintf("tab_%s_%d", c.prefix, c.sequence.Add(1))
			c.targetTabs[info.TargetID] = tabID
		}
		c.tabInfo[tabID] = info
		if !seenTab[tabID] {
			newOrder = append(newOrder, tabID)
			seenTab[tabID] = true
		}
		if ps, ok := c.pages[tabID]; ok {
			ps.mu.Lock()
			if info.URL != "" {
				ps.url = info.URL
			}
			if info.Title != "" {
				ps.title = info.Title
			}
			ps.mu.Unlock()
		}
	}
	c.tabOrder = newOrder

	if _, ok := c.tabInfo[c.selected]; !ok {
		c.selected = ""
	}
	if len(c.tabInfo) == 1 && c.selected == "" {
		c.selected = c.tabOrder[0]
	}

	out := make([]TargetInfo, 0, len(c.tabOrder))
	for _, id := range c.tabOrder {
		out = append(out, c.tabInfo[id])
	}
	return out, nil
}

// TabSummary is the public representation of an open Chrome tab.
type TabSummary struct {
	TabID    string `json:"tab_id"`
	URL      string `json:"url"`
	Title    string `json:"title"`
	Selected bool   `json:"selected"`
}

// Tabs lists all usable Chrome page tabs with explicit IDs.
func (c *BrowserController) Tabs(ctx context.Context) ([]TabSummary, error) {
	if _, err := c.SyncPages(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	tabs := make([]TabSummary, 0, len(c.tabOrder))
	for _, id := range c.tabOrder {
		info := c.tabInfo[id]
		title := info.Title
		if ps, ok := c.pages[id]; ok && ps.hasDialog() {
			title = "(dialog open)"
		} else if title == "" {
			title = "(loading)"
		}
		tabs = append(tabs, TabSummary{
			TabID:    id,
			URL:      info.URL,
			Title:    title,
			Selected: c.selected == id,
		})
	}
	return tabs, nil
}

// Page resolves and lazily attaches to the requested tab (or the selected tab).
func (c *BrowserController) Page(ctx context.Context, tabID string, activate bool) (*PageState, string, error) {
	live, err := c.SyncPages(ctx)
	if err != nil {
		return nil, "", err
	}
	c.mu.Lock()
	id := tabID
	if id == "" {
		id = c.selected
	}
	info, exists := c.tabInfo[id]
	ps := c.pages[id]
	cl := c.client
	c.mu.Unlock()

	if id == "" || !exists {
		var tabs []TabSummary
		if len(live) > 0 {
			tabs, _ = c.Tabs(ctx)
		}
		if len(tabs) > 0 {
			return nil, "", errs.New(
				"TAB_SELECTION_REQUIRED",
				"Select a tab explicitly before controlling it.",
				"Call browser_tabs, then browser_select_tab with a tab_id. You can also pass tab_id to a tool.",
				map[string]any{"tabs": tabs},
			)
		}
		return nil, "", errs.New(
			"NO_TABS",
			"Chrome has no open web page targets.",
			"Open a tab in Chrome or call browser_new_tab.",
			map[string]any{"tabs": []TabSummary{}},
		)
	}

	if activate || ps == nil {
		actx, cancel := context.WithTimeout(ctx, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
		err := cl.Call(actx, "", "Target.activateTarget", map[string]any{"targetId": info.TargetID}, nil)
		cancel()
		if err != nil {
			return nil, "", err
		}
		if err := c.assertActive(); err != nil {
			return nil, "", err
		}
	}

	if ps == nil {
		attached, err := c.attachPage(ctx, id, info)
		if err != nil {
			return nil, "", err
		}
		ps = attached
	}
	return ps, id, nil
}

func (c *BrowserController) attachPage(ctx context.Context, tabID string, info TargetInfo) (*PageState, error) {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if cl == nil {
		return nil, errs.New("CDP_UNAVAILABLE", "Not connected to Chrome.", "Call browser_status to reconnect.", nil)
	}

	actx, cancel := context.WithTimeout(ctx, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
	defer cancel()

	var attachRes struct {
		SessionID string `json:"sessionId"`
	}
	if err := cl.Call(actx, "", "Target.attachToTarget", map[string]any{
		"targetId": info.TargetID,
		"flatten":  true,
	}, &attachRes); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, errs.New("SESSION_TIMEOUT", "The selected tab did not initialize before the deadline.", "Keep Chrome foregrounded and the screen unlocked, then reconnect and select the intended tab. Other tabs have not been closed.", map[string]any{"tab_id": tabID})
		}
		return nil, err
	}

	ps := &PageState{
		TabID:         tabID,
		TargetID:      info.TargetID,
		SessionID:     attachRes.SessionID,
		frames:        make(map[string]*FrameInfo),
		frameContexts: make(map[string]int),
		url:           info.URL,
		title:         info.Title,
	}

	c.subscribePageEvents(cl, ps)

	if err := cl.Call(actx, ps.SessionID, "Page.enable", nil, nil); err != nil {
		ps.close()
		return nil, err
	}
	if err := cl.Call(actx, ps.SessionID, "Runtime.enable", nil, nil); err != nil {
		ps.close()
		return nil, err
	}
	_ = cl.Call(actx, ps.SessionID, "DOM.enable", nil, nil)

	var treeRes struct {
		FrameTree frameTreeNode `json:"frameTree"`
	}
	if err := cl.Call(actx, ps.SessionID, "Page.getFrameTree", nil, &treeRes); err == nil {
		ps.mu.Lock()
		ps.mainFrameID = treeRes.FrameTree.Frame.ID
		var walk func(node frameTreeNode)
		walk = func(node frameTreeNode) {
			f := &FrameInfo{
				ID:       node.Frame.ID,
				ParentID: node.Frame.ParentID,
				URL:      node.Frame.URL,
				Name:     node.Frame.Name,
			}
			ps.frames[f.ID] = f
			ps.frameOrder = append(ps.frameOrder, f.ID)
			for _, child := range node.ChildFrames {
				walk(child)
			}
		}
		walk(treeRes.FrameTree)
		if mf := ps.frames[ps.mainFrameID]; mf != nil && mf.URL != "" {
			ps.url = mf.URL
		}
		ps.mu.Unlock()
	}

	c.mu.Lock()
	c.pages[tabID] = ps
	c.mu.Unlock()
	return ps, nil
}

type frameTreeNode struct {
	Frame struct {
		ID       string `json:"id"`
		ParentID string `json:"parentId"`
		URL      string `json:"url"`
		Name     string `json:"name"`
	} `json:"frame"`
	ChildFrames []frameTreeNode `json:"childFrames"`
}

func (c *BrowserController) subscribePageEvents(cl *cdp.Client, ps *PageState) {
	sid := ps.SessionID

	ps.unsubs = append(ps.unsubs,
		cl.Subscribe(sid, "Runtime.executionContextCreated", func(ev cdp.Event) {
			var p struct {
				Context struct {
					ID      int `json:"id"`
					AuxData struct {
						IsDefault bool   `json:"isDefault"`
						FrameID   string `json:"frameId"`
					} `json:"auxData"`
				} `json:"context"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil && p.Context.AuxData.IsDefault && p.Context.AuxData.FrameID != "" {
				ps.mu.Lock()
				ps.frameContexts[p.Context.AuxData.FrameID] = p.Context.ID
				ps.mu.Unlock()
			}
		}),
		cl.Subscribe(sid, "Runtime.executionContextDestroyed", func(ev cdp.Event) {
			var p struct {
				ExecutionContextID int `json:"executionContextId"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil {
				ps.mu.Lock()
				for fid, cid := range ps.frameContexts {
					if cid == p.ExecutionContextID {
						delete(ps.frameContexts, fid)
					}
				}
				ps.mu.Unlock()
			}
		}),
		cl.Subscribe(sid, "Runtime.executionContextsCleared", func(ev cdp.Event) {
			ps.mu.Lock()
			ps.frameContexts = make(map[string]int)
			ps.mu.Unlock()
		}),
		cl.Subscribe(sid, "Page.frameAttached", func(ev cdp.Event) {
			var p struct {
				FrameID       string `json:"frameId"`
				ParentFrameID string `json:"parentFrameId"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil && p.FrameID != "" {
				ps.mu.Lock()
				if _, ok := ps.frames[p.FrameID]; !ok {
					ps.frames[p.FrameID] = &FrameInfo{ID: p.FrameID, ParentID: p.ParentFrameID}
					ps.frameOrder = append(ps.frameOrder, p.FrameID)
				}
				ps.mu.Unlock()
			}
		}),
		cl.Subscribe(sid, "Page.frameNavigated", func(ev cdp.Event) {
			var p struct {
				Frame struct {
					ID       string `json:"id"`
					ParentID string `json:"parentId"`
					URL      string `json:"url"`
					Name     string `json:"name"`
				} `json:"frame"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil && p.Frame.ID != "" {
				ps.mu.Lock()
				f := &FrameInfo{
					ID:       p.Frame.ID,
					ParentID: p.Frame.ParentID,
					URL:      p.Frame.URL,
					Name:     p.Frame.Name,
				}
				if _, exists := ps.frames[f.ID]; !exists {
					ps.frameOrder = append(ps.frameOrder, f.ID)
				}
				ps.frames[f.ID] = f
				if p.Frame.ParentID == "" {
					ps.mainFrameID = f.ID
					ps.url = f.URL
				}
				listeners := append(([]func(string))(nil), ps.navListeners...)
				ps.mu.Unlock()
				for _, fn := range listeners {
					if fn != nil {
						fn(f.ID)
					}
				}
			}
		}),
		cl.Subscribe(sid, "Page.frameDetached", func(ev cdp.Event) {
			var p struct {
				FrameID string `json:"frameId"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil && p.FrameID != "" {
				ps.mu.Lock()
				delete(ps.frames, p.FrameID)
				delete(ps.frameContexts, p.FrameID)
				ps.mu.Unlock()
			}
		}),
		cl.Subscribe(sid, "Page.javascriptDialogOpening", func(ev cdp.Event) {
			var p struct {
				Type          string `json:"type"`
				Message       string `json:"message"`
				DefaultPrompt string `json:"defaultPrompt"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil {
				ps.mu.Lock()
				ps.dialog = &DialogInfo{
					Type:         p.Type,
					Message:      p.Message,
					DefaultValue: p.DefaultPrompt,
				}
				waiters := ps.dialogWaiters
				ps.dialogWaiters = nil
				ps.mu.Unlock()
				for _, ch := range waiters {
					close(ch)
				}
			}
		}),
		cl.Subscribe(sid, "Page.javascriptDialogClosed", func(ev cdp.Event) {
			ps.mu.Lock()
			ps.dialog = nil
			ps.mu.Unlock()
		}),
		cl.Subscribe(sid, "Page.fileChooserOpened", func(ev cdp.Event) {
			var p struct {
				FrameID       string `json:"frameId"`
				BackendNodeID int    `json:"backendNodeId"`
				Mode          string `json:"mode"`
			}
			if err := json.Unmarshal(ev.Params, &p); err == nil {
				ps.mu.Lock()
				ps.fileChooser = &FileChooserInfo{
					FrameID:       p.FrameID,
					BackendNodeID: p.BackendNodeID,
					Multiple:      p.Mode == "selectMultiple",
				}
				ps.mu.Unlock()
			}
		}),
		cl.Subscribe(sid, "Fetch.requestPaused", func(ev cdp.Event) {
			go c.handleFetchPaused(cl, ps, ev)
		}),
	)
}

// SelectTab activates and selects a specific tab, returning its fresh snapshot.
func (c *BrowserController) SelectTab(ctx context.Context, tabID string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, true)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	c.selected = id
	c.mu.Unlock()

	_ = cl.Call(ctx, ps.SessionID, "Page.bringToFront", nil, nil)
	return c.Snapshot(ctx, SnapshotOptions{TabID: id})
}

// NewTab opens a new tab at url, activates it, and returns its snapshot.
func (c *BrowserController) NewTab(ctx context.Context, targetURL string) (map[string]any, error) {
	if targetURL == "" {
		targetURL = "about:blank"
	}
	cl, err := c.Connect(ctx)
	if err != nil {
		return nil, err
	}
	if err := c.NoteInput("new_tab", ""); err != nil {
		return nil, err
	}
	var createRes struct {
		TargetID string `json:"targetId"`
	}
	if err := cl.Call(ctx, "", "Target.createTarget", map[string]any{"url": targetURL}, &createRes); err != nil {
		return nil, err
	}
	c.SetOutcomeExecuted()
	_ = cl.Call(ctx, "", "Target.activateTarget", map[string]any{"targetId": createRes.TargetID}, nil)

	deadline := time.Now().Add(time.Duration(c.Config.ActionTimeout) * time.Millisecond)
	var tabID string
	for time.Now().Before(deadline) {
		if _, err := c.SyncPages(ctx); err != nil {
			return nil, err
		}
		c.mu.Lock()
		tabID = c.targetTabs[createRes.TargetID]
		c.mu.Unlock()
		if tabID != "" {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	if tabID == "" {
		return nil, errs.New(
			"SESSION_TIMEOUT",
			"Chrome created a tab, but did not expose its page before the deadline.",
			"Call browser_status and inspect the tab list before trying again. Keep Chrome foregrounded and the screen unlocked.",
			map[string]any{"target_id": createRes.TargetID},
		)
	}
	c.mu.Lock()
	c.selected = tabID
	c.Outcome["tab_id"] = tabID
	c.Outcome["executed"] = true
	c.mu.Unlock()

	ps, id, err := c.Page(ctx, tabID, true)
	if err != nil {
		return nil, err
	}
	if targetURL != "about:blank" {
		_ = c.waitForDocumentReady(ctx, ps, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
	}
	_ = cl.Call(ctx, ps.SessionID, "Page.bringToFront", nil, nil)
	return c.Snapshot(ctx, SnapshotOptions{TabID: id})
}

// CloseTab closes only the specified tab and returns remaining tabs.
func (c *BrowserController) CloseTab(ctx context.Context, tabID string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	c.ClearRefs()
	if err := c.NoteInput("close_tab", id); err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if err := cl.Call(ctx, "", "Target.closeTarget", map[string]any{"targetId": ps.TargetID}, nil); err != nil {
		return nil, err
	}
	c.SetOutcomeExecuted()
	time.Sleep(50 * time.Millisecond)
	tabs, err := c.Tabs(ctx)
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"closed_tab_id": id,
		"tabs":          tabs,
	}, nil
}

// HandleDialog accepts or dismisses a pending JavaScript dialog and returns a fresh snapshot.
func (c *BrowserController) HandleDialog(ctx context.Context, tabID string, accept bool, promptText *string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	dlg := ps.getDialog()
	if dlg == nil {
		return nil, errs.New("NO_DIALOG", "There is no pending JavaScript dialog in this tab.", "Call browser_snapshot to inspect the page.", nil)
	}
	if err := c.NoteInput("handle_dialog", id); err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	params := map[string]any{"accept": accept}
	if promptText != nil {
		params["promptText"] = *promptText
	}
	if err := cl.Call(ctx, ps.SessionID, "Page.handleJavaScriptDialog", params, nil); err != nil {
		return nil, err
	}
	ps.mu.Lock()
	ps.dialog = nil
	ps.mu.Unlock()
	c.SetOutcomeExecuted()

	time.Sleep(250 * time.Millisecond)
	snap, err := c.Snapshot(ctx, SnapshotOptions{TabID: id})
	if err != nil {
		return nil, err
	}
	return map[string]any{
		"accepted": accept,
		"snapshot": snap,
	}, nil
}

// ResolveRef resolves a snapshot element ref to a live CDP RemoteObject objectId + frameID.
func (c *BrowserController) ResolveRef(ctx context.Context, ref string, ps *PageState) (objectID string, frameID string, err error) {
	c.mu.Lock()
	entry, ok := c.refs[ref]
	cl := c.client
	c.mu.Unlock()
	if !ok || entry.TabID != ps.TabID {
		return "", "", errs.New("STALE_REF", "The element reference is outdated or belongs to another tab.", "Call browser_snapshot on the intended tab and use a ref from that result.", nil)
	}
	var res struct {
		Result struct {
			Type     string `json:"type"`
			Subtype  string `json:"subtype"`
			ObjectID string `json:"objectId"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text string `json:"text"`
		} `json:"exceptionDetails"`
	}
	err = cl.Call(ctx, entry.SessionID, "Runtime.callFunctionOn", map[string]any{
		"objectId":            entry.NodesObjectID,
		"functionDeclaration": `function(i) { const n = this[i]; return n && n.isConnected ? n : null; }`,
		"arguments":           []map[string]any{{"value": entry.Index}},
		"returnByValue":       false,
		"objectGroup":         "chrome-control-target",
	}, &res)
	if err != nil || res.ExceptionDetails != nil || res.Result.Subtype == "null" || res.Result.ObjectID == "" {
		return "", "", errs.New("STALE_REF", "The element was removed or the page navigated.", "Call browser_snapshot and choose a fresh reference.", nil)
	}
	return res.Result.ObjectID, entry.FrameID, nil
}

func (c *BrowserController) releaseObject(sessionID, objectID string) {
	if objectID == "" {
		return
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if cl == nil || !cl.IsConnected() {
		return
	}
	go func() {
		rctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
		defer cancel()
		_ = cl.Call(rctx, sessionID, "Runtime.releaseObject", map[string]any{"objectId": objectID}, nil)
	}()
}

// evalInFrame evaluates a JS expression in a frame's default execution context.
func (c *BrowserController) evalInFrame(ctx context.Context, ps *PageState, frameID, expression string, returnByValue, awaitPromise bool, objectGroup string) (json.RawMessage, string, error) {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	params := map[string]any{
		"expression":    expression,
		"returnByValue": returnByValue,
		"awaitPromise":  awaitPromise,
	}
	if objectGroup != "" {
		params["objectGroup"] = objectGroup
	}
	if frameID != "" && frameID != ps.mainFrameID {
		if ctxID := ps.contextIDForFrame(frameID); ctxID > 0 {
			params["contextId"] = ctxID
		} else {
			return nil, "", fmt.Errorf("frame execution context not available for %s", frameID)
		}
	} else if ctxID := ps.contextIDForFrame(ps.mainFrameID); ctxID > 0 {
		params["contextId"] = ctxID
	}

	var res struct {
		Result struct {
			Type        string          `json:"type"`
			Subtype     string          `json:"subtype"`
			Value       json.RawMessage `json:"value"`
			ObjectID    string          `json:"objectId"`
			Description string          `json:"description"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception *struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := cl.Call(ctx, ps.SessionID, "Runtime.evaluate", params, &res); err != nil {
		return nil, "", err
	}
	if res.ExceptionDetails != nil {
		msg := res.ExceptionDetails.Text
		if res.ExceptionDetails.Exception != nil && res.ExceptionDetails.Exception.Description != "" {
			msg = res.ExceptionDetails.Exception.Description
		}
		return nil, "", errors.New(msg)
	}
	return res.Result.Value, res.Result.ObjectID, nil
}

// callOnObject invokes a JS function on a retained CDP RemoteObject.
func (c *BrowserController) callOnObject(ctx context.Context, sessionID, objectID, fnDecl string, args []any, returnByValue, awaitPromise bool, objectGroup string) (json.RawMessage, string, error) {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	cdpArgs := make([]map[string]any, 0, len(args))
	for _, a := range args {
		cdpArgs = append(cdpArgs, map[string]any{"value": a})
	}
	params := map[string]any{
		"objectId":            objectID,
		"functionDeclaration": fnDecl,
		"arguments":           cdpArgs,
		"returnByValue":       returnByValue,
		"awaitPromise":        awaitPromise,
	}
	if objectGroup != "" {
		params["objectGroup"] = objectGroup
	}
	var res struct {
		Result struct {
			Type     string          `json:"type"`
			Subtype  string          `json:"subtype"`
			Value    json.RawMessage `json:"value"`
			ObjectID string          `json:"objectId"`
		} `json:"result"`
		ExceptionDetails *struct {
			Text      string `json:"text"`
			Exception *struct {
				Description string `json:"description"`
			} `json:"exception"`
		} `json:"exceptionDetails"`
	}
	if err := cl.Call(ctx, sessionID, "Runtime.callFunctionOn", params, &res); err != nil {
		return nil, "", err
	}
	if res.ExceptionDetails != nil {
		msg := res.ExceptionDetails.Text
		if res.ExceptionDetails.Exception != nil && res.ExceptionDetails.Exception.Description != "" {
			msg = res.ExceptionDetails.Exception.Description
		}
		return nil, "", errors.New(msg)
	}
	return res.Result.Value, res.Result.ObjectID, nil
}

func (c *BrowserController) waitForDocumentReady(ctx context.Context, ps *PageState, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		tctx, cancel := context.WithTimeout(ctx, 1000*time.Millisecond)
		raw, _, err := c.evalInFrame(tctx, ps, ps.mainFrameID, `document.readyState`, true, false, "")
		cancel()
		if err == nil {
			var state string
			if json.Unmarshal(raw, &state) == nil && (state == "interactive" || state == "complete") {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return nil
}

func (c *BrowserController) untilDialog(ctx context.Context, ps *PageState, fn func() error) error {
	ch := make(chan struct{})
	ps.mu.Lock()
	if ps.dialog != nil {
		ps.mu.Unlock()
		return nil
	}
	ps.dialogWaiters = append(ps.dialogWaiters, ch)
	ps.mu.Unlock()

	errCh := make(chan error, 1)
	go func() {
		errCh <- fn()
	}()

	select {
	case err := <-errCh:
		return err
	case <-ch:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func isContextDestroyedErr(err error) bool {
	if err == nil {
		return false
	}
	s := strings.ToLower(err.Error())
	return strings.Contains(s, "context") || strings.Contains(s, "navigation") || strings.Contains(s, "detached")
}
