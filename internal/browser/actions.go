package browser

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/dom"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

// WaitCondition represents wait_for options across actions and browser_wait.
type WaitCondition struct {
	Text        *string `json:"text,omitempty"`
	TextAbsent  *string `json:"text_absent,omitempty"`
	URL         *string `json:"url,omitempty"`
	Selector    *string `json:"selector,omitempty"`
	State       string  `json:"state,omitempty"`
	FrameID     string  `json:"frame_id,omitempty"`
	NetworkIdle bool    `json:"network_idle,omitempty"`
	IdleMS      int     `json:"idle_ms,omitempty"`
	TimeoutMS   int     `json:"timeout_ms,omitempty"`
}

// ActionArgs holds unified parameters for ordinary browser actions.
type ActionArgs struct {
	TabID        string
	Ref          string
	SourceRef    string
	TargetRef    string
	Button       string
	ClickCount   int
	Modifiers    []string
	Text         string
	PressEnter   bool
	Slowly       bool
	Values       []string
	Key          string
	IntoView     bool
	X            float64
	Y            float64
	DX           *float64
	DY           *float64
	Steps        int
	URL          string
	Milliseconds int
	WaitFor      *WaitCondition
	Snapshot     *bool
}

type actionPoint struct {
	X      float64
	Y      float64
	Left   float64
	Top    float64
	Width  float64
	Height float64
}

func modifierBitmask(modifiers []string) int {
	mask := 0
	for _, m := range modifiers {
		switch m {
		case "Alt":
			mask |= 1
		case "Control":
			mask |= 2
		case "Meta":
			mask |= 4
		case "Shift":
			mask |= 8
		}
	}
	return mask
}

func (c *BrowserController) resolveActionPoint(ctx context.Context, ps *PageState, objID, frameID string) (actionPoint, error) {
	stabilityMS := 50
	raw, _, err := c.callOnObject(ctx, ps.SessionID, objID, dom.ResolveActionPointJS, []any{stabilityMS}, true, true, "")
	if err != nil {
		return actionPoint{}, err
	}
	var res struct {
		OK        bool           `json:"ok"`
		Reason    string         `json:"reason"`
		CoveredBy map[string]any `json:"covered_by"`
		X         float64        `json:"x"`
		Y         float64        `json:"y"`
		Left      float64        `json:"left"`
		Top       float64        `json:"top"`
		Width     float64        `json:"width"`
		Height    float64        `json:"height"`
	}
	if err := json.Unmarshal(raw, &res); err != nil {
		return actionPoint{}, err
	}
	if !res.OK {
		details := map[string]any{}
		if res.Reason != "" {
			details["reason"] = res.Reason
		}
		if res.CoveredBy != nil {
			details["covered_by"] = res.CoveredBy
			tag, _ := res.CoveredBy["tag"].(string)
			role, _ := res.CoveredBy["role"].(string)
			txt, _ := res.CoveredBy["text"].(string)
			roleStr := ""
			if role != "" {
				roleStr = fmt.Sprintf(` role="%s"`, role)
			}
			txtStr := ""
			if txt != "" {
				txtStr = fmt.Sprintf(` ("%s")`, txt)
			}
			return actionPoint{}, errs.New(
				"ELEMENT_NOT_ACTIONABLE",
				fmt.Sprintf("The target is covered by <%s%s>%s.", tag, roleStr, txtStr),
				"Dismiss or scroll past the covering element, then inspect a fresh snapshot before trying again.",
				details,
			)
		}
		return actionPoint{}, errs.New(
			"ELEMENT_NOT_ACTIONABLE",
			"The target is hidden, disabled, covered or moving.",
			"Bring Chrome to the foreground and keep the screen unlocked. Inspect a fresh snapshot or screenshot before trying again.",
			details,
		)
	}

	pt := actionPoint{X: res.X, Y: res.Y, Left: res.Left, Top: res.Top, Width: res.Width, Height: res.Height}
	if frameID != "" && frameID != ps.mainFrameID {
		offX, offY, err := c.frameViewportOffset(ctx, ps, frameID, pt.X, pt.Y)
		if err != nil {
			return actionPoint{}, err
		}
		pt.X += offX
		pt.Y += offY
		pt.Left += offX
		pt.Top += offY
	}
	return pt, nil
}

