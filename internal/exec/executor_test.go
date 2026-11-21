package exec

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/helpers"
)

func TestStripAsyncAwait(t *testing.T) {
	in := `async function go(x) { var p = await page_info(); var s = "await keep"; return await click(p.ref); }`
	got := StripAsyncAwait(in)
	if strings.Contains(got, "async function") || strings.Contains(got, "await page_info") || !strings.Contains(got, `"await keep"`) {
		t.Fatalf("unexpected StripAsyncAwait output: %s", got)
	}
}

func TestExecutorPersistenceHelpersAndTimeout(t *testing.T) {
	ex := New([]string{"page_info", "click", "fill"})
	var clickedRef string
	var filledText string
	invoke := func(name string, args []any) (any, error) {
		switch name {
		case "page_info":
			return map[string]any{
				"snapshot_id": "s1",
				"tab_id":      "t1",
				"frames":      []any{map[string]any{"frame_id": "frame_0", "text": "hi"}},
				"elements": []any{
					map[string]any{"ref": "s1:e1", "role": "textbox", "tag": "input", "name": "Username", "in_viewport": true},
					map[string]any{"ref": "s1:e2", "role": "button", "tag": "button", "name": "Sign In", "in_viewport": true},
				},
			}, nil
		case "fill":
			filledText = args[1].(string)
			return map[string]any{"executed": true}, nil
		case "click":
			clickedRef = args[0].(string)
			return map[string]any{"executed": true}, nil
		}
		return nil, nil
	}

	// Test helper file loading + persistent var + async/await + built-in click_text/fill_label
	tmp := t.TempDir()
	hf := filepath.Join(tmp, "h.js")
	if err := os.WriteFile(hf, []byte(`function greet(name) { return "hi " + name; }`), 0o644); err != nil {
		t.Fatal(err)
	}
	sources, err := helpers.LoadHelperFiles([]string{hf})
	if err != nil {
		t.Fatal(err)
	}

	prog, err := ex.Run(`
		var saved = greet("agent");
		await fill_label("Username", "alice");
		await click_text("Sign In");
		print(saved);
		saved;
	`, invoke, 2*time.Second, RunOptions{HelperSources: sources, SummarizeSnapshots: true})
	if err != nil {
		t.Fatalf("exec failed: %v", err)
	}
	if prog.Result != "hi agent" || !strings.Contains(prog.Output, "hi agent") || filledText != "alice" || clickedRef != "s1:e2" {
		t.Fatalf("unexpected exec outcome: prog=%+v filled=%q clicked=%q", prog, filledText, clickedRef)
	}

	// Persistent variable survives into next run
	prog2, err := ex.Run(`saved + "!"`, invoke, 2*time.Second, RunOptions{})
	if err != nil || prog2.Result != "hi agent!" {
		t.Fatalf("expected persisted var, got %+v err=%v", prog2, err)
	}

	// Timeout cleanly interrupts infinite loop and resets namespace
	_, err = ex.Run(`while (true) {}`, invoke, 120*time.Millisecond, RunOptions{})
	if err == nil || !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("expected timeout error, got %v", err)
	}
	if !ex.CurrentProgress().SessionReset {
		t.Fatal("expected SessionReset after timeout")
	}
}
