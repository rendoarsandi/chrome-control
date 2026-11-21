package dom

import (
	"encoding/json"
	"fmt"
	"strings"
)

// FormatCompactElements renders a snapshot's element list into a compact, token-efficient outline.
func FormatCompactElements(elements []map[string]any) string {
	lines := make([]string, 0, len(elements))
	for _, el := range elements {
		var parts []string
		ref, _ := el["ref"].(string)
		role, _ := el["role"].(string)
		tag, _ := el["tag"].(string)
		if role == "" {
			role = tag
		}
		parts = append(parts, "["+ref+"]", role)

		if name, _ := el["name"].(string); name != "" {
			parts = append(parts, quoteJSON(name))
		}
		if fid, _ := el["frame_id"].(string); fid != "" && fid != "frame_0" {
			parts = append(parts, "frame="+fid)
		}
		if val, ok := el["value"].(string); ok && val != "" {
			parts = append(parts, "value="+quoteJSON(truncateStr(val, 120)))
		}
		if ph, _ := el["placeholder"].(string); ph != "" {
			parts = append(parts, "placeholder="+quoteJSON(truncateStr(ph, 80)))
		}
		if checked, ok := el["checked"].(bool); ok {
			if checked {
				parts = append(parts, "checked")
			} else {
				parts = append(parts, "unchecked")
			}
		}
		if ac, _ := el["aria_checked"].(string); ac != "" {
			parts = append(parts, "aria-checked="+ac)
		}
		if ae, ok := el["aria_expanded"].(string); ok {
			parts = append(parts, "expanded="+ae)
		}
		if as, ok := el["aria_selected"].(string); ok {
			parts = append(parts, "selected="+as)
		}
		if ap, ok := el["aria_pressed"].(string); ok {
			parts = append(parts, "pressed="+ap)
		}
		if ai, _ := el["aria_invalid"].(string); ai != "" {
			parts = append(parts, "invalid="+ai)
		}
		if b, _ := el["focused"].(bool); b {
			parts = append(parts, "focused")
		}
		if b, _ := el["required"].(bool); b {
			parts = append(parts, "required")
		}
		if b, _ := el["readonly"].(bool); b {
			parts = append(parts, "readonly")
		}
		if b, _ := el["disabled"].(bool); b {
			parts = append(parts, "disabled")
		}
		if iv, ok := el["in_viewport"].(bool); ok && !iv {
			parts = append(parts, "offscreen")
		}
		if href, _ := el["href"].(string); href != "" {
			parts = append(parts, "href="+quoteJSON(truncateStr(href, 160)))
		}
		if rawOpts, ok := el["options"].([]any); ok && len(rawOpts) > 0 {
			limit := len(rawOpts)
			if limit > 12 {
				limit = 12
			}
			optParts := make([]string, 0, limit)
			for i := 0; i < limit; i++ {
				if om, ok := rawOpts[i].(map[string]any); ok {
					val, _ := om["value"].(string)
					lbl, _ := om["label"].(string)
					sel, _ := om["selected"].(bool)
					prefix := ""
					if sel {
						prefix = "*"
					}
					if lbl != "" && lbl != val {
						optParts = append(optParts, fmt.Sprintf("%s%s(%s)", prefix, val, lbl))
					} else {
						optParts = append(optParts, prefix+val)
					}
				}
			}
			suffix := ""
			if trunc, _ := el["options_truncated"].(bool); len(rawOpts) > 12 || trunc {
				suffix = "|..."
			}
			parts = append(parts, "options=["+strings.Join(optParts, "|")+suffix+"]")
		}
		if bbox, ok := el["bbox"].(map[string]any); ok {
			parts = append(parts, fmt.Sprintf("bbox=%v,%v,%vx%v", bbox["x"], bbox["y"], bbox["width"], bbox["height"]))
		}
		if vm, _ := el["validation_message"].(string); vm != "" {
			parts = append(parts, "error="+quoteJSON(vm))
		}
		lines = append(lines, strings.Join(parts, " "))
	}
	return strings.Join(lines, "\n")
}