func (c *BrowserController) frameViewportOffset(ctx context.Context, ps *PageState, frameID string, localX, localY float64) (float64, float64, error) {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	var offX, offY float64
	curID := frameID
	curX, curY := localX, localY

	for curID != "" && curID != ps.mainFrameID {
		var owner struct {
			BackendNodeID int `json:"backendNodeId"`
		}
		if err := cl.Call(ctx, ps.SessionID, "DOM.getFrameOwner", map[string]any{"frameId": curID}, &owner); err != nil || owner.BackendNodeID == 0 {
			return 0, 0, errs.New("ELEMENT_NOT_ACTIONABLE", "Cannot map iframe coordinates into viewport.", "Keep Chrome foregrounded and inspect a fresh snapshot.", nil)
		}
		var resolved struct {
			Object struct {
				ObjectID string `json:"objectId"`
			} `json:"object"`
		}
		if err := cl.Call(ctx, ps.SessionID, "DOM.resolveNode", map[string]any{"backendNodeId": owner.BackendNodeID, "objectGroup": "chrome-control-target"}, &resolved); err != nil || resolved.Object.ObjectID == "" {
			return 0, 0, errs.New("ELEMENT_NOT_ACTIONABLE", "Cannot resolve iframe host element.", "Keep Chrome foregrounded and inspect a fresh snapshot.", nil)
		}
		hostObjID := resolved.Object.ObjectID
		raw, _, err := c.callOnObject(ctx, ps.SessionID, hostObjID, `function(px, py) {
			const node = this;
			if (!node.isConnected) return { ok: false, reason: 'detached' };
			const style = getComputedStyle(node);
			if (style.transform && style.transform !== 'none') return { ok: false, reason: 'transformed' };
			const box = node.getBoundingClientRect();
			const ox = box.left + (node.clientLeft || 0);
			const oy = box.top + (node.clientTop || 0);
			const tx = ox + px, ty = oy + py;
			if (tx < 0 || ty < 0 || tx >= innerWidth || ty >= innerHeight) return { ok: false, reason: 'outside_viewport' };
			let hit = document.elementFromPoint(tx, ty);
			while (hit?.shadowRoot) {
				const next = hit.shadowRoot.elementFromPoint(tx, ty);
				if (!next || next === hit) break;
				hit = next;
			}
			if (hit !== node) {
				return {
					ok: false,
					reason: 'covered',
					covered_by: hit ? {
						tag: hit.tagName.toLowerCase(),
						...(hit.id ? { id: hit.id } : {}),
						...(hit.getAttribute?.('role') ? { role: hit.getAttribute('role') } : {}),
						...((hit.innerText || hit.getAttribute?.('aria-label') || '').trim()
							? { text: (hit.innerText || hit.getAttribute?.('aria-label') || '').trim().slice(0, 120) }
							: {}),
					} : undefined,
				};
			}
			return { ok: true, ox, oy };
		}`, []any{curX, curY}, true, false, "")
		c.releaseObject(ps.SessionID, hostObjID)
		if err != nil {
			return 0, 0, err
		}
		var hostCheck struct {
			OK        bool           `json:"ok"`
			Reason    string         `json:"reason"`
			CoveredBy map[string]any `json:"covered_by"`
			OX        float64        `json:"ox"`
			OY        float64        `json:"oy"`
		}
		if err := json.Unmarshal(raw, &hostCheck); err != nil {
			return 0, 0, err
		}
		if !hostCheck.OK {
			details := map[string]any{}
			if hostCheck.Reason != "" {
				details["reason"] = hostCheck.Reason
			}
			if hostCheck.CoveredBy != nil {
				details["covered_by"] = hostCheck.CoveredBy
			}
			return 0, 0, errs.New("ELEMENT_NOT_ACTIONABLE", "An ancestor iframe is outside the viewport, transformed, or covered at the requested point.", "Dismiss or scroll past the covering element in the parent page, then inspect a fresh snapshot.", details)
		}
		offX += hostCheck.OX
		offY += hostCheck.OY
		curX += hostCheck.OX
		curY += hostCheck.OY

		ps.mu.Lock()
		f := ps.frames[curID]
		parentID := ""
		if f != nil {
			parentID = f.ParentID
		}
		ps.mu.Unlock()
		if parentID == curID {
			break
		}
		curID = parentID
	}
	return offX, offY, nil
}

func (c *BrowserController) dispatchMouseClick(ctx context.Context, ps *PageState, x, y float64, button string, clickCount int, modifiers int) error {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if button == "" {
		button = "left"
	}
	if clickCount <= 0 {
		clickCount = 1
	}
	if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
		"type":      "mouseMoved",
		"x":         x,
		"y":         y,
		"modifiers": modifiers,
	}, nil); err != nil {
		return err
	}
	for i := 1; i <= clickCount; i++ {
		if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mousePressed",
			"x":          x,
			"y":          y,
			"button":     button,
			"clickCount": i,
			"modifiers":  modifiers,
		}, nil); err != nil {
			return err
		}
		if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
			"type":       "mouseReleased",
			"x":          x,
			"y":          y,
			"button":     button,
			"clickCount": i,
			"modifiers":  modifiers,
		}, nil); err != nil {
			return err
		}
	}
	return nil
}

type keyDef struct {
	Key  string
	Code string
	VK   int
	Text string
}

var namedKeys = map[string]keyDef{
	"Enter":      {Key: "Enter", Code: "Enter", VK: 13, Text: "\r"},
	"Tab":        {Key: "Tab", Code: "Tab", VK: 9},
	"Escape":     {Key: "Escape", Code: "Escape", VK: 27},
	"Backspace":  {Key: "Backspace", Code: "Backspace", VK: 8},
	"Delete":     {Key: "Delete", Code: "Delete", VK: 46},
	"Space":      {Key: " ", Code: "Space", VK: 32, Text: " "},
	" ":          {Key: " ", Code: "Space", VK: 32, Text: " "},
	"ArrowUp":    {Key: "ArrowUp", Code: "ArrowUp", VK: 38},
	"ArrowDown":  {Key: "ArrowDown", Code: "ArrowDown", VK: 40},
	"ArrowLeft":  {Key: "ArrowLeft", Code: "ArrowLeft", VK: 37},
	"ArrowRight": {Key: "ArrowRight", Code: "ArrowRight", VK: 39},
	"Home":       {Key: "Home", Code: "Home", VK: 36},
	"End":        {Key: "End", Code: "End", VK: 35},
	"PageUp":     {Key: "PageUp", Code: "PageUp", VK: 33},
	"PageDown":   {Key: "PageDown", Code: "PageDown", VK: 34},
	"Insert":     {Key: "Insert", Code: "Insert", VK: 45},
	"Control":    {Key: "Control", Code: "ControlLeft", VK: 17},
	"Shift":      {Key: "Shift", Code: "ShiftLeft", VK: 16},
	"Alt":        {Key: "Alt", Code: "AltLeft", VK: 18},
	"Meta":       {Key: "Meta", Code: "MetaLeft", VK: 91},
}

