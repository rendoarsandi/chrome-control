package browser

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/cdp"
	"github.com/rendoarsandi/chrome-control/internal/dom"
	"github.com/rendoarsandi/chrome-control/internal/errs"
	"github.com/rendoarsandi/chrome-control/internal/events"
	"github.com/rendoarsandi/chrome-control/internal/flow"
	"github.com/rendoarsandi/chrome-control/internal/media"
)

var uploadMimeTypes = map[string]string{
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
	".webp": "image/webp", ".svg": "image/svg+xml", ".bmp": "image/bmp", ".ico": "image/x-icon",
	".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
	".json": "application/json", ".xml": "application/xml", ".html": "text/html", ".htm": "text/html",
	".rtf": "application/rtf", ".zip": "application/zip", ".gz": "application/gzip", ".tar": "application/x-tar",
	".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".m4a": "audio/mp4",
	".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
}

// Upload attaches local host files to a file_input ref or intercepted file chooser via DataTransfer.
func (c *BrowserController) Upload(ctx context.Context, tabID, ref string, paths []string, waitFor *WaitCondition, includeSnapshot bool) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is blocking this tab.", "Call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}

	ps.mu.Lock()
	chooser := ps.fileChooser
	ps.mu.Unlock()

	var targetObjID string
	if ref != "" {
		targetObjID, _, err = c.ResolveRef(ctx, ref, ps)
		if err != nil {
			return nil, err
		}
		defer c.releaseObject(ps.SessionID, targetObjID)
	} else {
		if chooser == nil {
			return nil, errs.New("FILE_INPUT_REQUIRED", "No file input reference or intercepted file chooser is available.", "Use a file_input ref from browser_snapshot or click Browse files, then call browser_upload.", nil)
		}
		c.mu.Lock()
		cl := c.client
		c.mu.Unlock()
		var resolved struct {
			Object struct {
				ObjectID string `json:"objectId"`
			} `json:"object"`
		}
		if err := cl.Call(ctx, ps.SessionID, "DOM.resolveNode", map[string]any{
			"backendNodeId": chooser.BackendNodeID,
			"objectGroup":   "chrome-control-target",
		}, &resolved); err != nil || resolved.Object.ObjectID == "" {
			return nil, errs.New("FILE_INPUT_REQUIRED", "The intercepted file input is no longer available.", "Click Browse files again or use a file_input ref from browser_snapshot.", nil)
		}
		targetObjID = resolved.Object.ObjectID
		defer c.releaseObject(ps.SessionID, targetObjID)
	}

	rawCheck, _, err := c.callOnObject(ctx, ps.SessionID, targetObjID, `function() {
		return { file: this.tagName === 'INPUT' && this.type === 'file', multiple: Boolean(this.multiple), attached: Boolean(this.isConnected) };
	}`, nil, true, false, "")
	if err != nil {
		return nil, err
	}
	var chk struct {
		File     bool `json:"file"`
		Multiple bool `json:"multiple"`
		Attached bool `json:"attached"`
	}
	if err := json.Unmarshal(rawCheck, &chk); err != nil || !chk.File || !chk.Attached {
		return nil, errs.New("FILE_INPUT_REQUIRED", "The upload target is not a connected file input.", "Inspect a fresh snapshot and choose the correct file_input ref.", nil)
	}
	if len(paths) > 1 && !chk.Multiple {
		return nil, errs.New("FILE_COUNT_INVALID", "This input accepts only one file.", "Provide one file path for this upload control.", nil)
	}

	var total int64
	payloadFiles := make([]map[string]any, 0, len(paths))
	metaFiles := make([]map[string]any, 0, len(paths))
	for _, p := range paths {
		if !filepath.IsAbs(p) {
			return nil, errs.New("UPLOAD_PATH_INVALID", "Upload paths must be absolute local paths.", "Use the full path on the machine running the MCP server.", nil)
		}
		info, err := os.Stat(p)
		if err != nil {
			return nil, errs.New("UPLOAD_FILE_UNAVAILABLE", "Cannot read local file: "+p, "Check the path and file permissions on the MCP server host.", nil)
		}
		total += info.Size()
		if !info.Mode().IsRegular() || info.Size() > 20*1024*1024 || total > 50*1024*1024 {
			return nil, errs.New("UPLOAD_FILE_LIMIT", "Uploads require regular files up to 20 MiB each and 50 MiB total.", "Choose smaller files and upload at most ten files per call.", nil)
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return nil, errs.New("UPLOAD_FILE_UNAVAILABLE", "Cannot read local file: "+p, "Check the path and file permissions on the MCP server host.", nil)
		}
		if int64(len(data)) != info.Size() {
			return nil, errs.New("UPLOAD_FILE_CHANGED", "An upload file changed while being read.", "Finish saving the file before uploading it.", nil)
		}
		mime := uploadMimeTypes[strings.ToLower(filepath.Ext(p))]
		if mime == "" {
			mime = "application/octet-stream"
		}
		payloadFiles = append(payloadFiles, map[string]any{
			"name":     filepath.Base(p),
			"mimeType": mime,
			"base64":   base64.StdEncoding.EncodeToString(data),
		})
		metaFiles = append(metaFiles, map[string]any{
			"name": filepath.Base(p),
			"size": len(data),
		})
	}

	if err := c.NoteInput("upload", id); err != nil {
		return nil, err
	}
	rawRes, _, err := c.callOnObject(ctx, ps.SessionID, targetObjID, dom.UploadFilesJS, []any{payloadFiles}, true, false, "")
	if err != nil {
		return nil, err
	}
	var upRes struct {
		OK bool `json:"ok"`
	}
	if json.Unmarshal(rawRes, &upRes) != nil || !upRes.OK {
		return nil, errs.New("UPLOAD_FAILED", "Could not attach files to the input element.", "Inspect a fresh snapshot and retry.", nil)
	}
	c.SetOutcomeExecuted()
	ps.mu.Lock()
	ps.fileChooser = nil
	ps.mu.Unlock()
	c.ClearRefs()

	return c.Observe(ctx, ps, id, map[string]any{
		"action":   "upload",
		"executed": true,
		"files":    metaFiles,
	}, waitFor, false, includeSnapshot, ObserveMeta{})
}

// ScreenshotOptions configures BrowserController.Screenshot.
type ScreenshotOptions struct {
	TabID    string
	Ref      string
	Full     bool
	MaxDim   int
	Annotate bool
}

