package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/dom"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

// SnapshotOptions configures BrowserController.Snapshot.
type SnapshotOptions struct {
	TabID        string
	MaxElements  int
	MaxText      int
	Mode         string // "dom", "aria", "both"
	Format       string // "json", "compact"
	ViewportOnly bool
	Scope        string
	Filter       string
	Roles        []string
	IncludeBBox  bool
}

type collectDOMResult struct {
	Stamp             string           `json:"stamp"`
	Title             string           `json:"title"`
	Text              string           `json:"text"`
	TextTruncated     bool             `json:"text_truncated"`
	Elements          []map[string]any `json:"elements"`
	ElementsTruncated bool             `json:"elements_truncated"`
	ScopeMatched      *bool            `json:"scope_matched,omitempty"`
	Challenge         map[string]any   `json:"challenge,omitempty"`
}

func (c *BrowserController) readFrameDOM(ctx context.Context, ps *PageState, frame FrameInfo, opts map[string]any, timeout time.Duration) (string, collectDOMResult, error) {
	fctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	optsJSON, err := json.Marshal(opts)
	if err != nil {
		return "", collectDOMResult{}, err
	}
	expr := "(" + dom.CollectDOMJS + ")(" + string(optsJSON) + ")"
	_, objID, err := c.evalInFrame(fctx, ps, frame.ID, expr, false, false, "chrome-control-refs")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", collectDOMResult{}, errs.New("FRAME_TIMEOUT", "This frame did not answer the snapshot request.", "Keep Chrome foregrounded with the screen unlocked, then inspect again.", nil)
		}
		return "", collectDOMResult{}, err
	}
	defer c.releaseObject(ps.SessionID, objID)

	rawData, _, err := c.callOnObject(fctx, ps.SessionID, objID, `function() { return this.data; }`, nil, true, false, "")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", collectDOMResult{}, errs.New("FRAME_TIMEOUT", "This frame did not answer the snapshot request.", "Keep Chrome foregrounded with the screen unlocked, then inspect again.", nil)
		}
		return "", collectDOMResult{}, err
	}
	var data collectDOMResult
	if err := json.Unmarshal(rawData, &data); err != nil {
		return "", collectDOMResult{}, err
	}
	_, nodesObjID, err := c.callOnObject(fctx, ps.SessionID, objID, `function() { return this.nodes; }`, nil, false, false, "chrome-control-refs")
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return "", collectDOMResult{}, errs.New("FRAME_TIMEOUT", "This frame did not answer the snapshot request.", "Keep Chrome foregrounded with the screen unlocked, then inspect again.", nil)
		}
		return "", collectDOMResult{}, err
	}
	return nodesObjID, data, nil
}

func (c *BrowserController) readARIATree(ctx context.Context, ps *PageState, timeout time.Duration) (string, error) {
	actx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	_ = cl.Call(actx, ps.SessionID, "Accessibility.enable", nil, nil)
	var res struct {
		Nodes []dom.AXNode `json:"nodes"`
	}
	if err := cl.Call(actx, ps.SessionID, "Accessibility.getFullAXTree", nil, &res); err != nil {
		return "", err
	}
	return dom.FormatARIATree(res.Nodes), nil
}