func resolveKeyDef(name string) keyDef {
	if def, ok := namedKeys[name]; ok {
		return def
	}
	if strings.HasPrefix(name, "F") && len(name) <= 3 {
		if n, err := strconv.Atoi(name[1:]); err == nil && n >= 1 && n <= 12 {
			return keyDef{Key: name, Code: name, VK: 111 + n}
		}
	}
	runes := []rune(name)
	if len(runes) == 1 {
		r := runes[0]
		upper := strings.ToUpper(string(r))
		vk := int(upper[0])
		code := ""
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			code = "Key" + upper
		} else if r >= '0' && r <= '9' {
			code = "Digit" + string(r)
		}
		return keyDef{Key: string(r), Code: code, VK: vk, Text: string(r)}
	}
	return keyDef{Key: name, Code: name}
}

func (c *BrowserController) dispatchKeyChord(ctx context.Context, ps *PageState, chord string) error {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	parts := strings.Split(chord, "+")
	var mods []string
	mainKey := parts[len(parts)-1]
	for _, p := range parts[:len(parts)-1] {
		switch p {
		case "Control", "Ctrl":
			mods = append(mods, "Control")
		case "Shift", "Alt", "Meta":
			mods = append(mods, p)
		}
	}
	modMask := modifierBitmask(mods)

	for _, m := range mods {
		kd := resolveKeyDef(m)
		_ = cl.Call(ctx, ps.SessionID, "Input.dispatchKeyEvent", map[string]any{
			"type":                  "rawKeyDown",
			"key":                   kd.Key,
			"code":                  kd.Code,
			"windowsVirtualKeyCode": kd.VK,
			"modifiers":             modMask,
		}, nil)
	}
	kd := resolveKeyDef(mainKey)
	downType := "keyDown"
	if kd.Text == "" || (modMask&(2|4|1)) != 0 {
		downType = "rawKeyDown"
	}
	downParams := map[string]any{
		"type":                  downType,
		"key":                   kd.Key,
		"windowsVirtualKeyCode": kd.VK,
		"modifiers":             modMask,
	}
	if kd.Code != "" {
		downParams["code"] = kd.Code
	}
	if downType == "keyDown" && kd.Text != "" {
		downParams["text"] = kd.Text
		downParams["unmodifiedText"] = kd.Text
	}
	if err := cl.Call(ctx, ps.SessionID, "Input.dispatchKeyEvent", downParams, nil); err != nil {
		return err
	}
	upParams := map[string]any{
		"type":                  "keyUp",
		"key":                   kd.Key,
		"windowsVirtualKeyCode": kd.VK,
		"modifiers":             modMask,
	}
	if kd.Code != "" {
		upParams["code"] = kd.Code
	}
	if err := cl.Call(ctx, ps.SessionID, "Input.dispatchKeyEvent", upParams, nil); err != nil {
		return err
	}
	for i := len(mods) - 1; i >= 0; i-- {
		m := resolveKeyDef(mods[i])
		_ = cl.Call(ctx, ps.SessionID, "Input.dispatchKeyEvent", map[string]any{
			"type":                  "keyUp",
			"key":                   m.Key,
			"code":                  m.Code,
			"windowsVirtualKeyCode": m.VK,
		}, nil)
	}
	return nil
}