// Screenshot captures a JPEG viewport, full-page, or element crop screenshot with optional Set-of-Marks badges.
func (c *BrowserController) Screenshot(ctx context.Context, opts ScreenshotOptions) (dataBase64 string, meta map[string]any, err error) {
	ps, id, err := c.Page(ctx, opts.TabID, false)
	if err != nil {
		return "", nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return "", nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is open in this tab.", "Read browser_snapshot, then call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}
	if opts.Ref != "" && opts.Full {
		return "", nil, errs.New("SCREENSHOT_SCOPE_INVALID", "Choose an element crop or a full page screenshot.", "Use ref for a crop, or full: true without ref.", nil)
	}

	var clip map[string]float64
	if opts.Ref != "" {
		targetObjID, targetFrameID, err := c.ResolveRef(ctx, opts.Ref, ps)
		if err != nil {
			return "", nil, err
		}
		defer c.releaseObject(ps.SessionID, targetObjID)
		rawBox, _, err := c.callOnObject(ctx, ps.SessionID, targetObjID, `function() {
			this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
			const b = this.getBoundingClientRect();
			return { x: b.x, y: b.y, width: b.width, height: b.height, vw: innerWidth, vh: innerHeight };
		}`, nil, true, false, "")
		if err != nil {
			return "", nil, err
		}
		var b struct {
			X      float64 `json:"x"`
			Y      float64 `json:"y"`
			Width  float64 `json:"width"`
			Height float64 `json:"height"`
			VW     float64 `json:"vw"`
			VH     float64 `json:"vh"`
		}
		if err := json.Unmarshal(rawBox, &b); err != nil {
			return "", nil, err
		}
		if targetFrameID != "" && targetFrameID != ps.mainFrameID {
			if ox, oy, oerr := c.frameViewportOffset(ctx, ps, targetFrameID, b.X+b.Width/2, b.Y+b.Height/2); oerr == nil {
				b.X += ox
				b.Y += oy
			}
		}
		x := math.Max(0, b.X)
		y := math.Max(0, b.Y)
		w := math.Min(b.VW, b.X+b.Width) - x
		h := math.Min(b.VH, b.Y+b.Height) - y
		if w <= 0 || h <= 0 {
			return "", nil, errs.New("ELEMENT_NOT_VISIBLE", "The screenshot target has no visible viewport area.", "Scroll its parent into view and inspect a fresh snapshot.", nil)
		}
		clip = map[string]float64{"x": x, "y": y, "width": w, "height": h}
	}

	var annotatedFrames []snapshotFrameEntry
	annotatedMeta := map[string]any{}
	defer func() {
		for _, entry := range annotatedFrames {
			uctx, cancel := context.WithTimeout(context.Background(), 1000*time.Millisecond)
			_, _, _ = c.evalInFrame(uctx, ps, entry.FrameID, "("+dom.UnmountAnnotationsJS+")()", true, false, "")
			cancel()
		}
	}()

	if opts.Annotate {
		c.mu.Lock()
		needSnap := c.lastSnapshot == nil || c.lastSnapshot["tab_id"] != id || len(c.snapshotFrames) == 0
		c.mu.Unlock()
		if needSnap {
			if _, err := c.Snapshot(ctx, SnapshotOptions{TabID: id}); err != nil {
				return "", nil, err
			}
		}
		c.mu.Lock()
		frames := append([]snapshotFrameEntry(nil), c.snapshotFrames...)
		snapID := ""
		if c.lastSnapshot != nil {
			snapID, _ = c.lastSnapshot["snapshot_id"].(string)
		}
		c.mu.Unlock()
		totalCount := 0
		for _, entry := range frames {
			if len(entry.Labels) == 0 {
				continue
			}
			rawCnt, _, merr := c.callOnObject(ctx, entry.SessionID, entry.NodesObjectID, dom.MountAnnotationsJS, []any{entry.Labels}, true, false, "")
			if merr == nil {
				annotatedFrames = append(annotatedFrames, entry)
				var cnt int
				_ = json.Unmarshal(rawCnt, &cnt)
				totalCount += cnt
			}
		}
		annotatedMeta["annotated"] = true
		annotatedMeta["snapshot_id"] = snapID
		annotatedMeta["annotated_count"] = totalCount
	}

	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	sctx, cancel := context.WithTimeout(ctx, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
	defer cancel()

	params := map[string]any{
		"format":  "jpeg",
		"quality": 70,
	}
	meta = map[string]any{
		"tab_id": id,
		"url":    ps.currentURL(),
	}
	for k, v := range annotatedMeta {
		meta[k] = v
	}

	if opts.Full || opts.MaxDim > 0 || clip != nil {
		var metrics struct {
			CSSContentSize struct {
				X      float64 `json:"x"`
				Y      float64 `json:"y"`
				Width  float64 `json:"width"`
				Height float64 `json:"height"`
			} `json:"cssContentSize"`
			ContentSize struct {
				Width float64 `json:"width"`
			} `json:"contentSize"`
			CSSVisualViewport struct {
				PageX        float64 `json:"pageX"`
				PageY        float64 `json:"pageY"`
				ClientWidth  float64 `json:"clientWidth"`
				ClientHeight float64 `json:"clientHeight"`
			} `json:"cssVisualViewport"`
		}
		if err := cl.Call(sctx, ps.SessionID, "Page.getLayoutMetrics", nil, &metrics); err == nil {
			var capX, capY, capW, capH float64
			if clip != nil {
				capX = clip["x"] + metrics.CSSVisualViewport.PageX
				capY = clip["y"] + metrics.CSSVisualViewport.PageY
				capW = clip["width"]
				capH = clip["height"]
			} else if opts.Full {
				capX = metrics.CSSContentSize.X
				capY = metrics.CSSContentSize.Y
				capW = metrics.CSSContentSize.Width
				capH = metrics.CSSContentSize.Height
			} else {
				capX = metrics.CSSVisualViewport.PageX
				capY = metrics.CSSVisualViewport.PageY
				capW = metrics.CSSVisualViewport.ClientWidth
				capH = metrics.CSSVisualViewport.ClientHeight
			}
			if capW > 0 && capH > 0 {
				maxEdge := float64(opts.MaxDim)
				if maxEdge <= 0 {
					maxEdge = 16384
				}
				scale := math.Min(1, maxEdge/math.Max(capW, capH))
				deviceScale := 1.0
				if metrics.CSSContentSize.Width > 0 && metrics.ContentSize.Width > 0 {
					deviceScale = metrics.ContentSize.Width / metrics.CSSContentSize.Width
				}
				params["captureBeyondViewport"] = opts.Full
				params["clip"] = map[string]any{
					"x":      capX,
					"y":      capY,
					"width":  capW,
					"height": capH,
					"scale":  scale / deviceScale,
				}
				meta["clip"] = map[string]any{"x": capX, "y": capY, "width": capW, "height": capH}
				if opts.Full || opts.MaxDim > 0 {
					meta["scale"] = scale
					meta["full"] = opts.Full
				}
			}
		}
	}

	var shot struct {
		Data string `json:"data"`
	}
	if err := cl.Call(sctx, ps.SessionID, "Page.captureScreenshot", params, &shot); err != nil {
		return "", nil, err
	}
	return shot.Data, meta, nil
}

// Events returns (and lazily starts) the selected-page CDP event stream.
func (c *BrowserController) Events(ctx context.Context, tabID string) (string, *events.PageEvents, bool, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return "", nil, false, err
	}
	c.mu.Lock()
	existing := c.eventStreams[id]
	cl := c.client
	c.mu.Unlock()
	if existing != nil {
		return id, existing, false, nil
	}

	stream := events.New()
	sid := ps.SessionID
	stream.AddUnsub(cl.Subscribe(sid, "Network.requestWillBeSent", func(ev cdp.Event) {
		var p struct {
			RequestID string `json:"requestId"`
			Type      string `json:"type"`
			Request   struct {
				URL    string `json:"url"`
				Method string `json:"method"`
			} `json:"request"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			stream.NoteRequestStart(p.RequestID, p.Type)
			stream.Push(map[string]any{
				"type":          "request",
				"request_id":    p.RequestID,
				"url":           p.Request.URL,
				"method":        p.Request.Method,
				"resource_type": p.Type,
			})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Network.responseReceived", func(ev cdp.Event) {
		var p struct {
			RequestID string `json:"requestId"`
			Response  struct {
				URL      string `json:"url"`
				Status   int    `json:"status"`
				MimeType string `json:"mimeType"`
			} `json:"response"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			stream.Push(map[string]any{
				"type":       "response",
				"request_id": p.RequestID,
				"url":        p.Response.URL,
				"status":     p.Response.Status,
				"mime_type":  p.Response.MimeType,
			})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Network.loadingFinished", func(ev cdp.Event) {
		var p struct {
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			stream.NoteRequestEnd(p.RequestID)
			stream.Push(map[string]any{"type": "finished", "request_id": p.RequestID})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Network.loadingFailed", func(ev cdp.Event) {
		var p struct {
			RequestID string `json:"requestId"`
			ErrorText string `json:"errorText"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			stream.NoteRequestEnd(p.RequestID)
			evMap := map[string]any{"type": "failed", "request_id": p.RequestID}
			if p.ErrorText != "" {
				evMap["error"] = p.ErrorText
			}
			stream.Push(evMap)
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Runtime.consoleAPICalled", func(ev cdp.Event) {
		var p struct {
			Type string `json:"type"`
			Args []struct {
				Type        string `json:"type"`
				Value       any    `json:"value"`
				Description string `json:"description"`
			} `json:"args"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			parts := make([]string, 0, len(p.Args))
			for _, a := range p.Args {
				if a.Value != nil {
					parts = append(parts, fmt.Sprint(a.Value))
				} else if a.Description != "" {
					parts = append(parts, a.Description)
				} else {
					parts = append(parts, a.Type)
				}
			}
			stream.Push(map[string]any{
				"type":  "console",
				"level": p.Type,
				"text":  truncateString(strings.Join(parts, " "), 4000),
			})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Runtime.exceptionThrown", func(ev cdp.Event) {
		var p struct {
			ExceptionDetails struct {
				Text      string `json:"text"`
				Exception *struct {
					Description string `json:"description"`
				} `json:"exception"`
			} `json:"exceptionDetails"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			txt := p.ExceptionDetails.Text
			if p.ExceptionDetails.Exception != nil && p.ExceptionDetails.Exception.Description != "" {
				txt = p.ExceptionDetails.Exception.Description
			}
			stream.Push(map[string]any{"type": "exception", "text": truncateString(txt, 4000)})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Page.frameNavigated", func(ev cdp.Event) {
		var p struct {
			Frame struct {
				ID  string `json:"id"`
				URL string `json:"url"`
			} `json:"frame"`
		}
		if json.Unmarshal(ev.Params, &p) == nil {
			stream.Push(map[string]any{"type": "navigation", "frame_id": p.Frame.ID, "url": p.Frame.URL})
		}
	}))
	stream.AddUnsub(cl.Subscribe(sid, "Page.loadEventFired", func(ev cdp.Event) {
		stream.Push(map[string]any{"type": "load"})
	}))

	if err := cl.Call(ctx, sid, "Network.enable", nil, nil); err != nil {
		stream.Close()
		return "", nil, false, err
	}
	c.mu.Lock()
	c.eventStreams[id] = stream
	c.mu.Unlock()
	return id, stream, true, nil
}

// RouteArgs configures browser_route.
type RouteArgs struct {
	TabID       string
	Operation   string
	Pattern     string
	RouteAction string
	Status      int
	Body        string
	ContentType string
	Headers     map[string]string
	ErrorCode   string
}

var cdpErrorReasons = map[string]string{
	"aborted":              "Aborted",
	"accessdenied":         "AccessDenied",
	"addressunreachable":   "AddressUnreachable",
	"blockedbyclient":      "BlockedByClient",
	"blockedbyresponse":    "BlockedByResponse",
	"connectionaborted":    "ConnectionAborted",
	"connectionclosed":     "ConnectionClosed",
	"connectionfailed":     "ConnectionFailed",
	"connectionrefused":    "ConnectionRefused",
	"connectionreset":      "ConnectionReset",
	"internetdisconnected": "InternetDisconnected",
	"namenotresolved":      "NameNotResolved",
	"timedout":             "TimedOut",
	"failed":               "Failed",
}

func matchURLGlob(pattern, target string) bool {
	var sb strings.Builder
	sb.WriteByte('^')
	for i := 0; i < len(pattern); i++ {
		if pattern[i] == '*' {
			if i+1 < len(pattern) && pattern[i+1] == '*' {
				sb.WriteString(".*")
				i++
			} else {
				sb.WriteString(`[^/]*`)
			}
		} else if pattern[i] == '?' {
			sb.WriteByte('.')
		} else {
			sb.WriteString(regexp.QuoteMeta(string(pattern[i])))
		}
	}
	sb.WriteByte('$')
	re, err := regexp.Compile(sb.String())
	if err != nil {
		return false
	}
	return re.MatchString(target)
}

func (c *BrowserController) handleFetchPaused(cl *cdp.Client, ps *PageState, ev cdp.Event) {
	var p struct {
		RequestID string `json:"requestId"`
		Request   struct {
			URL     string            `json:"url"`
			Headers map[string]string `json:"headers"`
		} `json:"request"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	ps.mu.Lock()
	routes := append([]RouteEntry(nil), ps.routes...)
	ps.mu.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	// Match latest added route first (matching Playwright LIFO precedence).
	for i := len(routes) - 1; i >= 0; i-- {
		r := routes[i]
		if !matchURLGlob(r.Pattern, p.Request.URL) {
			continue
		}
		switch r.RouteAction {
		case "abort":
			reason := cdpErrorReasons[strings.ToLower(r.ErrorCode)]
			if reason == "" {
				reason = "Failed"
			}
			_ = cl.Call(ctx, ps.SessionID, "Fetch.failRequest", map[string]any{
				"requestId":   p.RequestID,
				"errorReason": reason,
			}, nil)
		case "continue":
			merged := make(map[string]string, len(p.Request.Headers)+len(r.Headers))
			for k, v := range p.Request.Headers {
				merged[k] = v
			}
			for k, v := range r.Headers {
				merged[k] = v
			}
			hdrs := make([]map[string]string, 0, len(merged))
			for k, v := range merged {
				hdrs = append(hdrs, map[string]string{"name": k, "value": v})
			}
			_ = cl.Call(ctx, ps.SessionID, "Fetch.continueRequest", map[string]any{
				"requestId": p.RequestID,
				"headers":   hdrs,
			}, nil)
		default:
			hdrs := make([]map[string]string, 0, len(r.Headers)+1)
			hasCT := false
			for k, v := range r.Headers {
				if strings.EqualFold(k, "content-type") {
					hasCT = true
				}
				hdrs = append(hdrs, map[string]string{"name": k, "value": v})
			}
			if !hasCT && r.ContentType != "" {
				hdrs = append(hdrs, map[string]string{"name": "content-type", "value": r.ContentType})
			}
			_ = cl.Call(ctx, ps.SessionID, "Fetch.fulfillRequest", map[string]any{
				"requestId":       p.RequestID,
				"responseCode":    r.Status,
				"responseHeaders": hdrs,
				"body":            base64.StdEncoding.EncodeToString([]byte(r.Body)),
			}, nil)
		}
		return
	}
	_ = cl.Call(ctx, ps.SessionID, "Fetch.continueRequest", map[string]any{"requestId": p.RequestID}, nil)
}

// Route adds, lists, or removes CDP Fetch interception routes on a tab.
func (c *BrowserController) Route(ctx context.Context, args RouteArgs) (map[string]any, error) {
	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	op := args.Operation
	if op == "" {
		op = "add"
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	if op == "list" {
		ps.mu.Lock()
		routes := append([]RouteEntry(nil), ps.routes...)
		ps.mu.Unlock()
		return map[string]any{"tab_id": id, "routes": routes}, nil
	}
	if op == "remove" {
		ps.mu.Lock()
		var remaining []RouteEntry
		removed := 0
		for _, r := range ps.routes {
			if args.Pattern == "" || r.Pattern == args.Pattern {
				removed++
			} else {
				remaining = append(remaining, r)
			}
		}
		ps.routes = remaining
		disableFetch := len(remaining) == 0 && ps.fetchEnabled
		if disableFetch {
			ps.fetchEnabled = false
		}
		ps.mu.Unlock()
		if removed > 0 {
			_ = c.NoteInput("route", id)
			c.SetOutcomeExecuted()
		}
		if disableFetch {
			_ = cl.Call(ctx, ps.SessionID, "Fetch.disable", nil, nil)
		}
		if remaining == nil {
			remaining = []RouteEntry{}
		}
		return map[string]any{"tab_id": id, "removed": removed, "routes": remaining}, nil
	}
	if args.Pattern == "" {
		return nil, errs.New("ROUTE_PATTERN_REQUIRED", "A URL pattern is required to add a route.", `Provide a glob pattern such as "**/api/*" or "*://example.com/*".`, nil)
	}
	ps.mu.Lock()
	if len(ps.routes) >= 50 {
		ps.mu.Unlock()
		return nil, errs.New("ROUTE_LIMIT", "At most 50 active routes are supported per tab.", `Remove unused routes with operation: "remove".`, nil)
	}
	needEnable := !ps.fetchEnabled
	ps.mu.Unlock()

	if err := c.NoteInput("route", id); err != nil {
		return nil, err
	}
	if needEnable {
		if err := cl.Call(ctx, ps.SessionID, "Fetch.enable", map[string]any{
			"patterns": []map[string]any{{"urlPattern": "*"}},
		}, nil); err != nil {
			return nil, err
		}
	}
	c.SetOutcomeExecuted()

	act := args.RouteAction
	if act == "" {
		act = "fulfill"
	}
	entry := RouteEntry{
		Pattern:     args.Pattern,
		RouteAction: act,
		Headers:     args.Headers,
	}
	if act == "fulfill" {
		st := args.Status
		if st == 0 {
			st = 200
		}
		ct := args.ContentType
		if ct == "" {
			ct = "text/plain"
		}
		entry.Status = st
		entry.ContentType = ct
		entry.Body = args.Body
		entry.BodyBytes = len(args.Body)
	} else if act == "abort" {
		ec := args.ErrorCode
		if ec == "" {
			ec = "failed"
		}
		entry.ErrorCode = ec
	}

	ps.mu.Lock()
	ps.fetchEnabled = true
	ps.routes = append(ps.routes, entry)
	routes := append([]RouteEntry(nil), ps.routes...)
	ps.mu.Unlock()
	return map[string]any{"tab_id": id, "added": args.Pattern, "routes": routes}, nil
}

// PDFArgs configures browser_pdf.
type PDFArgs struct {
	TabID              string
	Path               string
	Landscape          bool
	PrintBackground    bool
	Scale              float64
	PreferCSSPageSize  bool
}

// PDF exports the selected tab via CDP Page.printToPDF.
func (c *BrowserController) PDF(ctx context.Context, args PDFArgs) (map[string]any, error) {
	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is open in this tab.", "Read browser_snapshot, then call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}
	if args.Path != "" && !filepath.IsAbs(args.Path) {
		return nil, errs.New("PDF_PATH_INVALID", "PDF output path must be an absolute local path.", "Use the full path on the machine running the MCP server.", nil)
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	scale := args.Scale
	if scale <= 0 {
		scale = 1
	}
	pctx, cancel := context.WithTimeout(ctx, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
	defer cancel()
	var res struct {
		Data string `json:"data"`
	}
	if err := cl.Call(pctx, ps.SessionID, "Page.printToPDF", map[string]any{
		"landscape":           args.Landscape,
		"printBackground":     args.PrintBackground,
		"scale":               scale,
		"preferCSSPageSize":   args.PreferCSSPageSize,
	}, &res); err != nil {
		low := strings.ToLower(err.Error())
		if strings.Contains(low, "printtopdf is not implemented") || strings.Contains(low, "printing is not available") {
			return nil, errs.New("PDF_UNSUPPORTED", "This Chrome build does not support CDP Page.printToPDF.", "Use browser_screenshot with full: true on Android Chrome builds that disable headless PDF printing.", nil)
		}
		return nil, err
	}
	buf, err := base64.StdEncoding.DecodeString(res.Data)
	if err != nil {
		return nil, err
	}
	if args.Path != "" {
		if err := os.WriteFile(args.Path, buf, 0o644); err != nil {
			return nil, err
		}
		return map[string]any{"tab_id": id, "url": ps.currentURL(), "path": args.Path, "bytes": len(buf)}, nil
	}
	if len(buf) > 10*1024*1024 {
		return nil, errs.New("PDF_SIZE_LIMIT", "Generated PDF exceeds 10 MiB.", "Pass an absolute path to save large PDFs to disk.", nil)
	}
	return map[string]any{"tab_id": id, "url": ps.currentURL(), "bytes": len(buf), "data_base64": res.Data}, nil
}

// ListOrSaveDownloads lists captured downloads or saves a download to an explicit local path.
func (c *BrowserController) ListOrSaveDownloads(ctx context.Context, tabID, operation, downloadID, destPath string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if operation == "" {
		operation = "list"
	}
	ps.mu.Lock()
	records := append([]*DownloadRecord(nil), ps.downloads...)
	ps.mu.Unlock()

	if operation == "list" {
		if records == nil {
			records = []*DownloadRecord{}
		}
		return map[string]any{"tab_id": id, "downloads": records}, nil
	}
	if operation == "save" {
		if destPath == "" || !filepath.IsAbs(destPath) {
			return nil, errs.New("DOWNLOAD_PATH_INVALID", "Download output path must be an absolute local path.", "Use the full path on the machine running the MCP server.", nil)
		}
		var rec *DownloadRecord
		if downloadID != "" {
			for _, r := range records {
				if r.DownloadID == downloadID {
					rec = r
					break
				}
			}
		} else if len(records) > 0 {
			rec = records[len(records)-1]
		}
		if rec == nil {
			return nil, errs.New("DOWNLOAD_NOT_FOUND", "No captured download was found for this tab.", `Click a download link first, then call browser_downloads({ operation: "list" }).`, nil)
		}
		// Wait briefly if download is still completing.
		deadline := time.Now().Add(time.Duration(c.Config.ActionTimeout) * time.Millisecond)
		for rec.Status == "pending" && time.Now().Before(deadline) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
		if rec.Path == "" {
			return nil, errs.New("DOWNLOAD_UNAVAILABLE", "The downloaded file is not yet available on disk.", "Check browser_downloads({ operation: \"list\" }) or download from a desktop Chromium host.", nil)
		}
		src, err := os.Open(rec.Path)
		if err != nil {
			return nil, err
		}
		defer src.Close()
		dst, err := os.Create(destPath)
		if err != nil {
			return nil, err
		}
		if _, err := io.Copy(dst, src); err != nil {
			dst.Close()
			return nil, err
		}
		if err := dst.Close(); err != nil {
			return nil, err
		}
		rec.SavedPath = destPath
		rec.Status = "completed"
		return map[string]any{"tab_id": id, "saved": true, "path": destPath, "download": rec}, nil
	}
	return nil, errs.New("DOWNLOAD_OPERATION_INVALID", "Unknown download operation: "+operation, `Use "list" or "save".`, nil)
}

// CookieArgs configures browser_cookies.
type CookieArgs struct {
	TabID    string
	Operation string
	Name     string
	Value    *string
	URL      string
	Domain   string
	Path     string
	HTTPOnly *bool
	Secure   *bool
	SameSite string
	Expires  *float64
}

// Cookies gets, sets, deletes, or clears cookies via CDP Network.* methods.
func (c *BrowserController) Cookies(ctx context.Context, args CookieArgs) (map[string]any, error) {
	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	op := args.Operation
	if op == "" {
		op = "get"
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	tctx, cancel := context.WithTimeout(ctx, time.Duration(c.Config.ActionTimeout)*time.Millisecond)
	defer cancel()

	switch op {
	case "get":
		targetURL := args.URL
		if targetURL == "" {
			targetURL = ps.currentURL()
		}
		params := map[string]any{}
		if strings.HasPrefix(strings.ToLower(targetURL), "http://") || strings.HasPrefix(strings.ToLower(targetURL), "https://") {
			params["urls"] = []string{targetURL}
		}
		var res struct {
			Cookies []struct {
				Name     string  `json:"name"`
				Value    string  `json:"value"`
				Domain   string  `json:"domain"`
				Path     string  `json:"path"`
				HTTPOnly bool    `json:"httpOnly"`
				Secure   bool    `json:"secure"`
				SameSite string  `json:"sameSite"`
				Expires  float64 `json:"expires"`
				Session  bool    `json:"session"`
			} `json:"cookies"`
		}
		if err := cl.Call(tctx, ps.SessionID, "Network.getCookies", params, &res); err != nil {
			return nil, err
		}
		out := make([]map[string]any, 0, len(res.Cookies))
		totalMatched := 0
		for _, ck := range res.Cookies {
			if args.Name != "" && ck.Name != args.Name {
				continue
			}
			totalMatched++
			if len(out) >= 200 {
				continue
			}
			item := map[string]any{
				"name":      ck.Name,
				"value":     ck.Value,
				"domain":    ck.Domain,
				"path":      ck.Path,
				"http_only": ck.HTTPOnly,
				"secure":    ck.Secure,
				"session":   ck.Session,
			}
			if ck.SameSite != "" {
				item["same_site"] = ck.SameSite
			}
			if ck.Expires > 0 {
				item["expires"] = ck.Expires
			}
			out = append(out, item)
		}
		return map[string]any{
			"tab_id":    id,
			"url":       targetURL,
			"cookies":   out,
			"truncated": totalMatched > 200,
		}, nil

	case "set":
		if args.Name == "" || args.Value == nil {
			return nil, errs.New("COOKIE_ARGUMENTS_INVALID", `Cookie name and value are required for operation: "set".`, "Pass both name and value.", nil)
		}
		params := map[string]any{
			"name":  args.Name,
			"value": *args.Value,
		}
		if args.URL != "" {
			params["url"] = args.URL
		} else if args.Domain == "" {
			params["url"] = ps.currentURL()
		}
		if args.Domain != "" {
			params["domain"] = args.Domain
		}
		if args.Path != "" {
			params["path"] = args.Path
		}
		if args.HTTPOnly != nil {
			params["httpOnly"] = *args.HTTPOnly
		}
		if args.Secure != nil {
			params["secure"] = *args.Secure
		}
		if args.SameSite != "" {
			params["sameSite"] = args.SameSite
		}
		if args.Expires != nil {
			params["expires"] = *args.Expires
		}
		if err := c.NoteInput("cookies", id); err != nil {
			return nil, err
		}
		var res struct {
			Success bool `json:"success"`
		}
		if err := cl.Call(tctx, ps.SessionID, "Network.setCookie", params, &res); err != nil {
			return nil, err
		}
		c.SetOutcomeExecuted()
		return map[string]any{"tab_id": id, "set": res.Success, "name": args.Name}, nil

	case "delete":
		if args.Name == "" {
			return nil, errs.New("COOKIE_ARGUMENTS_INVALID", `Cookie name is required for operation: "delete".`, "Pass the cookie name to delete.", nil)
		}
		params := map[string]any{"name": args.Name}
		if args.URL != "" {
			params["url"] = args.URL
		} else if args.Domain == "" {
			params["url"] = ps.currentURL()
		}
		if args.Domain != "" {
			params["domain"] = args.Domain
		}
		if args.Path != "" {
			params["path"] = args.Path
		}
		if err := c.NoteInput("cookies", id); err != nil {
			return nil, err
		}
		if err := cl.Call(tctx, ps.SessionID, "Network.deleteCookies", params, nil); err != nil {
			return nil, err
		}
		c.SetOutcomeExecuted()
		return map[string]any{"tab_id": id, "deleted": true, "name": args.Name}, nil

	case "clear":
		if err := c.NoteInput("cookies", id); err != nil {
			return nil, err
		}
		if err := cl.Call(tctx, ps.SessionID, "Network.clearBrowserCookies", nil, nil); err != nil {
			return nil, err
		}
		c.SetOutcomeExecuted()
		return map[string]any{"tab_id": id, "cleared": true}, nil

	default:
		return nil, errs.New("COOKIE_OPERATION_INVALID", "Unknown cookie operation: "+op, `Use "get", "set", "delete", or "clear".`, nil)
	}
}

// Evaluate runs a JavaScript expression in the main frame or specified frame_id.
func (c *BrowserController) Evaluate(ctx context.Context, tabID, frameID, expression string, includeSnapshot bool) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	targetFrameID := ps.mainFrameID
	if frameID != "" {
		idx, err := strconv.Atoi(strings.TrimPrefix(frameID, "frame_"))
		if err != nil {
			return nil, errs.New("FRAME_UNAVAILABLE", "This frame is no longer available.", "Inspect a fresh snapshot and choose a current frame_id.", nil)
		}
		f, ok := ps.frameByIndex(idx)
		if !ok {
			return nil, errs.New("FRAME_UNAVAILABLE", "This frame is no longer available.", "Inspect a fresh snapshot and choose a current frame_id.", nil)
		}
		targetFrameID = f.ID
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is blocking evaluation.", "Call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}
	c.ClearRefs()
	if err := c.NoteInput("evaluate", id); err != nil {
		return nil, err
	}
	raw, _, err := c.evalInFrame(ctx, ps, targetFrameID, expression, true, true, "")
	if err != nil {
		return nil, err
	}
	c.SetOutcomeExecuted()

	serialized := "null"
	var resultVal any
	if len(raw) > 0 {
		serialized = string(raw)
		_ = json.Unmarshal(raw, &resultVal)
	}
	out := map[string]any{"tab_id": id, "executed": true}
	if len(serialized) > 20000 {
		out["result_text"] = serialized[:20000]
		out["truncated"] = true
	} else {
		out["result"] = resultVal
	}
	if !includeSnapshot {
		out["refs_invalidated"] = true
		return out, nil
	}
	snap, err := c.Snapshot(ctx, SnapshotOptions{TabID: id})
	if err != nil {
		out["observation_error"] = errs.Describe(err)
		out["recovery"] = "Evaluation executed, but its snapshot failed. Inspect the page before repeating it."
		return out, nil
	}
	out["snapshot"] = snap
	return out, nil
}

// ExecCDP sends a page-scoped CDP command directly on the selected tab's session.
func (c *BrowserController) ExecCDP(ctx context.Context, tabID, frameID, method string, params map[string]any) (any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if strings.HasPrefix(method, "Browser.") || strings.HasPrefix(method, "Target.") {
		return nil, errs.New("CDP_SCOPE_INVALID", "CDP commands are scoped to the selected web page.", "Use list_tabs(), new_tab(), select_tab() and close_tab() for tab management.", nil)
	}
	if frameID != "" && frameID != "frame_0" {
		return nil, errs.New("FRAME_CDP_UNAVAILABLE", "This iframe shares its parent CDP session.", "Use js(expression, {frame_id}) for this iframe, or leave frame_id unset for page-scoped CDP commands.", nil)
	}
	if err := c.NoteInput("cdp", id); err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	raw, err := cl.CallRaw(ctx, ps.SessionID, method, params)
	if err != nil {
		return nil, err
	}
	c.SetOutcomeExecuted()
	c.ClearRefs()
	if len(raw) > 1000000 {
		return nil, errs.New("CDP_RESULT_LIMIT", "CDP returned more than one megabyte.", "Request a smaller protocol result.", nil)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		return map[string]any{}, nil
	}
	return out, nil
}

// FlowArgs configures browser_flow.
type FlowArgs struct {
	TabID       string
	Operation   string
	Name        string
	Description string
	RequestID   string
	Params      map[string]string
	Fields      []string
	Limit       int
	Mode        string
	Origin      string
	Path        string
	Reset       *bool
}

// Flow executes browser_flow operations (capture, stop, status, save, run, list, delete).
func (c *BrowserController) Flow(ctx context.Context, args FlowArgs) (map[string]any, error) {
	op := args.Operation
	if op == "" {
		op = "list"
	}
	switch op {
	case "list":
		return c.FlowStore.List(args.Origin, args.Path)
	case "delete":
		return c.FlowStore.Remove(args.Name, args.Path)
	case "run":
		var fetcher flow.PageFetcher
		if args.Mode != "http" {
			fetcher = func(fctx context.Context, reqURL, method string, headers map[string]string, body *string) (string, int, string, error) {
				ps, _, err := c.Page(fctx, args.TabID, false)
				if err != nil {
					return "", 0, "", err
				}
				payload := map[string]any{"url": reqURL, "method": method, "headers": headers}
				if body != nil {
					payload["body"] = *body
				}
				pJSON, _ := json.Marshal(payload)
				expr := `(async (req) => {
					const res = await fetch(req.url, {
						method: req.method,
						headers: req.headers,
						credentials: 'include',
						...(req.body !== undefined ? { body: req.body } : {}),
					});
					return { status: res.status, text: await res.text() };
				})(` + string(pJSON) + `)`
				raw, _, err := c.evalInFrame(fctx, ps, ps.mainFrameID, expr, true, true, "")
				if err != nil {
					return "", 0, "", err
				}
				var r struct {
					Status int    `json:"status"`
					Text   string `json:"text"`
				}
				if err := json.Unmarshal(raw, &r); err != nil {
					return "", 0, "", err
				}
				return ps.currentURL(), r.Status, r.Text, nil
			}
		}
		return c.FlowStore.Run(ctx, flow.RunOptions{
			Name:        args.Name,
			Params:      args.Params,
			Fields:      args.Fields,
			Limit:       args.Limit,
			Mode:        args.Mode,
			PageFetcher: fetcher,
			Timeout:     time.Duration(c.Config.ActionTimeout) * time.Millisecond,
			Path:        args.Path,
		})
	}

	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	existing := c.flowCaptures[id]
	c.mu.Unlock()

	switch op {
	case "capture":
		if existing != nil {
			if args.Reset == nil || *args.Reset {
				existing.Reset()
			}
			return map[string]any{"tab_id": id, "capturing": true, "newly_started": false, "url": ps.currentURL()}, nil
		}
		cap := flow.NewCapture(cl, ps.SessionID)
		if err := cap.Start(ctx); err != nil {
			cap.Close()
			return nil, err
		}
		c.mu.Lock()
		c.flowCaptures[id] = cap
		c.mu.Unlock()
		return map[string]any{"tab_id": id, "capturing": true, "newly_started": true, "url": ps.currentURL()}, nil

	case "stop":
		was := existing != nil
		if existing != nil {
			existing.Close()
			c.mu.Lock()
			delete(c.flowCaptures, id)
			c.mu.Unlock()
		}
		return map[string]any{"tab_id": id, "capturing": false, "was_capturing": was}, nil

	case "status":
		var cands []*flow.CapturedRequest
		if existing != nil {
			cands = existing.Candidates(ps.currentURL())
		}
		outCands := make([]map[string]any, 0, len(cands))
		for _, cand := range cands {
			outCands = append(outCands, map[string]any{
				"id":       cand.ID,
				"method":   cand.Method,
				"url":      cand.URL,
				"status":   cand.Status,
				"has_body": cand.RequestBody != nil,
			})
		}
		return map[string]any{
			"tab_id":     id,
			"capturing":  existing != nil,
			"url":        ps.currentURL(),
			"candidates": outCands,
		}, nil

	case "save":
		if existing == nil {
			return nil, errs.New("FLOW_CAPTURE_INACTIVE", "Flow capture is not active on this tab.", `Call browser_flow({ operation: "capture" }) before triggering the request, then save.`, nil)
		}
		cands := existing.Candidates(ps.currentURL())
		saved, err := c.FlowStore.BuildAndSave(args.Name, args.Description, ps.currentURL(), cands, existing.Secrets(), args.RequestID, args.Params, args.Path)
		if err != nil {
			return nil, err
		}
		saved["tab_id"] = id
		return saved, nil

	default:
		return nil, errs.New("FLOW_OPERATION_INVALID", "Unknown flow operation: "+op, "Use capture, stop, status, save, run, list, or delete.", nil)
	}
}

// MediaArgs configures browser_media.
type MediaArgs struct {
	TabID         string
	Operation     string
	Ref           string
	URL           string
	MediaType     string
	Index         int
	Path          string
	Mode          string
	DurationMS    int
	AudioOnly     bool
	PlayIfPaused  *bool
	ControlAction string
	CurrentTime   *float64
	Muted         *bool
	PlaybackRate  *float64
}

// Media inspects, controls, downloads, or records <video>/<audio> elements on the selected tab.
func (c *BrowserController) Media(ctx context.Context, args MediaArgs) (map[string]any, error) {
	op := args.Operation
	if op == "" {
		op = "download"
	}
	mediaType := args.MediaType
	if mediaType == "" {
		mediaType = "any"
	}
	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is open in this tab.", "Read browser_snapshot, then call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}
	if (op == "download" || op == "record") && args.Path != "" && !filepath.IsAbs(args.Path) {
		return nil, errs.New("MEDIA_PATH_INVALID", "Media output path must be an absolute local path.", "Use the full path on the machine running the MCP server.", nil)
	}

	if op == "inspect" {
		frames := ps.orderedFrames()
		if len(frames) == 0 {
			frames = []FrameInfo{{ID: ps.mainFrameID, URL: ps.currentURL()}}
		}
		if len(frames) > 25 {
			frames = frames[:25]
		}
		items := make([]map[string]any, 0)
		warnings := make([]map[string]any, 0)
		optsJSON, _ := json.Marshal(map[string]any{"mediaType": mediaType})
		expr := "(" + media.CollectFrameMediaJS + ")(" + string(optsJSON) + ")"
		for i, f := range frames {
			fid := fmt.Sprintf("frame_%d", i)
			timeout := 1500 * time.Millisecond
			if i == 0 {
				timeout = time.Duration(c.Config.ActionTimeout) * time.Millisecond
			}
			fctx, cancel := context.WithTimeout(ctx, timeout)
			raw, _, ferr := c.evalInFrame(fctx, ps, f.ID, expr, true, false, "")
			cancel()
			if ferr != nil {
				if i == 0 {
					return nil, ferr
				}
				warnings = append(warnings, map[string]any{"frame_id": fid, "error": ferr.Error()})
				continue
			}
			var frameItems []map[string]any
			if json.Unmarshal(raw, &frameItems) == nil {
				for _, item := range frameItems {
					item["index"] = len(items)
					item["frame_id"] = fid
					items = append(items, item)
				}
			}
		}
		out := map[string]any{"tab_id": id, "url": ps.currentURL(), "media": items}
		if len(warnings) > 0 {
			out["warnings"] = warnings
		}
		return out, nil
	}

	// Resolve target element or direct URL.
	var elemObjID string
	var elemFrameID = ps.mainFrameID
	var directURL string
	defer func() {
		if elemObjID != "" {
			c.releaseObject(ps.SessionID, elemObjID)
		}
	}()

	if args.Ref != "" {
		rawObj, fid, err := c.ResolveRef(ctx, args.Ref, ps)
		if err != nil {
			return nil, err
		}
		rawInfo, _, err := c.callOnObject(ctx, ps.SessionID, rawObj, `function() {
			const node = this;
			const m = (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') ? node : node.querySelector('video, audio');
			if (m) return { kind: 'media', isSelf: m === node };
			if (node.tagName === 'A' && node.href) return { kind: 'link', href: node.href };
			return { kind: 'invalid' };
		}`, nil, true, false, "")
		if err != nil {
			c.releaseObject(ps.SessionID, rawObj)
			return nil, err
		}
		var info struct {
			Kind   string `json:"kind"`
			IsSelf bool   `json:"isSelf"`
			Href   string `json:"href"`
		}
		_ = json.Unmarshal(rawInfo, &info)
		if info.Kind == "media" {
			elemFrameID = fid
			if info.IsSelf {
				elemObjID = rawObj
			} else {
				_, childObj, cerr := c.callOnObject(ctx, ps.SessionID, rawObj, `function() { return this.querySelector('video, audio'); }`, nil, false, false, "chrome-control-target")
				c.releaseObject(ps.SessionID, rawObj)
				if cerr != nil || childObj == "" {
					return nil, errs.New("MEDIA_TARGET_INVALID", "The target media element could not be resolved.", "Inspect a fresh browser_snapshot and try again.", nil)
				}
				elemObjID = childObj
			}
		} else if info.Kind == "link" && op == "download" {
			c.releaseObject(ps.SessionID, rawObj)
			directURL = info.Href
		} else {
			c.releaseObject(ps.SessionID, rawObj)
			return nil, errs.New("MEDIA_TARGET_INVALID", "The selected element is not a video, audio, player container, or media link.", "Select a video or audio ref from browser_snapshot or omit ref to match media on the page.", nil)
		}
	} else if args.URL != "" && op == "download" {
		base, _ := url.Parse(ps.currentURL())
		parsed, err := url.Parse(args.URL)
		if err != nil {
			return nil, errs.New("MEDIA_URL_INVALID", "Media URL is not valid.", "Provide a valid http, https, blob, or data URL.", nil)
		}
		if base != nil {
			parsed = base.ResolveReference(parsed)
		}
		if parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "blob" && parsed.Scheme != "data" {
			return nil, errs.New("MEDIA_URL_INVALID", "Unsupported media URL protocol: "+parsed.Scheme+":", "Provide an http, https, blob, or data URL.", nil)
		}
		directURL = parsed.String()
	} else {
		// Find matching media element by index across frames.
		frames := ps.orderedFrames()
		if len(frames) == 0 {
			frames = []FrameInfo{{ID: ps.mainFrameID}}
		}
		if len(frames) > 25 {
			frames = frames[:25]
		}
		remaining := args.Index
		optsJSON, _ := json.Marshal(map[string]any{"mediaType": mediaType})
		findExpr := "(" + media.FindFrameMediaElementsJS + ")(" + string(optsJSON) + ")"
		for _, f := range frames {
			_, listObj, ferr := c.evalInFrame(ctx, ps, f.ID, findExpr, false, false, "chrome-control-target")
			if ferr != nil || listObj == "" {
				continue
			}
			rawLen, _, lerr := c.callOnObject(ctx, ps.SessionID, listObj, `function() { return this.length; }`, nil, true, false, "")
			var cnt int
			if lerr == nil {
				_ = json.Unmarshal(rawLen, &cnt)
			}
			if remaining < cnt {
				_, itemObj, ierr := c.callOnObject(ctx, ps.SessionID, listObj, `function(i) { return this[i]; }`, []any{remaining}, false, false, "chrome-control-target")
				c.releaseObject(ps.SessionID, listObj)
				if ierr == nil && itemObj != "" {
					elemObjID = itemObj
					elemFrameID = f.ID
					break
				}
			} else {
				c.releaseObject(ps.SessionID, listObj)
				remaining -= cnt
			}
		}
		if elemObjID == "" {
			return nil, errs.New("MEDIA_NOT_FOUND", "No matching video or audio element was found on the page.", "Inspect the page with browser_snapshot or pass a direct media url.", nil)
		}
	}

	recordClip := func() (map[string]any, error) {
		if elemObjID == "" {
			return nil, errs.New("MEDIA_ELEMENT_REQUIRED", "Recording requires a video or audio element on the page.", "Omit url or pass a video or audio ref from browser_snapshot.", nil)
		}
		durMS := args.DurationMS
		if durMS <= 0 {
			durMS = 5000
		}
		playIfPaused := args.PlayIfPaused == nil || *args.PlayIfPaused
		if err := c.NoteInput("media", id); err != nil {
			return nil, err
		}
		rTimeout := time.Duration(durMS+5000) * time.Millisecond
		if at := time.Duration(c.Config.ActionTimeout) * time.Millisecond; at > rTimeout {
			rTimeout = at
		}
		rctx, cancel := context.WithTimeout(ctx, rTimeout)
		defer cancel()
		rawRec, _, err := c.callOnObject(rctx, ps.SessionID, elemObjID, media.RecordElementMediaJS, []any{map[string]any{
			"durationMs":   durMS,
			"maxBytes":     media.MaxMediaBytes,
			"playIfPaused": playIfPaused,
			"audioOnly":    args.AudioOnly,
		}}, true, true, "")
		if err != nil {
			return nil, err
		}
		var rec struct {
			OK          bool     `json:"ok"`
			Code        string   `json:"code"`
			Message     string   `json:"message"`
			MimeType    string   `json:"mime_type"`
			Bytes       int      `json:"bytes"`
			DataBase64  string   `json:"data_base64"`
			CurrentTime float64  `json:"current_time"`
			Duration    *float64 `json:"duration"`
		}
		if err := json.Unmarshal(rawRec, &rec); err != nil || !rec.OK {
			code := rec.Code
			if code == "" {
				code = "MEDIA_RECORD_FAILED"
			}
			msg := rec.Message
			if msg == "" {
				msg = "Failed to record media stream."
			}
			return nil, errs.New(code, msg, "Ensure the media element can play without cross-origin restrictions, or pass a direct media URL for download.", nil)
		}
		c.SetOutcomeExecuted()
		buf, err := base64.StdEncoding.DecodeString(rec.DataBase64)
		if err != nil {
			return nil, err
		}
		outPath, err := media.ResolveMediaOutputPath(args.Path, rec.MimeType, "")
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(outPath, buf, 0o644); err != nil {
			return nil, err
		}
		return map[string]any{
			"tab_id":       id,
			"url":          ps.currentURL(),
			"method":       "record",
			"path":         outPath,
			"mime_type":    rec.MimeType,
			"bytes":        len(buf),
			"duration_ms":  durMS,
			"current_time": rec.CurrentTime,
			"duration":     rec.Duration,
		}, nil
	}

	if op == "control" {
		if args.ControlAction == "seek" && args.CurrentTime == nil {
			return nil, errs.New("MEDIA_ARGUMENTS_INVALID", `Provide current_time when control_action is "seek".`, "Pass current_time in seconds.", nil)
		}
		if args.ControlAction == "rate" && args.PlaybackRate == nil {
			return nil, errs.New("MEDIA_ARGUMENTS_INVALID", `Provide playback_rate when control_action is "rate".`, "Pass playback_rate (for example 1.5).", nil)
		}
		if err := c.NoteInput("media", id); err != nil {
			return nil, err
		}
		opts := map[string]any{}
		if args.ControlAction != "" {
			opts["controlAction"] = args.ControlAction
		}
		if args.CurrentTime != nil {
			opts["currentTime"] = *args.CurrentTime
		}
		if args.Muted != nil {
			opts["muted"] = *args.Muted
		}
		if args.PlaybackRate != nil {
			opts["playbackRate"] = *args.PlaybackRate
		}
		rawState, _, err := c.callOnObject(ctx, ps.SessionID, elemObjID, media.ControlElementMediaJS, []any{opts}, true, true, "")
		if err != nil {
			return nil, err
		}
		c.SetOutcomeExecuted()
		var state map[string]any
		_ = json.Unmarshal(rawState, &state)
		return map[string]any{"tab_id": id, "url": ps.currentURL(), "executed": true, "media": state}, nil
	}

	if op == "record" {
		return recordClip()
	}

	if op == "download" {
		mode := args.Mode
		if mode == "" {
			mode = "auto"
		}
		if mode == "record" {
			return recordClip()
		}
		var meta map[string]any
		mediaURL := directURL
		if elemObjID != "" {
			if rawMeta, _, merr := c.callOnObject(ctx, ps.SessionID, elemObjID, media.InspectElementMediaJS, nil, true, false, ""); merr == nil {
				_ = json.Unmarshal(rawMeta, &meta)
				if mediaURL == "" {
					mediaURL, _ = meta["src"].(string)
				}
			}
		}
		if mediaURL == "" {
			if elemObjID != "" && mode == "auto" {
				return recordClip()
			}
			return nil, errs.New("MEDIA_URL_MISSING", "The media element has no downloadable source URL.", `Use operation: "record" to capture live playback from the element.`, nil)
		}

		attachTracks := func(out map[string]any) map[string]any {
			if meta != nil {
				if tr, ok := meta["tracks"].([]any); ok && len(tr) > 0 {
					out["tracks"] = tr
				}
			}
			return out
		}

		if strings.HasPrefix(mediaURL, "data:") {
			buf, mimeType, err := media.ParseDataURL(mediaURL, media.MaxMediaBytes)
			if err != nil {
				return nil, err
			}
			outPath, err := media.ResolveMediaOutputPath(args.Path, mimeType, "")
			if err != nil {
				return nil, err
			}
			if err := os.WriteFile(outPath, buf, 0o644); err != nil {
				return nil, err
			}
			return attachTracks(map[string]any{
				"tab_id":    id,
				"url":       ps.currentURL(),
				"media_url": truncateString(mediaURL, 200),
				"method":    "data",
				"path":      outPath,
				"mime_type": mimeType,
				"bytes":     len(buf),
			}), nil
		}

		fetchInPage := func() (buf []byte, mimeType string, sizeExceeded bool, fetchErr string, ok bool) {
			fJSON, _ := json.Marshal(map[string]any{"mediaUrl": mediaURL, "maxBytes": media.MaxMediaBytes})
			expr := "(" + media.FetchMediaInPageJS + ")(" + string(fJSON) + ")"
			raw, _, err := c.evalInFrame(ctx, ps, elemFrameID, expr, true, true, "")
			if err != nil {
				return nil, "", false, err.Error(), false
			}
			var pr struct {
				OK           bool   `json:"ok"`
				SizeExceeded bool   `json:"size_exceeded"`
				MimeType     string `json:"mime_type"`
				DataBase64   string `json:"data_base64"`
				Error        string `json:"error"`
			}
			if err := json.Unmarshal(raw, &pr); err != nil {
				return nil, "", false, err.Error(), false
			}
			if !pr.OK {
				return nil, "", pr.SizeExceeded, pr.Error, false
			}
			b, err := base64.StdEncoding.DecodeString(pr.DataBase64)
			if err != nil {
				return nil, "", false, err.Error(), false
			}
			return b, pr.MimeType, false, "", true
		}

		if strings.HasPrefix(mediaURL, "blob:") {
			if mode == "fetch" {
				return nil, errs.New("MEDIA_MODE_INVALID", "Blob URLs can only be fetched inside the browser page or recorded.", `Use mode: "auto", mode: "page", or operation: "record".`, nil)
			}
			buf, mimeType, sizeExceeded, fetchErr, ok := fetchInPage()
			if ok {
				outPath, err := media.ResolveMediaOutputPath(args.Path, mimeType, mediaURL)
				if err != nil {
					return nil, err
				}
				if err := os.WriteFile(outPath, buf, 0o644); err != nil {
					return nil, err
				}
				return attachTracks(map[string]any{
					"tab_id":    id,
					"url":       ps.currentURL(),
					"media_url": mediaURL,
					"method":    "page",
					"path":      outPath,
					"mime_type": mimeType,
					"bytes":     len(buf),
				}), nil
			}
			if elemObjID != "" && mode == "auto" {
				return recordClip()
			}
			if sizeExceeded {
				return nil, errs.New("MEDIA_SIZE_LIMIT", "Media file exceeds the 50 MiB download limit.", `Use operation: "record" with a bounded duration_ms to capture a shorter clip.`, nil)
			}
			if fetchErr == "" {
				fetchErr = "Could not download blob media URL."
			}
			return nil, errs.New("MEDIA_DOWNLOAD_FAILED", fetchErr, `Use operation: "record" to capture MediaSource or live playback.`, nil)
		}

		var buf []byte
		var mimeType, methodUsed string
		if mode == "page" || mode == "auto" {
			b, mt, sizeExceeded, fetchErr, ok := fetchInPage()
			if ok {
				buf, mimeType, methodUsed = b, mt, "page"
			} else if sizeExceeded {
				return nil, errs.New("MEDIA_SIZE_LIMIT", "Media file exceeds the 50 MiB download limit.", `Use operation: "record" with a bounded duration_ms to capture a shorter clip.`, nil)
			} else if mode == "page" {
				return nil, errs.New("MEDIA_DOWNLOAD_FAILED", "In-page media fetch failed: "+fetchErr, `Try mode: "auto" or mode: "fetch" for cross-origin media, or operation: "record".`, nil)
			}
		}
		if buf == nil {
			timeoutMS := minInt(20000, maxInt(2000, c.Config.RequestTimeout-2000))
			b, mt, err := media.FetchMediaHTTP(ctx, mediaURL, ps.currentURL(), time.Duration(timeoutMS)*time.Millisecond, media.MaxMediaBytes)
			if err != nil {
				return nil, err
			}
			buf, mimeType, methodUsed = b, mt, "fetch"
		}
		outPath, err := media.ResolveMediaOutputPath(args.Path, mimeType, mediaURL)
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(outPath, buf, 0o644); err != nil {
			return nil, err
		}
		return attachTracks(map[string]any{
			"tab_id":    id,
			"url":       ps.currentURL(),
			"media_url": mediaURL,
			"method":    methodUsed,
			"path":      outPath,
			"mime_type": mimeType,
			"bytes":     len(buf),
		}), nil
	}

	return nil, errs.New("MEDIA_OPERATION_INVALID", "Unknown media operation: "+op, "Use download, record, inspect, or control.", nil)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