// DiffSnapshots computes a concise diff summary between two full snapshots of the same tab.
func DiffSnapshots(previous, current map[string]any) map[string]any {
	if previous == nil || current == nil {
		return nil
	}
	if previous["tab_id"] != current["tab_id"] {
		return nil
	}
	if previous["dialog"] != nil || current["dialog"] != nil {
		return nil
	}
	changes := make(map[string]any)
	prevURL, _ := previous["url"].(string)
	currURL, _ := current["url"].(string)
	if prevURL != currURL {
		changes["url_changed"] = map[string]any{"from": prevURL, "to": currURL}
	}
	prevTitle, _ := previous["title"].(string)
	currTitle, _ := current["title"].(string)
	if prevTitle != currTitle {
		changes["title_changed"] = map[string]any{"from": prevTitle, "to": currTitle}
	}

	elemSig := func(el map[string]any) string {
		fid, _ := el["frame_id"].(string)
		if fid == "" {
			fid = "frame_0"
		}
		role, _ := el["role"].(string)
		name, _ := el["name"].(string)
		val := ""
		if v, ok := el["value"]; ok && v != nil {
			val = fmt.Sprint(v)
		}
		chk := ""
		if c, ok := el["checked"]; ok && c != nil {
			chk = fmt.Sprint(c)
		}
		return fid + "|" + role + "|" + name + "|" + val + "|" + chk
	}

	prevCounts := make(map[string]int)
	for _, el := range asMapSlice(previous["elements"]) {
		prevCounts[elemSig(el)]++
	}
	var added []map[string]any
	for _, el := range asMapSlice(current["elements"]) {
		key := elemSig(el)
		if prevCounts[key] > 0 {
			prevCounts[key]--
		} else if len(added) < 15 {
			item := map[string]any{
				"ref":  el["ref"],
				"role": el["role"],
				"name": el["name"],
			}
			if val, ok := el["value"].(string); ok && val != "" {
				item["value"] = truncateStr(val, 120)
			}
			added = append(added, item)
		}
	}
	removedCount := 0
	for _, c := range prevCounts {
		removedCount += c
	}
	if len(added) > 0 {
		changes["added_elements"] = added
	}
	if removedCount > 0 {
		changes["removed_elements"] = removedCount
	}

	prevLines := make(map[string]bool)
	for _, frame := range asMapSlice(previous["frames"]) {
		txt, _ := frame["text"].(string)
		for _, raw := range strings.Split(txt, "\n") {
			line := strings.TrimSpace(raw)
			if line != "" {
				prevLines[line] = true
			}
		}
	}
	var newLines []string
	newTextLen := 0
	for _, frame := range asMapSlice(current["frames"]) {
		txt, _ := frame["text"].(string)
		for _, raw := range strings.Split(txt, "\n") {
			line := strings.TrimSpace(raw)
			if line == "" || prevLines[line] {
				continue
			}
			prevLines[line] = true
			if newTextLen+len(line)+1 > 500 {
				break
			}
			newLines = append(newLines, line)
			newTextLen += len(line) + 1
		}
	}
	if len(newLines) > 0 {
		changes["new_text"] = strings.Join(newLines, "\n")
	}
	if len(changes) == 0 {
		changes["no_visible_change"] = true
	}
	return changes
}

// AXNode represents a subset of CDP Accessibility.AXNode.
type AXNode struct {
	NodeID     string       `json:"nodeId"`
	Ignored    bool         `json:"ignored"`
	Role       *AXValue     `json:"role"`
	Name       *AXValue     `json:"name"`
	Value      *AXValue     `json:"value"`
	Properties []AXProperty `json:"properties"`
	ChildIDs   []string     `json:"childIds"`
}

// AXValue represents CDP Accessibility.AXValue.
type AXValue struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}

// AXProperty represents CDP Accessibility.AXProperty.
type AXProperty struct {
	Name  string  `json:"name"`
	Value AXValue `json:"value"`
}

// FormatARIATree converts CDP Accessibility.getFullAXTree nodes into a concise YAML-style outline.
func FormatARIATree(nodes []AXNode) string {
	if len(nodes) == 0 {
		return ""
	}
	byID := make(map[string]*AXNode, len(nodes))
	for i := range nodes {
		byID[nodes[i].NodeID] = &nodes[i]
	}

	var sb strings.Builder
	visited := make(map[string]bool, len(nodes))

	var walk func(id string, depth int)
	walk = func(id string, depth int) {
		if visited[id] {
			return
		}
		visited[id] = true
		n := byID[id]
		if n == nil {
			return
		}
		role := ""
		if n.Role != nil {
			role, _ = n.Role.Value.(string)
		}
		name := ""
		if n.Name != nil {
			name, _ = n.Name.Value.(string)
			name = strings.TrimSpace(name)
		}
		skipSelf := n.Ignored || role == "" || role == "none" || role == "generic" || role == "InlineTextBox"
		nextDepth := depth
		if !skipSelf {
			if role == "StaticText" {
				if name != "" {
					sb.WriteString(strings.Repeat("  ", depth))
					sb.WriteString("- text: ")
					sb.WriteString(quoteJSON(truncateStr(name, 200)))
					sb.WriteByte('\n')
				}
			} else {
				sb.WriteString(strings.Repeat("  ", depth))
				sb.WriteString("- ")
				sb.WriteString(role)
				if name != "" {
					sb.WriteByte(' ')
					sb.WriteString(quoteJSON(truncateStr(name, 200)))
				}
				var attrs []string
				for _, prop := range n.Properties {
					switch prop.Name {
					case "checked", "expanded", "selected", "pressed", "disabled", "focused", "required", "readonly", "level":
						if prop.Value.Value != nil && prop.Value.Value != false && prop.Value.Value != "false" {
							if prop.Value.Value == true {
								attrs = append(attrs, prop.Name)
							} else {
								attrs = append(attrs, fmt.Sprintf("%s=%v", prop.Name, prop.Value.Value))
							}
						}
					}
				}
				if len(attrs) > 0 {
					sb.WriteString(" [")
					sb.WriteString(strings.Join(attrs, ", "))
					sb.WriteByte(']')
				}
				if n.Value != nil && n.Value.Value != nil {
					if vs := fmt.Sprint(n.Value.Value); vs != "" && vs != name {
						sb.WriteString(": ")
						sb.WriteString(quoteJSON(truncateStr(vs, 160)))
					}
				}
				sb.WriteByte('\n')
				nextDepth = depth + 1
			}
		}
		for _, cid := range n.ChildIDs {
			walk(cid, nextDepth)
		}
	}

	walk(nodes[0].NodeID, 0)
	return strings.TrimRight(sb.String(), "\n")
}

func quoteJSON(s string) string {
	b, err := json.Marshal(s)
	if err != nil {
		return fmt.Sprintf("%q", s)
	}
	return string(b)
}

func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}

func asMapSlice(v any) []map[string]any {
	switch s := v.(type) {
	case []map[string]any:
		return s
	case []any:
		out := make([]map[string]any, 0, len(s))
		for _, item := range s {
			if m, ok := item.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	default:
		return nil
	}
}