// TypeText inserts literal text at the currently focused element via CDP Input.insertText.
func (c *BrowserController) TypeText(ctx context.Context, tabID, text string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if ps.hasDialog() {
		return nil, errs.New("DIALOG_OPEN", "A dialog blocks typing.", "Call handle_dialog() explicitly.", map[string]any{"dialog": ps.getDialog()})
	}
	if err := c.NoteInput("type_text", id); err != nil {
		return nil, err
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()
	if err := cl.Call(ctx, ps.SessionID, "Input.insertText", map[string]any{"text": text}, nil); err != nil {
		return nil, err
	}
	c.SetOutcomeExecuted()
	c.ClearRefs()
	return map[string]any{"executed": true}, nil
}

// WaitForLoadState waits for domcontentloaded, load, or networkidle.
func (c *BrowserController) WaitForLoadState(ctx context.Context, tabID, state string) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	timeout := time.Duration(minInt(5000, c.Config.ActionTimeout)) * time.Millisecond
	switch state {
	case "networkidle":
		_, stream, _, err := c.Events(ctx, id)
		if err != nil {
			return nil, err
		}
		_, err = stream.Idle(ctx, 500, int(timeout.Milliseconds()))
		if err != nil {
			return nil, err
		}
	case "load":
		deadline := time.Now().Add(timeout)
		for time.Now().Before(deadline) {
			raw, _, err := c.evalInFrame(ctx, ps, ps.mainFrameID, `document.readyState`, true, false, "")
			if err == nil {
				var rs string
				if json.Unmarshal(raw, &rs) == nil && rs == "complete" {
					break
				}
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
	default:
		_ = c.waitForDocumentReady(ctx, ps, timeout)
	}
	return map[string]any{"loaded": true, "state": state}, nil
}

// Action executes a single browser action and returns the observed result + diff summary.
func (c *BrowserController) Action(ctx context.Context, name string, args ActionArgs) (map[string]any, error) {
	ps, id, err := c.Page(ctx, args.TabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is blocking this tab.", "Call browser_handle_dialog to accept or dismiss it.", map[string]any{"dialog": dlg})
	}

	c.mu.Lock()
	beforeTabIDs := make(map[string]bool, len(c.tabInfo))
	for k := range c.tabInfo {
		beforeTabIDs[k] = true
	}
	var prevSnapshot map[string]any
	if name != "wait" {
		prevSnapshot = c.lastSnapshotByTab[id]
	}
	c.mu.Unlock()

	ps.mu.Lock()
	beforeDownloads := len(ps.downloads)
	ps.mu.Unlock()

	var targetObjID, targetFrameID string
	refValue := args.Ref
	if refValue == "" {
		refValue = args.SourceRef
	}
	if refValue != "" {
		targetObjID, targetFrameID, err = c.ResolveRef(ctx, refValue, ps)
		if err != nil {
			return nil, err
		}
		defer c.releaseObject(ps.SessionID, targetObjID)
	}

	timeout := time.Duration(c.Config.ActionTimeout) * time.Millisecond
	if err := c.perform(ctx, ps, id, name, args, targetObjID, targetFrameID, timeout); err != nil {
		var ce *errs.ControlError
		if errors.As(err, &ce) && ce.Code == "STALE_REF" {
			return nil, err
		}
		c.ClearRefs()
		if dlg := ps.getDialog(); dlg != nil {
			return nil, errs.New("DIALOG_OPEN", "The action opened a blocking JavaScript dialog.", "Call browser_handle_dialog. Inspect the page before repeating the action.", map[string]any{
				"action":            name,
				"may_have_executed": true,
				"dialog":            dlg,
			})
		}
		return nil, err
	}
	if name != "wait" {
		c.SetOutcomeExecuted()
	}
	includeSnapshot := args.Snapshot == nil || *args.Snapshot
	if !(name == "wait" && !includeSnapshot) {
		c.ClearRefs()
	}

	return c.Observe(ctx, ps, id, map[string]any{"action": name, "executed": true}, args.WaitFor, name == "wait", includeSnapshot, ObserveMeta{
		BeforeTabIDs:    beforeTabIDs,
		BeforeDownloads: beforeDownloads,
		HasDownloads:    true,
		PrevSnapshot:    prevSnapshot,
	})
}

func (c *BrowserController) perform(ctx context.Context, ps *PageState, id, name string, args ActionArgs, targetObjID, targetFrameID string, timeout time.Duration) error {
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	if name == "click" {
		_ = cl.Call(ctx, ps.SessionID, "Page.setInterceptFileChooserDialog", map[string]any{"enabled": true}, nil)
		defer func() {
			rctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
			defer cancel()
			_ = cl.Call(rctx, ps.SessionID, "Page.setInterceptFileChooserDialog", map[string]any{"enabled": false}, nil)
		}()
	}

	actx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	err := c.untilDialog(actx, ps, func() error {
		if err := c.assertActive(); err != nil {
			return err
		}
		if name != "click" && name != "hover" && name != "drag" && name != "wait" {
			if err := c.NoteInput(name, id); err != nil {
				return err
			}
		}

		switch name {
		case "click":
			pt, err := c.resolveActionPoint(actx, ps, targetObjID, targetFrameID)
			if err != nil {
				return err
			}
			if err := c.NoteInput("click", id); err != nil {
				return err
			}
			return c.dispatchMouseClick(actx, ps, pt.X, pt.Y, args.Button, args.ClickCount, modifierBitmask(args.Modifiers))

		case "hover":
			pt, err := c.resolveActionPoint(actx, ps, targetObjID, targetFrameID)
			if err != nil {
				return err
			}
			if err := c.NoteInput("hover", id); err != nil {
				return err
			}
			return cl.Call(actx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
				"type": "mouseMoved",
				"x":    pt.X,
				"y":    pt.Y,
			}, nil)

		case "drag":
			return c.performDrag(actx, ps, id, args, targetObjID, targetFrameID)

		case "fill":
			c.mu.Lock()
			capture := c.flowCaptures[id]
			c.mu.Unlock()
			isPassword := false
			if capture != nil {
				if raw, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, `function() { return this.tagName === 'INPUT' && this.type === 'password'; }`, nil, true, false, ""); err == nil {
					_ = json.Unmarshal(raw, &isPassword)
				}
			}
			if args.Slowly {
				if _, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, dom.FillElementJS, []any{""}, true, false, ""); err != nil {
					return err
				}
				for _, r := range args.Text {
					if err := cl.Call(actx, ps.SessionID, "Input.insertText", map[string]any{"text": string(r)}, nil); err != nil {
						return err
					}
					select {
					case <-actx.Done():
						return actx.Err()
					case <-time.After(20 * time.Millisecond):
					}
				}
			} else {
				raw, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, dom.FillElementJS, []any{args.Text}, true, false, "")
				if err != nil {
					return err
				}
				var res struct {
					OK     bool   `json:"ok"`
					Reason string `json:"reason"`
				}
				if json.Unmarshal(raw, &res) == nil && !res.OK {
					return errs.New("ELEMENT_NOT_ACTIONABLE", "The input target is detached, disabled, or not fillable.", "Inspect a fresh snapshot and select an editable textbox or textarea.", map[string]any{"reason": res.Reason})
				}
			}
			if args.PressEnter {
				if err := c.dispatchKeyChord(actx, ps, "Enter"); err != nil {
					return err
				}
			}
			if capture != nil {
				capture.NoteInput(args.Text, isPassword)
			}
			return nil

		case "select":
			raw, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, dom.SelectOptionJS, []any{args.Values}, true, false, "")
			if err != nil {
				return err
			}
			var res struct {
				OK     bool   `json:"ok"`
				Reason string `json:"reason"`
			}
			if json.Unmarshal(raw, &res) == nil && !res.OK {
				return errs.New("ELEMENT_NOT_ACTIONABLE", "Could not select the requested option(s).", "Verify option values or labels from a fresh snapshot.", map[string]any{"reason": res.Reason})
			}
			return nil

		case "press":
			if targetObjID != "" {
				_, _, _ = c.callOnObject(actx, ps.SessionID, targetObjID, `function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); this.focus(); }`, nil, true, false, "")
			}
			return c.dispatchKeyChord(actx, ps, args.Key)

		case "scroll":
			if args.IntoView && targetObjID == "" {
				return errs.New("REF_REQUIRED", "into_view requires an element ref.", "Choose a current element ref from browser_snapshot.", nil)
			}
			if args.IntoView {
				_, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, `function() { this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); }`, nil, true, false, "")
				return err
			}
			if targetObjID != "" {
				_, _, err := c.callOnObject(actx, ps.SessionID, targetObjID, `function(x, y) { this.scrollBy({ left: x, top: y, behavior: 'instant' }); }`, []any{args.X, args.Y}, true, false, "")
				return err
			}
			expr := fmt.Sprintf("(%s)({ x: %v, y: %v })", dom.ScrollDOMJS, args.X, args.Y)
			_, _, err := c.evalInFrame(actx, ps, ps.mainFrameID, expr, true, false, "")
			return err

		case "navigate":
			var navRes struct {
				ErrorText string `json:"errorText"`
			}
			if err := cl.Call(actx, ps.SessionID, "Page.navigate", map[string]any{"url": args.URL}, &navRes); err != nil {
				return err
			}
			if navRes.ErrorText != "" {
				return fmt.Errorf("navigation failed: %s", navRes.ErrorText)
			}
			return c.waitForDocumentReady(actx, ps, timeout)

		case "back", "forward":
			var hist struct {
				CurrentIndex int `json:"currentIndex"`
				Entries      []struct {
					ID int `json:"id"`
				} `json:"entries"`
			}
			if err := cl.Call(actx, ps.SessionID, "Page.getNavigationHistory", nil, &hist); err != nil {
				return err
			}
			delta := -1
			if name == "forward" {
				delta = 1
			}
			nextIdx := hist.CurrentIndex + delta
			if nextIdx < 0 || nextIdx >= len(hist.Entries) {
				return nil
			}
			if err := cl.Call(actx, ps.SessionID, "Page.navigateToHistoryEntry", map[string]any{"entryId": hist.Entries[nextIdx].ID}, nil); err != nil {
				return err
			}
			return c.waitForDocumentReady(actx, ps, timeout)

		case "reload":
			if err := cl.Call(actx, ps.SessionID, "Page.reload", map[string]any{}, nil); err != nil {
				return err
			}
			return c.waitForDocumentReady(actx, ps, timeout)

		case "wait":
			if args.WaitFor == nil {
				select {
				case <-actx.Done():
					return actx.Err()
				case <-time.After(time.Duration(args.Milliseconds) * time.Millisecond):
				}
			}
			return nil

		case "tap":
			return c.dispatchMouseClick(actx, ps, args.X, args.Y, "left", 1, 0)

		default:
			return fmt.Errorf("unknown action: %s", name)
		}
	})
	if err != nil {
		return err
	}
	if name == "click" {
		time.Sleep(100 * time.Millisecond)
	}
	return nil
}

