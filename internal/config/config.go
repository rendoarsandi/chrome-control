package config

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

// Config holds validated runtime configuration for chrome-control-mcp.
type Config struct {
	Endpoint       string
	AutoADB        bool
	Serial         string
	Package        string
	Socket         string
	ToolMode       string
	HelperFiles    []string
	FlowDir        string
	ActionTimeout  int // milliseconds
	RequestTimeout int // milliseconds
}

// ReadConfig parses configuration from an environment lookup function (or os.LookupEnv if nil).
func ReadConfig(lookup func(string) (string, bool)) (Config, error) {
	if lookup == nil {
		lookup = os.LookupEnv
	}
	get := func(key string) (string, bool) {
		v, ok := lookup(key)
		if !ok || v == "" {
			return "", false
		}
		return v, true
	}

	readInt := func(key string, fallback, minVal, maxVal int) (int, error) {
		raw, ok := lookup(key)
		if !ok || raw == "" {
			return fallback, nil
		}
		v, err := strconv.Atoi(raw)
		if err != nil || v < minVal || v > maxVal {
			return 0, fmt.Errorf("%s must be an integer between %d and %d.", key, minVal, maxVal)
		}
		return v, nil
	}

	endpoint := "http://127.0.0.1:9222"
	if v, ok := get("CHROME_CDP_URL"); ok {
		endpoint = v
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https" && parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return Config{}, fmt.Errorf("CHROME_CDP_URL must be an HTTP or WebSocket CDP endpoint.")
	}

	autoADB := true
	if v, ok := get("CHROME_AUTO_ADB"); ok {
		if v != "0" && v != "1" {
			return Config{}, fmt.Errorf("CHROME_AUTO_ADB must be 0 or 1.")
		}
		autoADB = v != "0"
	}

	toolMode := "full"
	if v, ok := get("CHROME_TOOL_MODE"); ok {
		if v != "full" && v != "compact" {
			return Config{}, fmt.Errorf("CHROME_TOOL_MODE must be full or compact.")
		}
		toolMode = v
	}

	var helperFiles []string
	if raw, ok := get("CHROME_HELPER_FILES"); ok {
		if err := json.Unmarshal([]byte(raw), &helperFiles); err != nil {
			return Config{}, fmt.Errorf("CHROME_HELPER_FILES must be a JSON array of at most five paths.")
		}
		if len(helperFiles) > 5 {
			return Config{}, fmt.Errorf("CHROME_HELPER_FILES must be a JSON array of at most five paths.")
		}
	}

	flowDir := ""
	if v, ok := get("CHROME_FLOW_DIR"); ok {
		if !strings.HasPrefix(v, "/") || len(v) > 4096 {
			return Config{}, fmt.Errorf("CHROME_FLOW_DIR must be an absolute directory path.")
		}
		flowDir = v
	}

	actionTimeout, err := readInt("CHROME_ACTION_TIMEOUT_MS", 8000, 1000, 30000)
	if err != nil {
		return Config{}, err
	}
	requestTimeout, err := readInt("CHROME_REQUEST_TIMEOUT_MS", 30000, 10000, 60000)
	if err != nil {
		return Config{}, err
	}

	pkg := "com.android.chrome"
	if v, ok := get("CHROME_ANDROID_PACKAGE"); ok {
		pkg = v
	}
	socket := "chrome_devtools_remote"
	if v, ok := get("CHROME_DEVTOOLS_SOCKET"); ok {
		socket = v
	}
	serial, _ := get("ANDROID_SERIAL")

	return Config{
		Endpoint:       endpoint,
		AutoADB:        autoADB,
		Serial:         serial,
		Package:        pkg,
		Socket:         socket,
		ToolMode:       toolMode,
		HelperFiles:    helperFiles,
		FlowDir:        flowDir,
		ActionTimeout:  actionTimeout,
		RequestTimeout: requestTimeout,
	}, nil
}
