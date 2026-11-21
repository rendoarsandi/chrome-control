package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/rendoarsandi/chrome-control/internal/config"
)

type mockCDP struct {
	server *httptest.Server

	mu              sync.Mutex
	targets         []map[string]any
	attachedTargets []string
	cookies         []map[string]any
	methodsCalled   []string
	mouseEvents     []map[string]any
	keyEvents       []map[string]any
	insertedText    []string
	annotatedMount  int
	annotatedRemove int
	coveredTarget   bool
	challengeMode   bool
	spawnPopupOnClk bool
	navHistoryIdx   int
	downloadDir     string
	wsConn          *websocket.Conn
}

func newMockCDP(t *testing.T) *mockCDP {
	t.Helper()
	m := &mockCDP{
		targets: []map[string]any{
			{"targetId": "T1", "type": "page", "title": "Home", "url": "https://example.com/"},
			{"targetId": "T2", "type": "page", "title": "Other", "url": "https://example.com/other"},
		},
		cookies: []map[string]any{
			{"name": "session", "value": "abc", "domain": "example.com", "path": "/", "httpOnly": true, "secure": true, "session": true},
		},
		navHistoryIdx: 1,
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	mux := http.NewServeMux()
	mux.HandleFunc("/json/version", func(w http.ResponseWriter, r *http.Request) {
		wsURL := "ws://" + r.Host + "/devtools/browser/mock"
		_ = json.NewEncoder(w).Encode(map[string]any{
			"Browser":              "Chrome/130.0.0.0",
			"webSocketDebuggerUrl": wsURL,
		})
	})
	mux.HandleFunc("/devtools/browser/mock", func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		m.mu.Lock()
		m.wsConn = conn
		m.mu.Unlock()

		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var req struct {
				ID        int64          `json:"id"`
				SessionID string         `json:"sessionId"`
				Method    string         `json:"method"`
				Params    map[string]any `json:"params"`
			}
			if err := json.Unmarshal(raw, &req); err != nil {
				return
			}
			res := m.handleCDP(conn, req.SessionID, req.Method, req.Params)
			resp := map[string]any{"id": req.ID, "result": res}
			b, _ := json.Marshal(resp)
			m.mu.Lock()
			_ = conn.WriteMessage(websocket.TextMessage, b)
			m.mu.Unlock()
		}
	})
	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockCDP) sendEvent(sessionID, method string, params any) {
	m.mu.Lock()
	conn := m.wsConn
	m.mu.Unlock()
	if conn == nil {
		return
	}
	ev := map[string]any{"method": method, "params": params}
	if sessionID != "" {
		ev["sessionId"] = sessionID
	}
	b, _ := json.Marshal(ev)
	m.mu.Lock()
	_ = conn.WriteMessage(websocket.TextMessage, b)
	m.mu.Unlock()
}