func (c *BrowserController) performDrag(ctx context.Context, ps *PageState, id string, args ActionArgs, srcObjID, srcFrameID string) error {
	srcPt, err := c.resolveActionPoint(ctx, ps, srcObjID, srcFrameID)
	if err != nil {
		return err
	}
	var endX, endY float64
	if args.TargetRef != "" {
		dstObjID, dstFrameID, err := c.ResolveRef(ctx, args.TargetRef, ps)
		if err != nil {
			return err
		}
		defer c.releaseObject(ps.SessionID, dstObjID)
		dstPt, err := c.resolveActionPoint(ctx, ps, dstObjID, dstFrameID)
		if err != nil {
			return err
		}
		endX, endY = dstPt.X, dstPt.Y
	} else {
		if args.DX == nil && args.DY == nil {
			return errs.New("DRAG_TARGET_REQUIRED", "Provide target_ref or dx/dy pixel offset for drag.", "Pass target_ref for drag-and-drop, or dx/dy for dragging a slider or swiping.", nil)
		}
		dx, dy := 0.0, 0.0
		if args.DX != nil {
			dx = *args.DX
		}
		if args.DY != nil {
			dy = *args.DY
		}
		endX = srcPt.X + dx
		endY = srcPt.Y + dy
	}

	steps := args.Steps
	if steps <= 0 {
		steps = 8
	}
	if err := c.NoteInput("drag", id); err != nil {
		return err
	}
	c.mu.Lock()
	cl := c.client
	c.mu.Unlock()

	if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseMoved", "x": srcPt.X, "y": srcPt.Y,
	}, nil); err != nil {
		return err
	}
	if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
		"type": "mousePressed", "x": srcPt.X, "y": srcPt.Y, "button": "left", "clickCount": 1,
	}, nil); err != nil {
		return err
	}
	for i := 1; i <= steps; i++ {
		t := float64(i) / float64(steps)
		cx := srcPt.X + (endX-srcPt.X)*t
		cy := srcPt.Y + (endY-srcPt.Y)*t
		if err := cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
			"type": "mouseMoved", "x": math.Round(cx*100) / 100, "y": math.Round(cy*100) / 100, "button": "left", "buttons": 1,
		}, nil); err != nil {
			return err
		}
	}
	return cl.Call(ctx, ps.SessionID, "Input.dispatchMouseEvent", map[string]any{
		"type": "mouseReleased", "x": endX, "y": endY, "button": "left", "clickCount": 1,
	}, nil)
}

