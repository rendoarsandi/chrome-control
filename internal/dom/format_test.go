package dom

import (
	"strings"
	"testing"
)

func TestFormatCompactElements(t *testing.T) {
	out := FormatCompactElements([]map[string]any{
		{
			"ref":         "s1:e1",
			"role":        "textbox",
			"name":        "Email",
			"value":       "a@b.com",
			"focused":     true,
			"required":    true,
			"in_viewport": true,
		},
		{
			"ref":         "s1:e2",
			"role":        "button",
			"name":        "Submit",
			"disabled":    true,
			"in_viewport": false,
			"frame_id":    "frame_1",
		},
	})
	if !strings.Contains(out, `[s1:e1] textbox "Email" value="a@b.com" focused required`) {
		t.Fatalf("unexpected compact line 1:\n%s", out)
	}
	if !strings.Contains(out, `[s1:e2] button "Submit" frame=frame_1 disabled offscreen`) {
		t.Fatalf("unexpected compact line 2:\n%s", out)
	}
}

func TestDiffSnapshots(t *testing.T) {
	prev := map[string]any{
		"tab_id": "t1",
		"url":    "https://example.com/a",
		"title":  "Step 1",
		"frames": []map[string]any{{"text": "Hello\nWorld"}},
		"elements": []map[string]any{
			{"ref": "s1:e1", "frame_id": "frame_0", "role": "button", "name": "Next"},
		},
	}
	curr := map[string]any{
		"tab_id": "t1",
		"url":    "https://example.com/b",
		"title":  "Step 2",
		"frames": []map[string]any{{"text": "Hello\nSaved successfully"}},
		"elements": []map[string]any{
			{"ref": "s2:e1", "frame_id": "frame_0", "role": "link", "name": "Done"},
		},
	}
	diff := DiffSnapshots(prev, curr)
	if diff["url_changed"] == nil || diff["title_changed"] == nil || diff["removed_elements"] != 1 {
		t.Fatalf("unexpected diff: %#v", diff)
	}
	if diff["new_text"] != "Saved successfully" {
		t.Fatalf("expected new_text, got %#v", diff["new_text"])
	}
	noChange := DiffSnapshots(curr, curr)
	if noChange["no_visible_change"] != true {
		t.Fatalf("expected no_visible_change, got %#v", noChange)
	}
}

func TestFormatARIATree(t *testing.T) {
	nodes := []AXNode{
		{NodeID: "1", Role: &AXValue{Value: "RootWebArea"}, Name: &AXValue{Value: "Demo"}, ChildIDs: []string{"2", "3"}},
		{NodeID: "2", Role: &AXValue{Value: "button"}, Name: &AXValue{Value: "Save"}, Properties: []AXProperty{{Name: "focused", Value: AXValue{Value: true}}}},
		{NodeID: "3", Role: &AXValue{Value: "StaticText"}, Name: &AXValue{Value: "Welcome"}},
	}
	yaml := FormatARIATree(nodes)
	if !strings.Contains(yaml, `- RootWebArea "Demo"`) || !strings.Contains(yaml, `  - button "Save" [focused]`) || !strings.Contains(yaml, `  - text: "Welcome"`) {
		t.Fatalf("unexpected ARIA tree:\n%s", yaml)
	}
}
