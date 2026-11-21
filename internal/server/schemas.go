package server

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/rendoarsandi/chrome-control/internal/browser"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

var (
	frameIDPattern   = regexp.MustCompile(`^frame_\d+$`)
	cdpMethodPattern = regexp.MustCompile(`^[A-Za-z]+\.[A-Za-z]+$`)
	flowNamePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
)

func objSchema(props map[string]any, required ...string) map[string]any {
	s := map[string]any{
		"type":       "object",
		"properties": props,
	}
	if len(required) > 0 {
		s["required"] = required
	}
	return s
}

func tabProp() map[string]any {
	return map[string]any{
		"type":        "string",
		"description": "Tab ID from browser_tabs. Omit to use the selected tab, or the only open tab.",
	}
}

func refProp() map[string]any {
	return map[string]any{
		"type":        "string",
		"description": "Exact ref from the latest snapshot of this tab. Never invent a ref or reuse one after another snapshot/action.",
	}
}

func waitForSchema() map[string]any {
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"text":         map[string]any{"type": "string", "minLength": 1, "maxLength": 2000, "description": "Wait until the frame text (including open shadow DOM) contains this literal text."},
			"text_absent":  map[string]any{"type": "string", "minLength": 1, "maxLength": 2000, "description": "Wait until this literal text is absent from the frame."},
			"url":          map[string]any{"type": "string", "minLength": 1, "maxLength": 2000, "description": "Wait until the selected page URL contains this literal substring."},
			"selector":     map[string]any{"type": "string", "minLength": 1, "maxLength": 2000, "description": "CSS selector to observe; never used to send input."},
			"state":        map[string]any{"type": "string", "enum": []string{"attached", "visible", "hidden", "enabled"}, "default": "visible"},
			"frame_id":     map[string]any{"type": "string", "pattern": `^frame_\d+$`, "description": "Current snapshot frame ID; omit for main frame."},
			"network_idle": map[string]any{"type": "boolean", "description": "Wait until in-flight network requests settle."},
			"idle_ms":      map[string]any{"type": "integer", "minimum": 100, "maximum": 2000, "default": 500, "description": "Quiet window in ms when network_idle is true."},
			"timeout_ms":   map[string]any{"type": "integer", "minimum": 1, "maximum": 15000, "default": 5000},
		},
	}
}

func addObserveProps(props map[string]any) map[string]any {
	props["wait_for"] = waitForSchema()
	props["snapshot"] = map[string]any{
		"type":        "boolean",
		"default":     true,
		"description": "Set false to defer the DOM observation; input still invalidates refs. Call page_info() before another ref action.",
	}
	props["include_screenshot"] = map[string]any{
		"type":        "boolean",
		"description": "Return a viewport screenshot together with the final snapshot.",
	}
	props["annotate_screenshot"] = map[string]any{
		"type":        "boolean",
		"description": "When include_screenshot is true, draw Set-of-Marks ref labels (e1, e2, ...) over visible elements.",
	}
	return props
}

func argString(args map[string]any, key string) (string, bool) {
	v, ok := args[key]
	if !ok || v == nil {
		return "", false
	}
	s, ok := v.(string)
	return s, ok
}