// WaitFor waits for DOM text/url/selector conditions and/or network_idle.
func (c *BrowserController) WaitFor(ctx context.Context, ps *PageState, cond *WaitCondition, tabID string) (map[string]any, error) {
	if cond == nil {
		return map[string]any{"matched": true}, nil
	}
	timeoutMS := cond.TimeoutMS
	if timeoutMS <= 0 {
		timeoutMS = 5000
	}
	maxBudget := c.Config.RequestTimeout - 2000
	if maxBudget < 5000 {
		maxBudget = 5000
	}
	if timeoutMS > maxBudget {
		timeoutMS = maxBudget
	}
	started := time.Now()
	deadline := started.Add(time.Duration(timeoutMS) * time.Millisecond)

	hasDom := cond.Text != nil || cond.TextAbsent != nil || cond.URL != nil || cond.Selector != nil
	if hasDom {
		frameID := ps.mainFrameID
		if cond.FrameID != "" {
			idx, err := strconv.Atoi(strings.TrimPrefix(cond.FrameID, "frame_"))
			if err != nil {
				return nil, errs.New("FRAME_UNAVAILABLE", "The wait frame no longer exists.", "Inspect page_info() and use a current frame_id.", nil)
			}
			f, ok := ps.frameByIndex(idx)
			if !ok {
				return nil, errs.New("FRAME_UNAVAILABLE", "The wait frame no longer exists.", "Inspect page_info() and use a current frame_id.", nil)
			}
			frameID = f.ID
		}
		condJSON, _ := json.Marshal(cond)
		expr := "(" + dom.WaitForCheckJS + ")(" + string(condJSON) + ")"

		matched := false
		for {
			tctx, cancel := context.WithTimeout(ctx, 1000*time.Millisecond)
			raw, _, err := c.evalInFrame(tctx, ps, frameID, expr, true, false, "")
			cancel()
			if err == nil {
				var ok bool
				if json.Unmarshal(raw, &ok) == nil && ok {
					matched = true
					break
				}
			}
			if !time.Now().Before(deadline) {
				break
			}
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
		if err := c.assertActive(); err != nil {
			return nil, err
		}
		if !matched {
			return map[string]any{
				"matched":    false,
				"timeout_ms": timeoutMS,
				"recovery":   "Inspect the returned snapshot. The action is not repeated when a condition times out.",
			}, nil
		}
	}

	if cond.NetworkIdle {
		remMS := int(time.Until(deadline).Milliseconds())
		if remMS < 100 {
			remMS = 100
		}
		_, stream, _, err := c.Events(ctx, tabID)
		if err != nil {
			return nil, err
		}
		idleMS := cond.IdleMS
		if idleMS <= 0 {
			idleMS = 500
		}
		idleRes, err := stream.Idle(ctx, idleMS, remMS)
		if err != nil {
			return nil, err
		}
		if !idleRes.Matched {
			return map[string]any{
				"matched":          false,
				"timeout_ms":       idleRes.TimeoutMS,
				"pending_requests": idleRes.PendingRequests,
				"recovery":         idleRes.Recovery,
			}, nil
		}
	}
	return map[string]any{"matched": true}, nil
}

// ObserveMeta carries optional pre-action context for diffs, popups, and downloads.
type ObserveMeta struct {
	BeforeTabIDs    map[string]bool
	BeforeDownloads int
	HasDownloads    bool
	PrevSnapshot    map[string]any
}

// Observe waits (if configured), attaches popup/download/file-chooser hints, and takes a fresh snapshot with diff summary.
func (c *BrowserController) Observe(ctx context.Context, ps *PageState, id string, output map[string]any, cond *WaitCondition, alreadyWaited, includeSnapshot bool, meta ObserveMeta) (map[string]any, error) {
	output["tab_id"] = id
	ps.mu.Lock()
	hasDialog := ps.dialog != nil
	chooser := ps.fileChooser
	ps.mu.Unlock()

	if !hasDialog && chooser == nil {
		if cond != nil {
			wres, err := c.WaitFor(ctx, ps, cond, id)
			if err != nil {
				output["wait_error"] = errs.Describe(err)
			} else {
				output["wait"] = wres
			}
		} else if !alreadyWaited && includeSnapshot {
			time.Sleep(150 * time.Millisecond)
		}
	}
	if err := c.assertActive(); err != nil {
		return nil, err
	}

	ps.mu.Lock()
	chooser = ps.fileChooser
	ps.mu.Unlock()
	if chooser != nil {
		output["file_chooser"] = map[string]any{
			"multiple": chooser.Multiple,
			"recovery": "Call browser_upload with local file paths. The native file picker was intercepted.",
		}
	}

	if meta.BeforeTabIDs != nil {
		if _, err := c.SyncPages(ctx); err == nil {
			c.mu.Lock()
			var opened []map[string]any
			for _, tid := range c.tabOrder {
				if !meta.BeforeTabIDs[tid] {
					info := c.tabInfo[tid]
					t := info.Title
					if t == "" {
						t = "(loading)"
					}
					opened = append(opened, map[string]any{"tab_id": tid, "url": info.URL, "title": t})
				}
			}
			c.mu.Unlock()
			if len(opened) > 0 {
				output["new_tabs"] = opened
				output["new_tabs_hint"] = "A new tab opened. Call browser_select_tab with its tab_id to inspect or interact with it."
			}
		}
	}

	if meta.HasDownloads {
		ps.mu.Lock()
		var recent []*DownloadRecord
		if meta.BeforeDownloads < len(ps.downloads) {
			recent = append(recent, ps.downloads[meta.BeforeDownloads:]...)
		}
		ps.mu.Unlock()
		if len(recent) > 0 {
			output["downloads"] = recent
			output["downloads_hint"] = "A file download started. Call browser_downloads to inspect or save it to a specific local path."
		}
	}

	if !includeSnapshot {
		c.mu.Lock()
		output["refs_invalidated"] = c.lastSnapshot == nil
		c.mu.Unlock()
		return output, nil
	}

	snap, err := c.Snapshot(ctx, SnapshotOptions{TabID: id})
	if err != nil {
		output["observation_error"] = errs.Describe(err)
		output["recovery"] = "Inspect the page before repeating any completed actions."
		return output, nil
	}
	if meta.PrevSnapshot != nil {
		c.mu.Lock()
		currFull := c.lastSnapshotByTab[id]
		c.mu.Unlock()
		if changes := dom.DiffSnapshots(meta.PrevSnapshot, currFull); changes != nil {
			output["changes"] = changes
		}
	}
	output["snapshot"] = snap
	return output, nil
}

// PlannedAction represents one step inside browser_batch.
type PlannedAction struct {
	Action     string   `json:"action"`
	Ref        string   `json:"ref,omitempty"`
	Button     string   `json:"button,omitempty"`
	ClickCount int      `json:"click_count,omitempty"`
	Modifiers  []string `json:"modifiers,omitempty"`
	Text       string   `json:"text,omitempty"`
	PressEnter bool     `json:"press_enter,omitempty"`
	Slowly     bool     `json:"slowly,omitempty"`
	Values     []string `json:"values,omitempty"`
	Key        string   `json:"key,omitempty"`
}

// Batch executes up to 10 known actions from one snapshot, verifying node identity before each step.
func (c *BrowserController) Batch(ctx context.Context, tabID string, actions []PlannedAction, waitFor *WaitCondition, includeSnapshot bool) (map[string]any, error) {
	ps, id, err := c.Page(ctx, tabID, false)
	if err != nil {
		return nil, err
	}
	if dlg := ps.getDialog(); dlg != nil {
		return nil, errs.New("DIALOG_OPEN", "A JavaScript dialog is blocking this tab.", "Call browser_handle_dialog.", map[string]any{"dialog": dlg})
	}

	c.mu.Lock()
	beforeTabIDs := make(map[string]bool, len(c.tabInfo))
	for k := range c.tabInfo {
		beforeTabIDs[k] = true
	}
	prevSnapshot := c.lastSnapshotByTab[id]
	c.mu.Unlock()
	ps.mu.Lock()
	beforeDownloads := len(ps.downloads)
	ps.mu.Unlock()

	type resolvedTarget struct {
		objID     string
		frameID   string
		signature string
	}
	targets := make([]resolvedTarget, 0, len(actions))
	defer func() {
		for _, t := range targets {
			c.releaseObject(ps.SessionID, t.objID)
		}
	}()

	watchedFrames := map[string]bool{ps.mainFrameID: true}
	for _, act := range actions {
		if act.Ref == "" {
			targets = append(targets, resolvedTarget{})
			continue
		}
		objID, frameID, err := c.ResolveRef(ctx, act.Ref, ps)
		if err != nil {
			return nil, err
		}
		rawSig, _, err := c.callOnObject(ctx, ps.SessionID, objID, dom.IdentityJS, nil, true, false, "")
		if err != nil {
			c.releaseObject(ps.SessionID, objID)
			return nil, err
		}
		var sig string
		_ = json.Unmarshal(rawSig, &sig)
		targets = append(targets, resolvedTarget{objID: objID, frameID: frameID, signature: sig})
		if frameID != "" {
			watchedFrames[frameID] = true
		}
	}

	var navigated atomic.Bool
	unsubNav := ps.addNavListener(func(fid string) {
		if watchedFrames[fid] {
			navigated.Store(true)
		}
	})
	defer unsubNav()

	budgetMS := c.Config.RequestTimeout - minInt(c.Config.ActionTimeout, c.Config.RequestTimeout/3) - 2000
	if budgetMS < 1000 {
		budgetMS = 1000
	}
	until := time.Now().Add(time.Duration(budgetMS) * time.Millisecond)

	results := make([]map[string]any, 0, len(actions))
	var stopped map[string]any

	for i, act := range actions {
		if err := c.assertActive(); err != nil {
			return nil, err
		}
		ps.mu.Lock()
		hasDlg := ps.dialog != nil
		hasChooser := ps.fileChooser != nil
		ps.mu.Unlock()
		if navigated.Load() || hasDlg || hasChooser {
			reason := "page_changed"
			if hasDlg {
				reason = "dialog_open"
			} else if hasChooser {
				reason = "file_chooser_open"
			}
			stopped = map[string]any{"index": i, "reason": reason}
			break
		}
		if !time.Now().Before(until) {
			stopped = map[string]any{"index": i, "reason": "time_budget"}
			break
		}

		t := targets[i]
		c.mu.Lock()
		c.Outcome = map[string]any{
			"action":       "batch",
			"tab_id":       id,
			"action_index": i,
			"executed":     len(results) > 0,
			"results":      append([]map[string]any(nil), results...),
		}
		c.mu.Unlock()

		if t.objID != "" {
			rawCheck, _, err := c.callOnObject(ctx, ps.SessionID, t.objID, `function() {
				const node = this;
				return {
					connected: Boolean(node && node.isConnected),
					sig: JSON.stringify({
						tag: node.tagName,
						type: node.getAttribute('type'),
						label: node.getAttribute('aria-label'),
						text: ['BUTTON', 'A', 'SUMMARY'].includes(node.tagName) || node.getAttribute('role') === 'button' ? node.textContent : null,
						value: ['radio', 'checkbox'].includes(node.type) ? node.value : null,
					})
				};
			}`, nil, true, false, "")
			var chk struct {
				Connected bool   `json:"connected"`
				Sig       string `json:"sig"`
			}
			if err != nil || json.Unmarshal(rawCheck, &chk) != nil || !chk.Connected || chk.Sig != t.signature {
				staleErr := errs.New("STALE_REF", "A planned element was removed or changed after an earlier action.", "Inspect the returned snapshot and plan the remaining actions again.", nil)
				stopped = map[string]any{"index": i, "reason": "action_error", "error": errs.Describe(staleErr)}
				break
			}
		}

		stepTimeout := time.Duration(c.Config.ActionTimeout) * time.Millisecond
		if rem := time.Until(until); rem < stepTimeout {
			stepTimeout = rem
		}
		aArgs := ActionArgs{
			TabID:      id,
			Ref:        act.Ref,
			Button:     act.Button,
			ClickCount: act.ClickCount,
			Modifiers:  act.Modifiers,
			Text:       act.Text,
			PressEnter: act.PressEnter,
			Slowly:     act.Slowly,
			Values:     act.Values,
			Key:        act.Key,
		}
		if err := c.perform(ctx, ps, id, act.Action, aArgs, t.objID, t.frameID, stepTimeout); err != nil {
			st := map[string]any{
				"index":  i,
				"reason": "action_error",
				"error":  errs.Describe(err),
			}
			c.mu.Lock()
			if mhe, _ := c.Outcome["may_have_executed"].(bool); mhe {
				st["may_have_executed"] = true
			}
			c.mu.Unlock()
			stopped = st
			break
		}
		results = append(results, map[string]any{"index": i, "action": act.Action, "executed": true})
		c.mu.Lock()
		c.Outcome = map[string]any{
			"action":   "batch",
			"tab_id":   id,
			"executed": true,
			"results":  append([]map[string]any(nil), results...),
		}
		c.mu.Unlock()
		if i < len(actions)-1 {
			time.Sleep(100 * time.Millisecond)
		}
	}

	c.ClearRefs()
	out := map[string]any{
		"action":    "batch",
		"executed":  len(results) > 0,
		"completed": len(results) == len(actions),
		"results":   results,
	}
	if stopped != nil {
		out["stopped"] = stopped
	}
	return c.Observe(ctx, ps, id, out, waitFor, false, includeSnapshot, ObserveMeta{
		BeforeTabIDs:    beforeTabIDs,
		BeforeDownloads: beforeDownloads,
		HasDownloads:    true,
		PrevSnapshot:    prevSnapshot,
	})
}
