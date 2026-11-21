package config

import "testing"

func mapLookup(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) {
		v, ok := m[k]
		return v, ok
	}
}

func TestReadConfigDefaults(t *testing.T) {
	cfg, err := ReadConfig(mapLookup(map[string]string{}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Endpoint != "http://127.0.0.1:9222" || !cfg.AutoADB || cfg.ToolMode != "full" || cfg.ActionTimeout != 8000 || cfg.RequestTimeout != 30000 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
}

func TestReadConfigCustomAndValidation(t *testing.T) {
	cfg, err := ReadConfig(mapLookup(map[string]string{
		"CHROME_CDP_URL":            "ws://127.0.0.1:9333/devtools/browser/1",
		"CHROME_AUTO_ADB":           "0",
		"ANDROID_SERIAL":            "192.168.1.5:39123",
		"CHROME_TOOL_MODE":          "compact",
		"CHROME_HELPER_FILES":       `["/tmp/a.js"]`,
		"CHROME_FLOW_DIR":           "/tmp/flows",
		"CHROME_ACTION_TIMEOUT_MS":  "5000",
		"CHROME_REQUEST_TIMEOUT_MS": "25000",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.AutoADB || cfg.ToolMode != "compact" || cfg.FlowDir != "/tmp/flows" || len(cfg.HelperFiles) != 1 {
		t.Fatalf("unexpected custom config: %+v", cfg)
	}

	badCases := []map[string]string{
		{"CHROME_CDP_URL": "ftp://127.0.0.1:9222"},
		{"CHROME_AUTO_ADB": "yes"},
		{"CHROME_TOOL_MODE": "minimal"},
		{"CHROME_HELPER_FILES": "not-json"},
		{"CHROME_FLOW_DIR": "relative/path"},
		{"CHROME_ACTION_TIMEOUT_MS": "100"},
		{"CHROME_REQUEST_TIMEOUT_MS": "999999"},
	}
	for i, tc := range badCases {
		if _, err := ReadConfig(mapLookup(tc)); err == nil {
			t.Errorf("case %d (%v): expected error, got nil", i, tc)
		}
	}
}
