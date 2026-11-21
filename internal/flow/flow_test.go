package flow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFlowSaveReplayAndDrift(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query().Get("q")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"items": []map[string]any{
				{"name": q + "-pkg", "downloads": 42, "extra": true},
				{"name": q + "-alt", "downloads": 7, "extra": false},
			},
		})
	}))
	defer srv.Close()

	dir := t.TempDir()
	store := NewStore(dir)
	status := 200
	cand := &CapturedRequest{
		ID:     "r1",
		Method: "GET",
		URL:    srv.URL + "/api/search?q=terminal",
		Status: &status,
		RequestHeaders: map[string]string{
			"Accept":        "application/json",
			"Cookie":        "sid=secret",
			"Authorization": "Bearer ignore",
		},
		ResponseJSON: map[string]any{
			"items": []any{
				map[string]any{"name": "terminal-pkg", "downloads": float64(10)},
			},
		},
		HasJSON: true,
	}

	// Secret detection must refuse password leaks
	if _, err := store.BuildAndSave("bad", "", srv.URL, []*CapturedRequest{cand}, []string{"terminal"}, "", nil, ""); err == nil {
		t.Fatal("expected FLOW_SECRET_DETECTED error")
	}

	saved, err := store.BuildAndSave("search", "Search items", srv.URL, []*CapturedRequest{cand}, nil, "", map[string]string{"q": "terminal"}, "")
	if err != nil {
		t.Fatalf("save failed: %v", err)
	}
	if saved["url_template"] != srv.URL+"/api/search?q={{q}}" {
		t.Fatalf("unexpected url_template: %v", saved["url_template"])
	}
	if saved["had_credentials"] != true {
		t.Fatalf("expected had_credentials true")
	}

	// Reload from disk in a fresh store and replay via HTTP
	store2 := NewStore(dir)
	res, err := store2.Run(context.Background(), RunOptions{
		Name:   "search",
		Params: map[string]string{"q": "go"},
		Fields: []string{"name", "downloads"},
		Limit:  1,
		Mode:   "http",
	})
	if err != nil {
		t.Fatalf("replay failed: %v", err)
	}
	if res["verified"] != true || res["count"] != 1 || res["total"] != 2 {
		t.Fatalf("unexpected replay result: %#v", res)
	}
	items := res["items"].([]any)
	first := items[0].(map[string]any)
	if first["name"] != "go-pkg" || first["extra"] != nil {
		t.Fatalf("unexpected projected item: %#v", first)
	}
}