func (m *mockCDP) handleCDP(_ *websocket.Conn, sessionID, method string, params map[string]any) map[string]any {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.methodsCalled = append(m.methodsCalled, method)

	switch method {
	case "Browser.setDownloadBehavior":
		m.downloadDir, _ = params["downloadPath"].(string)
		return map[string]any{}

	case "Target.getTargets":
		return map[string]any{"targetInfos": m.targets}

	case "Target.activateTarget", "Page.bringToFront", "Page.enable", "Runtime.enable", "DOM.enable", "Network.enable", "Accessibility.enable", "Fetch.enable", "Fetch.disable", "Runtime.releaseObject", "Runtime.releaseObjectGroup", "Page.setInterceptFileChooserDialog":
		return map[string]any{}

	case "Target.attachToTarget":
		tid, _ := params["targetId"].(string)
		m.attachedTargets = append(m.attachedTargets, tid)
		return map[string]any{"sessionId": "S_" + tid}

	case "Page.getFrameTree":
		return map[string]any{
			"frameTree": map[string]any{
				"frame": map[string]any{
					"id":   "F_MAIN",
					"url":  "https://example.com/",
					"name": "",
				},
			},
		}

	case "Page.getNavigationHistory":
		return map[string]any{
			"currentIndex": m.navHistoryIdx,
			"entries": []map[string]any{
				{"id": 10, "url": "https://example.com/prev"},
				{"id": 11, "url": "https://example.com/"},
				{"id": 12, "url": "https://example.com/next"},
			},
		}

	case "Page.navigateToHistoryEntry":
		return map[string]any{}

	case "Page.reload":
		return map[string]any{}

	case "Accessibility.getFullAXTree":
		return map[string]any{
			"nodes": []map[string]any{
				{"nodeId": "1", "role": map[string]any{"value": "RootWebArea"}, "name": map[string]any{"value": "Home"}, "childIds": []string{"2"}},
				{"nodeId": "2", "role": map[string]any{"value": "button"}, "name": map[string]any{"value": "Continue"}},
			},
		}

	case "Runtime.evaluate":
		expr, _ := params["expression"].(string)
		if strings.Contains(expr, "document.readyState") {
			return map[string]any{"result": map[string]any{"type": "string", "value": "complete"}}
		}
		if strings.Contains(expr, "document.title") {
			return map[string]any{"result": map[string]any{"type": "string", "value": "Home"}}
		}
		if strings.Contains(expr, "data-chrome-control-som") {
			m.annotatedRemove++
			return map[string]any{"result": map[string]any{"type": "undefined"}}
		}
		if strings.Contains(expr, "chrome-control.observation") {
			return map[string]any{"result": map[string]any{"type": "object", "objectId": "OBJ_COLLECT"}}
		}
		return map[string]any{"result": map[string]any{"type": "object", "value": map[string]any{"title": "Home", "viewport": map[string]any{"width": 400, "height": 800}}}}

	case "Runtime.callFunctionOn":
		fn, _ := params["functionDeclaration"].(string)
		if strings.Contains(fn, "return this.data;") {
			data := map[string]any{
				"stamp":              "stamp_1",
				"title":              "Home",
				"text":               "Welcome Home",
				"text_truncated":     false,
				"elements_truncated": false,
				"elements": []map[string]any{
					{"index": 0, "tag": "input", "role": "textbox", "name": "Email", "disabled": false, "in_viewport": true, "focused": true, "value": ""},
					{"index": 1, "tag": "button", "role": "button", "name": "Continue", "disabled": false, "in_viewport": true},
				},
			}
			if m.challengeMode {
				data["challenge"] = map[string]any{"kind": "turnstile", "reason": "Detected a Cloudflare verification challenge."}
			}
			return map[string]any{"result": map[string]any{"type": "object", "value": data}}
		}
		if strings.Contains(fn, "return this.nodes;") {
			return map[string]any{"result": map[string]any{"type": "object", "objectId": "OBJ_NODES"}}
		}
		if strings.Contains(fn, "this[i]") {
			return map[string]any{"result": map[string]any{"type": "object", "objectId": "OBJ_NODE"}}
		}
		if strings.Contains(fn, "checkStabilityMs") {
			if m.coveredTarget {
				return map[string]any{"result": map[string]any{"type": "object", "value": map[string]any{
					"ok":         false,
					"reason":     "covered",
					"covered_by": map[string]any{"tag": "div", "role": "dialog", "text": "Cookie Banner"},
				}}}
			}
			return map[string]any{"result": map[string]any{"type": "object", "value": map[string]any{
				"ok": true, "x": 100.0, "y": 200.0, "left": 80.0, "top": 180.0, "width": 40.0, "height": 40.0,
			}}}
		}
		if strings.Contains(fn, "HTMLInputElement.prototype") {
			return map[string]any{"result": map[string]any{"type": "object", "value": map[string]any{"ok": true}}}
		}
		if strings.Contains(fn, "data-chrome-control-som") {
			m.annotatedMount++
			return map[string]any{"result": map[string]any{"type": "number", "value": 2}}
		}
		if strings.Contains(fn, "chrome-control.observation") {
			return map[string]any{"result": map[string]any{"type": "string", "value": "stamp_1"}}
		}
		return map[string]any{"result": map[string]any{"type": "object", "value": map[string]any{"ok": true}}}

	case "Input.dispatchMouseEvent":
		m.mouseEvents = append(m.mouseEvents, params)
		if params["type"] == "mouseReleased" && m.spawnPopupOnClk {
			m.spawnPopupOnClk = false
			m.targets = append(m.targets, map[string]any{"targetId": "T_POPUP", "type": "page", "title": "Popup", "url": "https://example.com/popup"})
		}
		return map[string]any{}

	case "Input.dispatchKeyEvent":
		m.keyEvents = append(m.keyEvents, params)
		return map[string]any{}

	case "Input.insertText":
		if txt, ok := params["text"].(string); ok {
			m.insertedText = append(m.insertedText, txt)
		}
		return map[string]any{}

	case "Page.getLayoutMetrics":
		return map[string]any{
			"cssContentSize":    map[string]any{"x": 0, "y": 0, "width": 400, "height": 1200},
			"contentSize":       map[string]any{"width": 400, "height": 1200},
			"cssVisualViewport": map[string]any{"pageX": 0, "pageY": 0, "clientWidth": 400, "clientHeight": 800},
		}

	case "Page.captureScreenshot":
		return map[string]any{"data": base64.StdEncoding.EncodeToString([]byte("FAKEJPEG"))}

	case "Page.printToPDF":
		return map[string]any{"data": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4"))}

	case "Network.getCookies":
		return map[string]any{"cookies": m.cookies}

	case "Network.setCookie":
		m.cookies = append(m.cookies, map[string]any{
			"name":     params["name"],
			"value":    params["value"],
			"domain":   "example.com",
			"path":     "/",
			"httpOnly": params["httpOnly"],
			"secure":   params["secure"],
			"session":  true,
		})
		return map[string]any{"success": true}

	case "Network.deleteCookies":
		name, _ := params["name"].(string)
		var kept []map[string]any
		for _, c := range m.cookies {
			if c["name"] != name {
				kept = append(kept, c)
			}
		}
		m.cookies = kept
		return map[string]any{}

	case "Network.clearBrowserCookies":
		m.cookies = nil
		return map[string]any{}
	}
	return map[string]any{}
}

func TestToolDiscoveryFullAndCompact(t *testing.T) {
	fullCfg, _ := config.ReadConfig(func(string) (string, bool) { return "", false })
	fullApp := NewApp(fullCfg, Options{})
	defer fullApp.Close()
	fullTools := fullApp.MCP.ListTools()
	if len(fullTools) != 33 {
		t.Fatalf("expected 33 tools in full mode, got %d", len(fullTools))
	}

	compactCfg, _ := config.ReadConfig(func(k string) (string, bool) {
		if k == "CHROME_TOOL_MODE" {
			return "compact", true
		}
		return "", false
	})
	compactApp := NewApp(compactCfg, Options{})
	defer compactApp.Close()
	compactTools := compactApp.MCP.ListTools()
	if len(compactTools) != 3 {
		t.Fatalf("expected 3 tools in compact mode, got %d", len(compactTools))
	}
	fullJSON, _ := json.Marshal(fullTools)
	compactJSON, _ := json.Marshal(compactTools)
	if len(compactJSON) >= len(fullJSON)/2 {
		t.Fatalf("expected compact tool definitions (%d) to be < half of full (%d)", len(compactJSON), len(fullJSON))
	}
}

func TestMCPStdioAndEndToEndTools(t *testing.T) {
	mock := newMockCDP(t)
	cfg, err := config.ReadConfig(func(k string) (string, bool) {
		switch k {
		case "CHROME_CDP_URL":
			return mock.server.URL, true
		case "CHROME_AUTO_ADB":
			return "0", true
		}
		return "", false
	})
	if err != nil {
		t.Fatal(err)
	}
	app := NewApp(cfg, Options{})
	defer app.Close()

	// Verify stdio JSON-RPC initialize + ping + tools/list
	var out bytes.Buffer
	in := strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26"}}` + "\n" +
			`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"ping"}` + "\n",
	)
	if err := app.MCP.ServeStdio(context.Background(), in, &out); err != nil {
		t.Fatalf("ServeStdio failed: %v", err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], `"chrome-control"`) {
		t.Fatalf("unexpected stdio output: %s", out.String())
	}

	ctx := context.Background()
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		res, found := app.MCP.CallTool(ctx, name, args)
		if !found {
			t.Fatalf("tool not found: %s", name)
		}
		return res.StructuredContent
	}

	// 1. Status lists 2 tabs WITHOUT attaching to background targets!
	st := call("browser_status", nil)
	if st["ok"] != true {
		t.Fatalf("browser_status failed: %#v", st)
	}
	if len(mock.attachedTargets) != 0 {
		t.Fatalf("expected zero eager attachments during status, got %v", mock.attachedTargets)
	}

	// 2. Select tab T1 lazily attaches only T1
	tabsRaw, _ := json.Marshal(st["tabs"])
	var tabs []struct {
		TabID string `json:"tab_id"`
	}
	_ = json.Unmarshal(tabsRaw, &tabs)
	if len(tabs) != 2 {
		t.Fatalf("expected 2 tabs, got %d", len(tabs))
	}
	tab1 := tabs[0].TabID

	sel := call("browser_select_tab", map[string]any{"tab_id": tab1})
	if sel["ok"] != true || sel["title"] != "Home" {
		t.Fatalf("select_tab failed: %#v", sel)
	}
	if len(mock.attachedTargets) != 1 || mock.attachedTargets[0] != "T1" {
		t.Fatalf("expected lazy attach of T1 only, got %v", mock.attachedTargets)
	}

	// 3. Compact snapshot + challenge detection + ARIA snapshot
	mock.mu.Lock()
	mock.challengeMode = true
	mock.mu.Unlock()
	comp := call("browser_snapshot", map[string]any{"format": "compact", "mode": "both"})
	if comp["format"] != "compact" || !strings.Contains(comp["elements_text"].(string), `textbox "Email"`) {
		t.Fatalf("unexpected compact snapshot: %#v", comp)
	}
	if comp["human_interaction_required"] == nil || !strings.Contains(comp["aria_tree"].(string), `button "Continue"`) {
		t.Fatalf("expected challenge handoff and aria_tree: %#v", comp)
	}
	mock.mu.Lock()
	mock.challengeMode = false
	mock.mu.Unlock()

	// 4. Click with covered_by error
	fullSnap := call("browser_snapshot", nil)
	els := fullSnap["elements"].([]map[string]any)
	emailRef := els[0]["ref"].(string)
	btnRef := els[1]["ref"].(string)

	mock.mu.Lock()
	mock.coveredTarget = true
	mock.mu.Unlock()
	cov := call("browser_click", map[string]any{"ref": btnRef})
	if cov["ok"] != false {
		t.Fatalf("expected covered click error, got %#v", cov)
	}
	mock.mu.Lock()
	mock.coveredTarget = false
	mock.spawnPopupOnClk = true
	mock.mu.Unlock()

	// 5. Click with modifiers + popup detection
	fullSnap = call("browser_snapshot", nil)
	els = fullSnap["elements"].([]map[string]any)
	btnRef = els[1]["ref"].(string)
	clk := call("browser_click", map[string]any{"ref": btnRef, "button": "right", "click_count": 2, "modifiers": []string{"Shift"}})
	if clk["ok"] != true || clk["new_tabs"] == nil || clk["changes"] == nil {
		t.Fatalf("expected successful click with new_tabs and changes: %#v", clk)
	}

	// 6. Fill slowly + press_enter, hover, drag, forward, reload
	fullSnap = call("browser_snapshot", nil)
	els = fullSnap["elements"].([]map[string]any)
	emailRef = els[0]["ref"].(string)
	btnRef = els[1]["ref"].(string)
	fillRes := call("browser_fill", map[string]any{"ref": emailRef, "text": "go", "slowly": true, "press_enter": true})
	if fillRes["ok"] != true || strings.Join(mock.insertedText, "") != "go" {
		t.Fatalf("fill slowly failed: %#v inserted=%v", fillRes, mock.insertedText)
	}
	fullSnap = call("browser_snapshot", nil)
	els = fullSnap["elements"].([]map[string]any)
	if hov := call("browser_hover", map[string]any{"ref": els[1]["ref"]}); hov["ok"] != true {
		t.Fatalf("hover failed: %#v", hov)
	}
	fullSnap = call("browser_snapshot", nil)
	els = fullSnap["elements"].([]map[string]any)
	if drg := call("browser_drag", map[string]any{"source_ref": els[1]["ref"], "dx": 50, "dy": 0, "steps": 3}); drg["ok"] != true {
		t.Fatalf("drag failed: %#v", drg)
	}
	if fwd := call("browser_forward", nil); fwd["ok"] != true {
		t.Fatalf("forward failed: %#v", fwd)
	}
	if rel := call("browser_reload", nil); rel["ok"] != true {
		t.Fatalf("reload failed: %#v", rel)
	}

	// 7. Set-of-Marks annotated screenshot mounts and cleans up
	shotRes, _ := app.MCP.CallTool(ctx, "browser_screenshot", map[string]any{"annotate": true})
	if shotRes.IsError || len(shotRes.Content) != 2 || shotRes.Content[1].Type != "image" {
		t.Fatalf("annotated screenshot failed: %#v", shotRes)
	}
	if mock.annotatedMount == 0 || mock.annotatedRemove == 0 {
		t.Fatalf("expected SoM mount (%d) and unmount (%d)", mock.annotatedMount, mock.annotatedRemove)
	}

	// 8. Cookies get / set / delete / clear
	ck := call("browser_cookies", map[string]any{"operation": "get"})
	if ck["ok"] != true || len(ck["cookies"].([]map[string]any)) != 1 {
		t.Fatalf("cookies get failed: %#v", ck)
	}
	if setRes := call("browser_cookies", map[string]any{"operation": "set", "name": "tok", "value": "xyz", "http_only": true}); setRes["set"] != true {
		t.Fatalf("cookies set failed: %#v", setRes)
	}
	if delRes := call("browser_cookies", map[string]any{"operation": "delete", "name": "tok"}); delRes["deleted"] != true {
		t.Fatalf("cookies delete failed: %#v", delRes)
	}
	if clrRes := call("browser_cookies", map[string]any{"operation": "clear"}); clrRes["cleared"] != true {
		t.Fatalf("cookies clear failed: %#v", clrRes)
	}

	// 9. Downloads list + save
	if mock.downloadDir != "" {
		dlFile := filepath.Join(mock.downloadDir, "G1")
		_ = os.WriteFile(dlFile, []byte("report-data"), 0o644)
		mock.sendEvent("S_T1", "Browser.downloadWillBegin", map[string]any{"guid": "G1", "url": "https://example.com/r.txt", "suggestedFilename": "r.txt"})
		mock.sendEvent("S_T1", "Browser.downloadProgress", map[string]any{"guid": "G1", "state": "completed"})
		// Wait briefly for event processing
		for i := 0; i < 20; i++ {
			dlList := call("browser_downloads", map[string]any{"operation": "list"})
			if raw, _ := json.Marshal(dlList["downloads"]); strings.Contains(string(raw), "r.txt") {
				break
			}
		}
		savePath := filepath.Join(t.TempDir(), "saved.txt")
		saved := call("browser_downloads", map[string]any{"operation": "save", "path": savePath})
		if saved["saved"] != true {
			t.Fatalf("download save failed: %#v", saved)
		}
		gotBytes, _ := os.ReadFile(savePath)
		if string(gotBytes) != "report-data" {
			t.Fatalf("unexpected saved download content: %q", string(gotBytes))
		}
	}

	// 10. Route add / list / remove + PDF + wait_for network_idle
	if rAdd := call("browser_route", map[string]any{"operation": "add", "pattern": "**/api/*", "body": `{"ok":1}`}); rAdd["ok"] != true {
		t.Fatalf("route add failed: %#v", rAdd)
	}
	if rRem := call("browser_route", map[string]any{"operation": "remove"}); rRem["removed"] != 1 {
		t.Fatalf("route remove failed: %#v", rRem)
	}
	if pdfRes := call("browser_pdf", nil); pdfRes["ok"] != true || pdfRes["data_base64"] == "" {
		t.Fatalf("pdf failed: %#v", pdfRes)
	}
	if waitRes := call("browser_wait", map[string]any{"wait_for": map[string]any{"network_idle": true, "idle_ms": 100, "timeout_ms": 1000}}); waitRes["ok"] != true {
		t.Fatalf("wait network_idle failed: %#v", waitRes)
	}

	// 11. browser_exec with async/await + built-in find_element/click_text/fill_label
	execRes := call("browser_exec", map[string]any{
		"code": `
			var btn = await find_element("Continue");
			await fill_label("Email", "test@example.com");
			await click_text("Continue");
			btn.name;
		`,
	})
	if execRes["ok"] != true || execRes["result"] != "Continue" {
		t.Fatalf("browser_exec failed: %#v", execRes)
	}
}