func argBool(args map[string]any, key string, def bool) bool {
	v, ok := args[key]
	if !ok || v == nil {
		return def
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return def
}

func argBoolPtr(args map[string]any, key string) *bool {
	v, ok := args[key]
	if !ok || v == nil {
		return nil
	}
	if b, ok := v.(bool); ok {
		return &b
	}
	return nil
}

func argInt(args map[string]any, key string, def int) int {
	v, ok := args[key]
	if !ok || v == nil {
		return def
	}
	switch x := v.(type) {
	case float64:
		return int(x)
	case int:
		return x
	case int64:
		return int(x)
	}
	return def
}

func argFloat(args map[string]any, key string, def float64) float64 {
	v, ok := args[key]
	if !ok || v == nil {
		return def
	}
	switch x := v.(type) {
	case float64:
		return x
	case int:
		return float64(x)
	case int64:
		return float64(x)
	}
	return def
}

func argFloatPtr(args map[string]any, key string) *float64 {
	v, ok := args[key]
	if !ok || v == nil {
		return nil
	}
	switch x := v.(type) {
	case float64:
		return &x
	case int:
		f := float64(x)
		return &f
	case int64:
		f := float64(x)
		return &f
	}
	return nil
}

func argStringSlice(args map[string]any, key string) []string {
	v, ok := args[key]
	if !ok || v == nil {
		return nil
	}
	switch s := v.(type) {
	case []string:
		return s
	case []any:
		out := make([]string, 0, len(s))
		for _, item := range s {
			if str, ok := item.(string); ok {
				out = append(out, str)
			} else if item != nil {
				out = append(out, fmt.Sprint(item))
			}
		}
		return out
	}
	return nil
}

func argStringMap(args map[string]any, key string) map[string]string {
	v, ok := args[key]
	if !ok || v == nil {
		return nil
	}
	m, ok := v.(map[string]any)
	if !ok {
		if sm, ok := v.(map[string]string); ok {
			return sm
		}
		return nil
	}
	out := make(map[string]string, len(m))
	for k, val := range m {
		if val != nil {
			out[k] = fmt.Sprint(val)
		}
	}
	return out
}

func validateWebURL(raw string) error {
	if raw == "about:blank" {
		return nil
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errs.New("INVALID_ARGUMENTS", "Use an http/https URL or about:blank.", "Provide a valid http, https, or about:blank URL.", nil)
	}
	return nil
}

func parseWaitFor(args map[string]any) (*browser.WaitCondition, error) {
	raw, ok := args["wait_for"]
	if !ok || raw == nil {
		return nil, nil
	}
	m, ok := raw.(map[string]any)
	if !ok {
		return nil, errs.New("INVALID_ARGUMENTS", "wait_for must be an object.", "Provide wait_for with text, text_absent, url, selector, or network_idle: true.", nil)
	}
	wc := &browser.WaitCondition{
		State:       "visible",
		IdleMS:      500,
		TimeoutMS:   5000,
		NetworkIdle: argBool(m, "network_idle", false),
	}
	if s, ok := argString(m, "text"); ok && s != "" {
		wc.Text = &s
	}
	if s, ok := argString(m, "text_absent"); ok && s != "" {
		wc.TextAbsent = &s
	}
	if s, ok := argString(m, "url"); ok && s != "" {
		wc.URL = &s
	}
	if s, ok := argString(m, "selector"); ok && s != "" {
		wc.Selector = &s
	}
	if s, ok := argString(m, "state"); ok && s != "" {
		if s != "attached" && s != "visible" && s != "hidden" && s != "enabled" {
			return nil, errs.New("INVALID_ARGUMENTS", "wait_for.state must be attached, visible, hidden, or enabled.", "Use a valid wait_for state.", nil)
		}
		wc.State = s
	}
	if s, ok := argString(m, "frame_id"); ok && s != "" {
		if !frameIDPattern.MatchString(s) {
			return nil, errs.New("INVALID_ARGUMENTS", "wait_for.frame_id must match frame_<index>.", "Use a frame_id from the current snapshot.", nil)
		}
		wc.FrameID = s
	}
	if v := argInt(m, "idle_ms", 500); v < 100 || v > 2000 {
		return nil, errs.New("INVALID_ARGUMENTS", "wait_for.idle_ms must be between 100 and 2000.", "Pass an integer between 100 and 2000.", nil)
	} else {
		wc.IdleMS = v
	}
	if v := argInt(m, "timeout_ms", 5000); v < 1 || v > 15000 {
		return nil, errs.New("INVALID_ARGUMENTS", "wait_for.timeout_ms must be between 1 and 15000.", "Pass an integer between 1 and 15000.", nil)
	} else {
		wc.TimeoutMS = v
	}
	if wc.Text == nil && wc.TextAbsent == nil && wc.URL == nil && wc.Selector == nil && !wc.NetworkIdle {
		return nil, errs.New("INVALID_ARGUMENTS", "Provide text, text_absent, url, selector, or network_idle: true. All supplied conditions must match.", "Supply at least one wait_for condition.", nil)
	}
	return wc, nil
}

func parseFields(args map[string]any) []string {
	v, ok := args["fields"]
	if !ok || v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		var out []string
		for _, part := range strings.Split(s, ",") {
			part = strings.TrimSpace(part)
			if part != "" {
				out = append(out, part)
			}
		}
		return out
	}
	return argStringSlice(args, "fields")
}