// Snapshot inspects the page DOM and/or accessibility tree, retaining actual DOM nodes for refs.
func (c *BrowserController) Snapshot(ctx context.Context, opts SnapshotOptions) (map[string]any, error) {
	if opts.MaxElements <= 0 {
		opts.MaxElements = 160
	}
	if opts.MaxText <= 0 {
		opts.MaxText = 12000
	}
	if opts.Mode == "" {
		opts.Mode = "dom"
	}
	if opts.Format == "" {
		opts.Format = "json"
	}

	ps, id, err := c.Page(ctx, opts.TabID, false)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	c.snapshotCount++
	c.mu.Unlock()

	if dlg := ps.getDialog(); dlg != nil {
		c.ClearRefs()
		rec := map[string]any{
			"tab_id":   id,
			"url":      ps.currentURL(),
			"dialog":   dlg,
			"frames":   []any{},
			"elements": []any{},
			"recovery": "Call browser_handle_dialog to accept or dismiss this dialog before interacting with the page.",
		}
		c.mu.Lock()
		c.lastSnapshot = rec
		c.mu.Unlock()
		return rec, nil
	}

	if opts.Mode == "aria" {
		c.ClearRefs()
		snapshotID := fmt.Sprintf("snapshot_%s_%d", c.prefix, c.sequence.Add(1))
		timeout := time.Duration(minInt(c.Config.ActionTimeout, 5000)) * time.Millisecond
		rawAria, err := c.readARIATree(ctx, ps, timeout)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) {
				return nil, errs.New("SNAPSHOT_TIMEOUT", "The selected tab did not answer the accessibility snapshot request.", "Call browser_status with reconnect: true, then select the intended tab.", map[string]any{"tab_id": id})
			}
			return nil, err
		}
		title := ps.currentTitle()
		if rawTitle, _, terr := c.evalInFrame(ctx, ps, ps.mainFrameID, `document.title`, true, false, ""); terr == nil {
			var t string
			if json.Unmarshal(rawTitle, &t) == nil && t != "" {
				title = t
				ps.mu.Lock()
				ps.title = t
				ps.mu.Unlock()
			}
		}
		out := map[string]any{
			"tab_id":      id,
			"snapshot_id": snapshotID,
			"mode":        "aria",
			"url":         ps.currentURL(),
			"title":       title,
			"aria_tree":   truncateString(rawAria, opts.MaxText),
			"frames":      []any{},
			"elements":    []any{},
		}
		if len(rawAria) > opts.MaxText {
			out["aria_truncated"] = true
		}
		if hints := c.FlowStore.HintsForURL(ps.currentURL()); len(hints) > 0 {
			out["saved_flows"] = hints
		}
		return out, nil
	}

	var scopeVal any
	if opts.Scope != "" {
		scopeVal = opts.Scope
	}
	var filterVal any
	if opts.Filter != "" {
		filterVal = opts.Filter
	}
	var rolesVal any
	if len(opts.Roles) > 0 {
		rolesVal = opts.Roles
	}
	filterKeyBytes, _ := json.Marshal(map[string]any{
		"viewport_only": opts.ViewportOnly,
		"scope":         scopeVal,
		"filter":        filterVal,
		"roles":         rolesVal,
		"include_bbox":  opts.IncludeBBox,
		"format":        opts.Format,
	})
	filterKey := string(filterKeyBytes)

	for attempt := 0; attempt < 2; attempt++ {
		c.ClearRefs()
		snapshotID := fmt.Sprintf("snapshot_%s_%d", c.prefix, c.sequence.Add(1))
		pageFrames := ps.orderedFrames()
		if len(pageFrames) == 0 {
			pageFrames = []FrameInfo{{ID: ps.mainFrameID, URL: ps.currentURL()}}
		}
		maxFrames := len(pageFrames)
		if maxFrames > 25 {
			maxFrames = 25
		}

		framesOut := make([]map[string]any, 0, maxFrames)
		warnings := make([]map[string]any, 0)
		elements := make([]map[string]any, 0)
		remainingElements := opts.MaxElements
		remainingText := opts.MaxText
		title := ps.currentTitle()
		var challenge map[string]any
		anyScopeMatched := opts.Scope == ""
		budgetMS := minInt(c.Config.ActionTimeout, c.Config.RequestTimeout-1000)
		until := time.Now().Add(time.Duration(budgetMS) * time.Millisecond)
		retry := false

		for idx := 0; idx < maxFrames; idx++ {
			frame := pageFrames[idx]
			frameID := fmt.Sprintf("frame_%d", idx)
			isMain := idx == 0
			rem := time.Until(until)
			if rem <= 0 && !isMain {
				warnings = append(warnings, map[string]any{"message": "Snapshot time budget exhausted; remaining frames were skipped."})
				break
			}
			frameTimeout := time.Duration(c.Config.ActionTimeout) * time.Millisecond
			if !isMain {
				frameTimeout = 1500 * time.Millisecond
			}
			if rem > 0 && rem < frameTimeout {
				frameTimeout = rem
			}
			if frameTimeout < 100*time.Millisecond {
				frameTimeout = 100 * time.Millisecond
			}

			nodesObjID, data, err := c.readFrameDOM(ctx, ps, frame, map[string]any{
				"maxElements":  remainingElements,
				"maxText":      remainingText,
				"viewportOnly": opts.ViewportOnly,
				"scope":        scopeVal,
				"filter":       filterVal,
				"roles":        rolesVal,
				"includeBbox":  opts.IncludeBBox,
			}, frameTimeout)
			if err != nil {
				if isMain && attempt == 0 && isContextDestroyedErr(err) {
					retry = true
					break
				}
				if isMain {
					var ce *errs.ControlError
					if errors.As(err, &ce) && ce.Code == "FRAME_TIMEOUT" {
						return nil, errs.New("SNAPSHOT_TIMEOUT", "The selected tab did not answer the snapshot request.", "Call browser_status with reconnect: true, then select the intended tab. Keep Chrome foregrounded with the screen unlocked.", map[string]any{"tab_id": id})
					}
					return nil, err
				}
				desc := errs.Describe(err)
				w := map[string]any{"frame_id": frameID, "error": desc.Message}
				if desc.Code != "BROWSER_ERROR" {
					w["code"] = desc.Code
					w["recovery"] = desc.Recovery
				}
				warnings = append(warnings, w)
				continue
			}

			if err := c.assertActive(); err != nil {
				return nil, err
			}
			if data.ScopeMatched == nil || *data.ScopeMatched {
				anyScopeMatched = true
			}
			if challenge == nil && len(data.Challenge) > 0 {
				ch := make(map[string]any, len(data.Challenge)+1)
				for k, v := range data.Challenge {
					ch[k] = v
				}
				ch["frame_id"] = frameID
				challenge = ch
			}
			if isMain {
				title = data.Title
				ps.mu.Lock()
				ps.title = title
				ps.mu.Unlock()
			}

			frameLabels := make([]string, 0, len(data.Elements))
			c.mu.Lock()
			for _, item := range data.Elements {
				shortID := fmt.Sprintf("e%d", len(elements)+1)
				ref := snapshotID + ":" + shortID
				nodeIdx := intFromAny(item["index"])
				c.refs[ref] = refEntry{
					SessionID:     ps.SessionID,
					FrameID:       frame.ID,
					NodesObjectID: nodesObjID,
					Index:         nodeIdx,
					TabID:         id,
				}
				frameLabels = append(frameLabels, shortID)
				elDesc := make(map[string]any, len(item)+1)
				for k, v := range item {
					if k == "index" {
						continue
					}
					elDesc[k] = v
				}
				elDesc["ref"] = ref
				elDesc["frame_id"] = frameID
				elements = append(elements, elDesc)
			}
			c.snapshotFrames = append(c.snapshotFrames, snapshotFrameEntry{
				SessionID:     ps.SessionID,
				FrameID:       frame.ID,
				NodesObjectID: nodesObjID,
				Stamp:         data.Stamp,
				Labels:        frameLabels,
			})
			c.mu.Unlock()

			framesOut = append(framesOut, map[string]any{
				"frame_id":           frameID,
				"url":                frame.URL,
				"name":               frame.Name,
				"text":               data.Text,
				"text_truncated":     data.TextTruncated,
				"elements_truncated": data.ElementsTruncated,
			})
			remainingElements -= len(data.Elements)
			if remainingElements < 0 {
				remainingElements = 0
			}
			remainingText -= len(data.Text)
			if remainingText < 0 {
				remainingText = 0
			}
		}

		if retry {
			_ = c.waitForDocumentReady(ctx, ps, 1500*time.Millisecond)
			continue
		}

		if opts.Scope != "" && !anyScopeMatched {
			warnings = append(warnings, map[string]any{
				"code":    "SCOPE_NOT_FOUND",
				"message": fmt.Sprintf("No element matched scope selector %q.", opts.Scope),
			})
		}
		if len(pageFrames) > 25 {
			warnings = append(warnings, map[string]any{"message": "Only the first 25 frames were inspected."})
		}

		base := map[string]any{
			"tab_id":      id,
			"snapshot_id": snapshotID,
			"url":         ps.currentURL(),
			"title":       title,
			"frames":      framesOut,
		}
		if opts.Mode == "both" {
			base["mode"] = "both"
			ariaTimeout := time.Duration(minInt(c.Config.ActionTimeout, 3000)) * time.Millisecond
			if rawAria, aerr := c.readARIATree(ctx, ps, ariaTimeout); aerr == nil {
				base["aria_tree"] = truncateString(rawAria, opts.MaxText)
				if len(rawAria) > opts.MaxText {
					base["aria_truncated"] = true
				}
			} else {
				warnings = append(warnings, map[string]any{"message": "Accessibility tree unavailable: " + aerr.Error()})
			}
		}
		if hints := c.FlowStore.HintsForURL(ps.currentURL()); len(hints) > 0 {
			base["saved_flows"] = hints
		}
		if challenge != nil {
			challenge["recovery"] = "Human verification is required. Pause automation, ask the user to complete this challenge directly in Chrome, and then call browser_snapshot to resume."
			base["human_interaction_required"] = challenge
		}
		if len(warnings) > 0 {
			base["warnings"] = warnings
		}

		fullRecord := cloneMap(base)
		fullRecord["elements"] = elements
		fullRecord["reference_help"] = "Use ref values from this snapshot. A new snapshot or action invalidates earlier references. Offscreen elements are scrolled into view during interaction."

		c.mu.Lock()
		c.snapshotFilterKey = filterKey
		c.lastSnapshotByTab[id] = fullRecord
		if opts.Format == "compact" {
			compactRecord := cloneMap(base)
			compactRecord["format"] = "compact"
			compactRecord["element_count"] = len(elements)
			compactRecord["elements_text"] = dom.FormatCompactElements(elements)
			c.lastSnapshot = compactRecord
			c.mu.Unlock()
			return compactRecord, nil
		}
		c.lastSnapshot = fullRecord
		c.mu.Unlock()
		return fullRecord, nil
	}
	return nil, errs.New("SNAPSHOT_FAILED", "Snapshot failed after retry.", "Call browser_snapshot again.", nil)
}

// CurrentSnapshot returns the cached snapshot if it is still valid for tabID and default filter options.
func (c *BrowserController) CurrentSnapshot(ctx context.Context, tabID string) (map[string]any, error) {
	c.mu.Lock()
	cached := c.lastSnapshot
	filterKey := c.snapshotFilterKey
	frames := append([]snapshotFrameEntry(nil), c.snapshotFrames...)
	c.mu.Unlock()

	if cached == nil || filterKey != defaultSnapshotKey {
		return nil, nil
	}
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if cached["tab_id"] != id || cached["url"] != ps.currentURL() {
		return nil, nil
	}
	if cached["dialog"] != nil {
		if ps.hasDialog() {
			return cached, nil
		}
		return nil, nil
	}
	if ps.hasDialog() || len(frames) != len(ps.orderedFrames()) {
		return nil, nil
	}
	for _, f := range frames {
		sctx, cancel := context.WithTimeout(ctx, 500*time.Millisecond)
		raw, _, err := c.callOnObject(sctx, f.SessionID, f.NodesObjectID, dom.ObservationStampJS, nil, true, false, "")
		cancel()
		if err != nil {
			return nil, nil
		}
		var stamp string
		if json.Unmarshal(raw, &stamp) != nil || stamp != f.Stamp {
			return nil, nil
		}
	}
	c.mu.Lock()
	stillSame := c.lastSnapshot != nil && c.lastSnapshot["snapshot_id"] == cached["snapshot_id"]
	c.mu.Unlock()
	if stillSame {
		return cached, nil
	}
	return nil, nil
}

// Summary returns lightweight page metadata without collecting DOM elements or issuing refs.
func (c *BrowserController) Summary(ctx context.Context, tabID string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return map[string]any{"tab_id": id, "url": ps.currentURL(), "dialog": dlg}, nil
	}
	raw, _, err := c.evalInFrame(ctx, ps, ps.mainFrameID, `({
		title: document.title,
		viewport: { width: innerWidth, height: innerHeight },
		scroll: { x: scrollX, y: scrollY },
		page: { width: document.scrollingElement?.scrollWidth || innerWidth, height: document.scrollingElement?.scrollHeight || innerHeight }
	})`, true, false, "")
	if err != nil {
		return nil, err
	}
	var info map[string]any
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, err
	}
	info["tab_id"] = id
	info["url"] = ps.currentURL()
	return info, nil
}

func cloneMap(src map[string]any) map[string]any {
	out := make(map[string]any, len(src))
	for k, v := range src {
		out[k] = v
	}
	return out
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func truncateString(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func intFromAny(v any) int {
	switch x := v.(type) {
	case int:
		return x
	case int64:
		return int(x)
	case float64:
		return int(x)
	default:
		return 0
	}
}
