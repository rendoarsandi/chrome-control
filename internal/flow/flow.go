package flow

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/cdp"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

const (
	FlowVersion         = 1
	MaxCapturedRequests = 64
	MaxCaptureBodyBytes = 524288
	MaxReplayBodyBytes  = 2 * 1024 * 1024
)

var (
	flowNamePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	paramNamePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	placeholderRegex = regexp.MustCompile(`\{\{([A-Za-z0-9_-]+)\}\}`)
	baseHostPrefix   = regexp.MustCompile(`^(?:www|app|m)\.`)
)

var telemetryPathMarkers = []string{
	"/collect", "/track", "/beacon", "/analytics", "/pixel",
	"/telemetry", "/metrics", "/log", "/rum", "/sentry",
}

var droppedHeaders = map[string]bool{
	"cookie": true, "host": true, "content-length": true, "connection": true, "accept-encoding": true,
	"x-client-ip": true, "x-forwarded-for": true, "x-real-ip": true, "forwarded": true,
	"traceparent": true, "tracestate": true, "x-request-id": true, "request-id": true,
	"x-amzn-trace-id": true, "sentry-trace": true, "baggage": true, "cf-connecting-ip": true, "true-client-ip": true,
}

var browserSetHeaders = map[string]bool{
	"user-agent": true, "referer": true, "origin": true, "accept-language": true, "priority": true, "dnt": true,
}

var priorityArrayKeys = []string{
	"items", "results", "data", "crates", "records", "entries", "nodes", "list", "hits",
}

// IsTelemetryURL reports whether a URL path matches common telemetry endpoints.
func IsTelemetryURL(rawURL string) bool {
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	p := strings.ToLower(u.Path)
	for _, marker := range telemetryPathMarkers {
		if p == marker || strings.HasPrefix(p, marker+"/") || strings.HasSuffix(p, marker) {
			return true
		}
	}
	return false
}

// ClassifyHeader returns "credential", "dropped", "browser", or "kept".
func ClassifyHeader(name string) string {
	lower := strings.ToLower(name)
	if lower == "authorization" || lower == "proxy-authorization" || strings.Contains(lower, "token") || strings.Contains(lower, "csrf") {
		return "credential"
	}
	if droppedHeaders[lower] {
		return "dropped"
	}
	if browserSetHeaders[lower] || strings.HasPrefix(lower, "sec-") {
		return "browser"
	}
	return "kept"
}

func scalarType(v any) string {
	if v == nil {
		return "null"
	}
	switch v.(type) {
	case bool:
		return "boolean"
	case float64, float32, int, int64, json.Number:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "object"
	}
}

// Signature builds a structural schema signature up to the given nesting depth.
func Signature(v any, depth int) map[string]any {
	if depth > 0 {
		if arr, ok := v.([]any); ok {
			if len(arr) > 0 {
				return map[string]any{"array": Signature(arr[0], depth-1)}
			}
			return map[string]any{"array": nil}
		}
		if obj, ok := v.(map[string]any); ok {
			out := make(map[string]any, len(obj))
			for k, child := range obj {
				out[k] = Signature(child, depth-1)
			}
			return map[string]any{"object": out}
		}
	}
	return map[string]any{"scalar": scalarType(v)}
}

// SignatureMatches checks whether current conforms to the recorded signature.
func SignatureMatches(recorded map[string]any, current any, path string) (bool, string) {
	if recorded == nil {
		return true, ""
	}
	if path == "" {
		path = "$"
	}
	if rawObj, ok := recorded["object"]; ok {
		objMap, ok := current.(map[string]any)
		if !ok {
			return false, fmt.Sprintf("%s: expected object, got %s", path, scalarType(current))
		}
		expObj, _ := rawObj.(map[string]any)
		keys := make([]string, 0, len(expObj))
		for k := range expObj {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			childVal, exists := objMap[k]
			if !exists {
				return false, fmt.Sprintf("%s.%s: missing key", path, k)
			}
			expChild, _ := expObj[k].(map[string]any)
			if matched, drift := SignatureMatches(expChild, childVal, path+"."+k); !matched {
				return false, drift
			}
		}
		return true, ""
	}
	if rawArr, ok := recorded["array"]; ok {
		arr, ok := current.([]any)
		if !ok {
			return false, fmt.Sprintf("%s: expected array, got %s", path, scalarType(current))
		}
		if rawArr == nil || len(arr) == 0 {
			return true, ""
		}
		expElem, _ := rawArr.(map[string]any)
		return SignatureMatches(expElem, arr[0], path+"[0]")
	}
	if rawScalar, ok := recorded["scalar"]; ok {
		exp, _ := rawScalar.(string)
		actual := scalarType(current)
		if exp != actual {
			return false, fmt.Sprintf("%s: expected %s, got %s", path, exp, actual)
		}
	}
	return true, ""
}

func firstObjectKeys(items []any) []string {
	for _, it := range items {
		if m, ok := it.(map[string]any); ok {
			keys := make([]string, 0, len(m))
			for k := range m {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			return keys
		}
	}
	return []string{}
}

// DetectOutputShape identifies the primary result array path and item keys.
func DetectOutputShape(body any) (*string, []string) {
	if arr, ok := body.([]any); ok {
		empty := ""
		return &empty, firstObjectKeys(arr)
	}
	if obj, ok := body.(map[string]any); ok {
		keySet := make(map[string]bool, len(obj))
		for k := range obj {
			keySet[k] = true
		}
		var ordered []string
		prioSet := make(map[string]bool)
		for _, pk := range priorityArrayKeys {
			if keySet[pk] {
				ordered = append(ordered, pk)
				prioSet[pk] = true
			}
		}
		var rest []string
		for k := range obj {
			if !prioSet[k] {
				rest = append(rest, k)
			}
		}
		sort.Strings(rest)
		ordered = append(ordered, rest...)

		for _, k := range ordered {
			if arr, ok := obj[k].([]any); ok {
				for _, item := range arr {
					if _, isObj := item.(map[string]any); isObj {
						kp := k
						return &kp, firstObjectKeys(arr)
					}
				}
			}
		}
		for _, k := range ordered {
			if arr, ok := obj[k].([]any); ok {
				kp := k
				return &kp, firstObjectKeys(arr)
			}
		}
		allKeys := make([]string, 0, len(obj))
		for k := range obj {
			allKeys = append(allKeys, k)
		}
		sort.Strings(allKeys)
		return nil, allKeys
	}
	return nil, []string{}
}

func readField(item map[string]any, field string) (any, bool) {
	if val, ok := item[field]; ok {
		return val, true
	}
	if !strings.Contains(field, ".") {
		return nil, false
	}
	var cur any = item
	for _, part := range strings.Split(field, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil, false
		}
		val, exists := m[part]
		if !exists {
			return nil, false
		}
		cur = val
	}
	return cur, true
}

// ProjectOutput extracts items, applies optional limit and field projection.
func ProjectOutput(body any, arrayPath *string, fields []string, limit int) (items []any, count int, total int) {
	var list []any
	if arrayPath != nil && *arrayPath == "" {
		if arr, ok := body.([]any); ok {
			list = arr
		}
	} else if arrayPath != nil && *arrayPath != "" {
		if obj, ok := body.(map[string]any); ok {
			if arr, ok := obj[*arrayPath].([]any); ok {
				list = arr
			}
		}
	}
	if list == nil {
		list = []any{body}
	}
	total = len(list)
	sliced := list
	if limit > 0 && limit < len(sliced) {
		sliced = sliced[:limit]
	}
	if len(fields) == 0 {
		items = sliced
	} else {
		items = make([]any, 0, len(sliced))
		for _, item := range sliced {
			m, ok := item.(map[string]any)
			if !ok {
				items = append(items, item)
				continue
			}
			picked := make(map[string]any)
			for _, f := range fields {
				if val, found := readField(m, f); found {
					picked[f] = val
				}
			}
			items = append(items, picked)
		}
	}
	return items, len(items), total
}

// NormalizeParams validates and normalizes parameter key-value pairs.
func NormalizeParams(raw map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(raw))
	for k, v := range raw {
		if !paramNamePattern.MatchString(k) {
			return nil, errs.New("FLOW_PARAM_INVALID", fmt.Sprintf("Invalid parameter name: %q.", k), "Use 1–64 letters, digits, underscores, or hyphens.", nil)
		}
		out[k] = v
	}
	return out, nil
}

type swapPair struct {
	name    string
	example string
}

type seg struct {
	text   string
	locked bool
}

func templatizeString(text string, swaps []swapPair, isURL bool) string {
	if text == "" || len(swaps) == 0 {
		return text
	}
	segments := []seg{{text: text, locked: false}}
	for _, sw := range swaps {
		if sw.example == "" {
			continue
		}
		var candidates []string
		if isURL {
			seen := make(map[string]bool)
			for _, c := range []string{
				url.QueryEscape(sw.example),
				strings.ReplaceAll(url.QueryEscape(sw.example), "+", "%20"),
				strings.ReplaceAll(sw.example, " ", "+"),
				sw.example,
			} {
				if c != "" && !seen[c] {
					seen[c] = true
					candidates = append(candidates, c)
				}
			}
			sort.Slice(candidates, func(i, j int) bool { return len(candidates[i]) > len(candidates[j]) })
		} else {
			candidates = []string{sw.example}
		}
		for _, needle := range candidates {
			var next []seg
			for _, s := range segments {
				if s.locked || !strings.Contains(s.text, needle) {
					next = append(next, s)
					continue
				}
				parts := strings.Split(s.text, needle)
				for i, p := range parts {
					if p != "" {
						next = append(next, seg{text: p, locked: false})
					}
					if i < len(parts)-1 {
						next = append(next, seg{text: "{{" + sw.name + "}}", locked: true})
					}
				}
			}
			segments = next
		}
	}
	var sb strings.Builder
	for _, s := range segments {
		sb.WriteString(s.text)
	}
	return sb.String()
}

func bindString(tmpl string, values, defaults map[string]string, isURL bool) (string, error) {
	var firstErr error
	result := placeholderRegex.ReplaceAllStringFunc(tmpl, func(match string) string {
		if firstErr != nil {
			return match
		}
		name := match[2 : len(match)-2]
		raw, ok := values[name]
		if !ok {
			raw, ok = defaults[name]
		}
		if !ok {
			firstErr = errs.New("FLOW_PARAM_REQUIRED", "Missing required flow parameter: "+name+".", fmt.Sprintf(`Pass params: { %s: "..." } to browser_flow run.`, name), nil)
			return match
		}
		if isURL {
			return strings.ReplaceAll(url.QueryEscape(raw), "+", "%20")
		}
		return raw
	})
	if firstErr != nil {
		return "", firstErr
	}
	return result, nil
}

// IsFirstPartyURL checks if requestURL belongs to the same site/origin as pageURL.
func IsFirstPartyURL(requestURL, pageURL string) bool {
	req, err := url.Parse(requestURL)
	if err != nil || (req.Scheme != "http" && req.Scheme != "https") {
		return false
	}
	if pageURL == "" {
		return true
	}
	page, err := url.Parse(pageURL)
	if err != nil || (page.Scheme != "http" && page.Scheme != "https") {
		return true
	}
	if req.Scheme == page.Scheme && strings.EqualFold(req.Host, page.Host) {
		return true
	}
	reqHost := strings.ToLower(req.Hostname())
	pageHost := strings.ToLower(page.Hostname())
	baseHost := baseHostPrefix.ReplaceAllString(pageHost, "")
	return reqHost == baseHost || strings.HasSuffix(reqHost, "."+baseHost) || strings.HasSuffix(baseHost, "."+reqHost)
}

func originOf(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// CapturedRequest holds one captured XHR/Fetch JSON API request.
type CapturedRequest struct {
	ID             string
	RequestID      string
	Method         string
	URL            string
	ResourceType   string
	RequestHeaders map[string]string
	RequestBody    *string
	Status         *int
	MimeType       string
	ResponseBody   *string
	ResponseJSON   any
	HasJSON        bool
	Finished       bool
	Timestamp      int64
}

// FlowCapture records first-party JSON API requests on a page CDP session.
type FlowCapture struct {
	client    *cdp.Client
	sessionID string

	mu         sync.Mutex
	requests   map[string]*CapturedRequest
	orderedIDs []string
	secrets    map[string]bool
	typed      []string
	seq        int
	closed     bool
	unsubs     []func()
	wg         sync.WaitGroup
}

// NewCapture attaches Network listeners to a CDP page session.
func NewCapture(client *cdp.Client, sessionID string) *FlowCapture {
	fc := &FlowCapture{
		client:    client,
		sessionID: sessionID,
		requests:  make(map[string]*CapturedRequest),
		secrets:   make(map[string]bool),
	}

	fc.unsubs = append(fc.unsubs,
		client.Subscribe(sessionID, "Network.requestWillBeSent", fc.onRequestWillBeSent),
		client.Subscribe(sessionID, "Network.responseReceived", fc.onResponseReceived),
		client.Subscribe(sessionID, "Network.loadingFinished", fc.onLoadingFinished),
	)
	return fc
}

// Start enables the Network domain on the session.
func (fc *FlowCapture) Start(ctx context.Context) error {
	return fc.client.Call(ctx, fc.sessionID, "Network.enable", nil, nil)
}

func (fc *FlowCapture) onRequestWillBeSent(ev cdp.Event) {
	var p struct {
		RequestID string `json:"requestId"`
		Type      string `json:"type"`
		Request   struct {
			URL      string         `json:"url"`
			Method   string         `json:"method"`
			Headers  map[string]any `json:"headers"`
			PostData *string        `json:"postData"`
		} `json:"request"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	if p.Type != "XHR" && p.Type != "Fetch" {
		return
	}
	if p.Request.URL == "" || IsTelemetryURL(p.Request.URL) {
		return
	}
	headers := make(map[string]string, len(p.Request.Headers))
	for k, v := range p.Request.Headers {
		headers[k] = fmt.Sprint(v)
	}
	method := strings.ToUpper(p.Request.Method)
	if method == "" {
		method = "GET"
	}

	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.closed {
		return
	}
	fc.seq++
	entry := &CapturedRequest{
		ID:             fmt.Sprintf("r%d", fc.seq),
		RequestID:      p.RequestID,
		Method:         method,
		URL:            p.Request.URL,
		ResourceType:   p.Type,
		RequestHeaders: headers,
		RequestBody:    p.Request.PostData,
		Timestamp:      time.Now().UnixMilli(),
	}
	fc.requests[p.RequestID] = entry
	fc.orderedIDs = append(fc.orderedIDs, p.RequestID)
	for len(fc.orderedIDs) > MaxCapturedRequests {
		oldest := fc.orderedIDs[0]
		fc.orderedIDs = fc.orderedIDs[1:]
		delete(fc.requests, oldest)
	}
}

func (fc *FlowCapture) onResponseReceived(ev cdp.Event) {
	var p struct {
		RequestID string `json:"requestId"`
		Response  struct {
			Status   int    `json:"status"`
			MimeType string `json:"mimeType"`
		} `json:"response"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if fc.closed {
		return
	}
	entry := fc.requests[p.RequestID]
	if entry == nil {
		return
	}
	st := p.Response.Status
	entry.Status = &st
	entry.MimeType = p.Response.MimeType
}

func (fc *FlowCapture) onLoadingFinished(ev cdp.Event) {
	var p struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(ev.Params, &p); err != nil {
		return
	}
	fc.mu.Lock()
	if fc.closed {
		fc.mu.Unlock()
		return
	}
	entry := fc.requests[p.RequestID]
	if entry == nil {
		fc.mu.Unlock()
		return
	}
	entry.Finished = true
	okStatus := entry.Status != nil && *entry.Status >= 200 && *entry.Status < 300
	maybeJSON := entry.MimeType == "" || strings.Contains(strings.ToLower(entry.MimeType), "json")
	if !okStatus || !maybeJSON {
		fc.mu.Unlock()
		return
	}
	fc.wg.Add(1)
	fc.mu.Unlock()

	go func() {
		defer fc.wg.Done()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		var res struct {
			Body          string `json:"body"`
			Base64Encoded bool   `json:"base64Encoded"`
		}
		if err := fc.client.Call(ctx, fc.sessionID, "Network.getResponseBody", map[string]any{"requestId": p.RequestID}, &res); err != nil {
			return
		}
		raw := res.Body
		if res.Base64Encoded {
			b, err := base64.StdEncoding.DecodeString(res.Body)
			if err != nil {
				return
			}
			raw = string(b)
		}
		if len(raw) > MaxCaptureBodyBytes {
			return
		}
		var parsed any
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			return
		}
		fc.mu.Lock()
		defer fc.mu.Unlock()
		if fc.closed {
			return
		}
		rawCopy := raw
		entry.ResponseBody = &rawCopy
		entry.ResponseJSON = parsed
		entry.HasJSON = true
	}()
}

// Reset clears captured requests and typed values.
func (fc *FlowCapture) Reset() {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	fc.requests = make(map[string]*CapturedRequest)
	fc.orderedIDs = nil
	fc.secrets = make(map[string]bool)
	fc.typed = nil
}

// NoteInput records typed text (or password secrets so they are never saved).
func (fc *FlowCapture) NoteInput(text string, isPassword bool) {
	if text == "" {
		return
	}
	fc.mu.Lock()
	defer fc.mu.Unlock()
	if isPassword {
		fc.secrets[text] = true
		return
	}
	for _, existing := range fc.typed {
		if existing == text {
			return
		}
	}
	fc.typed = append(fc.typed, text)
}

// Secrets returns all recorded password field values.
func (fc *FlowCapture) Secrets() []string {
	fc.mu.Lock()
	defer fc.mu.Unlock()
	out := make([]string, 0, len(fc.secrets))
	for s := range fc.secrets {
		out = append(out, s)
	}
	return out
}

// Candidates waits for pending response body fetches and returns first-party JSON API requests.
func (fc *FlowCapture) Candidates(pageURL string) []*CapturedRequest {
	fc.wg.Wait()
	fc.mu.Lock()
	defer fc.mu.Unlock()
	var items []*CapturedRequest
	for _, id := range fc.orderedIDs {
		entry := fc.requests[id]
		if entry == nil || !entry.HasJSON {
			continue
		}
		if !IsFirstPartyURL(entry.URL, pageURL) {
			continue
		}
		items = append(items, entry)
	}
	return items
}

// Close detaches listeners and clears state.
func (fc *FlowCapture) Close() {
	fc.mu.Lock()
	if fc.closed {
		fc.mu.Unlock()
		return
	}
	fc.closed = true
	unsubs := fc.unsubs
	fc.unsubs = nil
	fc.requests = nil
	fc.orderedIDs = nil
	fc.secrets = nil
	fc.typed = nil
	fc.mu.Unlock()

	for _, fn := range unsubs {
		fn()
	}
}

// FlowParam is one template parameter in a saved Flow.
type FlowParam struct {
	Name    string `json:"name"`
	Example string `json:"example"`
}

// Flow is a persisted parameterized JSON API flow definition.
type Flow struct {
	Version        int               `json:"version"`
	Name           string            `json:"name"`
	Origin         string            `json:"origin"`
	StartURL       string            `json:"start_url"`
	Description    string            `json:"description,omitempty"`
	CreatedAt      string            `json:"created_at"`
	Method         string            `json:"method"`
	URLTemplate    string            `json:"url_template"`
	Headers        map[string]string `json:"headers"`
	BodyTemplate   *string           `json:"body_template"`
	HadCredentials bool              `json:"had_credentials"`
	Params         []FlowParam       `json:"params"`
	ArrayPath      *string           `json:"array_path"`
	ItemFields     []string          `json:"item_fields"`
	Signature      map[string]any    `json:"signature"`
	InputSchema    map[string]any    `json:"inputSchema"`
}

func summarizeFlow(f *Flow) map[string]any {
	paramNames := make([]string, 0, len(f.Params))
	for _, p := range f.Params {
		paramNames = append(paramNames, p.Name)
	}
	itemFields := f.ItemFields
	if itemFields == nil {
		itemFields = []string{}
	}
	m := map[string]any{
		"name":            f.Name,
		"origin":          f.Origin,
		"method":          f.Method,
		"url_template":    f.URLTemplate,
		"params":          paramNames,
		"item_fields":     itemFields,
		"had_credentials": f.HadCredentials,
		"inputSchema":     f.InputSchema,
	}
	if f.Description != "" {
		m["description"] = f.Description
	}
	return m
}

// PageFetcher executes an in-page fetch(url, { method, headers, credentials: 'include', body })
// and returns (pageURL, status, responseText, err).
type PageFetcher func(ctx context.Context, reqURL, method string, headers map[string]string, body *string) (pageURL string, status int, text string, err error)

// Store manages saved flows in memory and optionally in flowDir on disk.
type Store struct {
	flowDir   string
	mu        sync.Mutex
	flows     map[string]*Flow
	loadedDir bool
}

// NewStore creates a new FlowStore.
func NewStore(flowDir string) *Store {
	return &Store{
		flowDir: flowDir,
		flows:   make(map[string]*Flow),
	}
}

func validateName(name string) error {
	if !flowNamePattern.MatchString(name) {
		return errs.New("FLOW_NAME_INVALID", "Flow name must be 1–64 letters, digits, underscores, or hyphens.", `Pass a flow name such as "crates" or "search-items".`, nil)
	}
	return nil
}

func validatePath(filePath string) error {
	if !filepath.IsAbs(filePath) {
		return errs.New("FLOW_PATH_INVALID", "Flow file path must be an absolute local path.", "Provide an absolute path on the machine running the MCP server.", nil)
	}
	return nil
}

func validateFlow(f *Flow) error {
	if f == nil || f.Version != FlowVersion || !flowNamePattern.MatchString(f.Name) || f.URLTemplate == "" {
		return errs.New("FLOW_INVALID", "Flow definition file is invalid or uses an unsupported version.", "Capture and save a fresh flow with browser_flow.", nil)
	}
	return nil
}

func (s *Store) ensureLoadedLocked() {
	if s.flowDir == "" || s.loadedDir {
		return
	}
	s.loadedDir = true
	entries, err := os.ReadDir(s.flowDir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(s.flowDir, e.Name()))
		if err != nil {
			continue
		}
		var f Flow
		if err := json.Unmarshal(raw, &f); err == nil && validateFlow(&f) == nil {
			fc := f
			s.flows[f.Name] = &fc
		}
	}
}

func (s *Store) loadFromPathLocked(filePath string) (*Flow, error) {
	if err := validatePath(filePath); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(filePath)
	if err != nil {
		return nil, errs.New("FLOW_FILE_UNAVAILABLE", "Cannot read flow file: "+filePath, "Check the path and file permissions on the MCP server host.", nil)
	}
	var f Flow
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, errs.New("FLOW_INVALID", "Flow file is not valid JSON: "+filePath, "Inspect the file or save a fresh flow.", nil)
	}
	if err := validateFlow(&f); err != nil {
		return nil, err
	}
	s.flows[f.Name] = &f
	return &f, nil
}

// BuildAndSave creates and persists a flow from captured requests.
func (s *Store) BuildAndSave(name, description, pageURL string, candidates []*CapturedRequest, secrets []string, requestID string, params map[string]string, explicitPath string) (map[string]any, error) {
	if err := validateName(name); err != nil {
		return nil, err
	}
	if explicitPath != "" {
		if err := validatePath(explicitPath); err != nil {
			return nil, err
		}
	}
	if len(candidates) == 0 {
		return nil, errs.New("FLOW_NO_CANDIDATE", "No first-party JSON API requests were captured on this tab.", `Call browser_flow({ operation: "capture" }), trigger the page search or API action, and then save.`, nil)
	}
	paramMap, err := NormalizeParams(params)
	if err != nil {
		return nil, err
	}

	var nonEmptyParams []swapPair
	for k, v := range paramMap {
		if v != "" {
			nonEmptyParams = append(nonEmptyParams, swapPair{name: k, example: v})
		}
	}
	sort.Slice(nonEmptyParams, func(i, j int) bool {
		if len(nonEmptyParams[i].example) != len(nonEmptyParams[j].example) {
			return len(nonEmptyParams[i].example) > len(nonEmptyParams[j].example)
		}
		return nonEmptyParams[i].name < nonEmptyParams[j].name
	})

	var selected *CapturedRequest
	if requestID != "" {
		for _, c := range candidates {
			if c.ID == requestID || c.RequestID == requestID {
				selected = c
				break
			}
		}
		if selected == nil {
			return nil, errs.New("FLOW_NO_CANDIDATE", fmt.Sprintf("Captured request %q was not found among JSON candidates.", requestID), `Call browser_flow({ operation: "status" }) to inspect available candidate IDs.`, nil)
		}
	} else if len(nonEmptyParams) > 0 {
		matchesExample := func(c *CapturedRequest, val string) bool {
			enc := strings.ReplaceAll(url.QueryEscape(val), "+", "%20")
			plusEnc := strings.ReplaceAll(val, " ", "+")
			body := ""
			if c.RequestBody != nil {
				body = *c.RequestBody
			}
			haystacks := []string{c.URL, body}
			for _, hv := range c.RequestHeaders {
				haystacks = append(haystacks, hv)
			}
			for _, h := range haystacks {
				if strings.Contains(h, val) || strings.Contains(h, enc) || strings.Contains(h, plusEnc) {
					return true
				}
			}
			return false
		}
		for i := len(candidates) - 1; i >= 0; i-- {
			allMatch := true
			for _, p := range nonEmptyParams {
				if !matchesExample(candidates[i], p.example) {
					allMatch = false
					break
				}
			}
			if allMatch {
				selected = candidates[i]
				break
			}
		}
		if selected == nil {
			for i := len(candidates) - 1; i >= 0; i-- {
				for _, p := range nonEmptyParams {
					if matchesExample(candidates[i], p.example) {
						selected = candidates[i]
						break
					}
				}
				if selected != nil {
					break
				}
			}
		}
		if selected == nil {
			selected = candidates[len(candidates)-1]
		}
	} else {
		selected = candidates[len(candidates)-1]
	}

	bodyStr := ""
	if selected.RequestBody != nil {
		bodyStr = *selected.RequestBody
	}
	for _, secret := range secrets {
		if secret == "" {
			continue
		}
		enc := strings.ReplaceAll(url.QueryEscape(secret), "+", "%20")
		if strings.Contains(selected.URL, secret) || strings.Contains(selected.URL, enc) || strings.Contains(bodyStr, secret) || strings.Contains(bodyStr, enc) {
			return nil, errs.New("FLOW_SECRET_DETECTED", "Cannot save a flow whose request contains a value typed into a password field.", "Do not capture password login requests as replayable flows.", nil)
		}
	}

	hadCredentials := false
	keptHeaders := make(map[string]string)
	for hn, hv := range selected.RequestHeaders {
		switch ClassifyHeader(hn) {
		case "credential":
			hadCredentials = true
		case "kept":
			keptHeaders[hn] = hv
		}
	}

	urlTemplate := templatizeString(selected.URL, nonEmptyParams, true)
	templatedHeaders := make(map[string]string, len(keptHeaders))
	for k, v := range keptHeaders {
		templatedHeaders[k] = templatizeString(v, nonEmptyParams, false)
	}
	var bodyTemplate *string
	if selected.RequestBody != nil {
		bt := templatizeString(*selected.RequestBody, nonEmptyParams, false)
		bodyTemplate = &bt
	}

	origin := originOf(pageURL)
	if origin == "" {
		origin = originOf(selected.URL)
	}

	paramKeys := make([]string, 0, len(paramMap))
	for k := range paramMap {
		paramKeys = append(paramKeys, k)
	}
	sort.Strings(paramKeys)
	paramList := make([]FlowParam, 0, len(paramKeys))
	props := make(map[string]any, len(paramKeys))
	for _, k := range paramKeys {
		paramList = append(paramList, FlowParam{Name: k, Example: paramMap[k]})
		props[k] = map[string]any{"type": "string", "default": paramMap[k]}
	}

	arrayPath, itemFields := DetectOutputShape(selected.ResponseJSON)
	sig := Signature(selected.ResponseJSON, 3)

	startURL := pageURL
	if startURL == "" {
		startURL = selected.URL
	}
	flowObj := &Flow{
		Version:        FlowVersion,
		Name:           name,
		Origin:         origin,
		StartURL:       startURL,
		Description:    description,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		Method:         selected.Method,
		URLTemplate:    urlTemplate,
		Headers:        templatedHeaders,
		BodyTemplate:   bodyTemplate,
		HadCredentials: hadCredentials,
		Params:         paramList,
		ArrayPath:      arrayPath,
		ItemFields:     itemFields,
		Signature:      sig,
		InputSchema: map[string]any{
			"type":       "object",
			"properties": props,
			"required":   []string{},
		},
	}

	s.mu.Lock()
	s.ensureLoadedLocked()
	s.flows[name] = flowObj
	targetPath := explicitPath
	if targetPath == "" && s.flowDir != "" {
		targetPath = filepath.Join(s.flowDir, name+".json")
	}
	s.mu.Unlock()

	if targetPath != "" {
		if explicitPath == "" && s.flowDir != "" {
			if err := os.MkdirAll(s.flowDir, 0o755); err != nil {
				return nil, err
			}
		}
		raw, err := json.MarshalIndent(flowObj, "", "  ")
		if err != nil {
			return nil, err
		}
		if err := os.WriteFile(targetPath, append(raw, '\n'), 0o644); err != nil {
			return nil, err
		}
	}

	out := summarizeFlow(flowObj)
	out["saved"] = true
	out["captured_request_id"] = selected.ID
	if targetPath != "" {
		out["path"] = targetPath
	}
	return out, nil
}

// List returns summaries of saved flows, optionally filtered by origin or loaded from path.
func (s *Store) List(originFilter, explicitPath string) (map[string]any, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	if explicitPath != "" {
		if err := validatePath(explicitPath); err != nil {
			return nil, err
		}
		info, err := os.Stat(explicitPath)
		if err != nil {
			return nil, errs.New("FLOW_FILE_UNAVAILABLE", "Cannot read flow path: "+explicitPath, "Check the path on the MCP server host.", nil)
		}
		if info.IsDir() {
			entries, _ := os.ReadDir(explicitPath)
			for _, e := range entries {
				if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
					_, _ = s.loadFromPathLocked(filepath.Join(explicitPath, e.Name()))
				}
			}
		} else {
			if _, err := s.loadFromPathLocked(explicitPath); err != nil {
				return nil, err
			}
		}
	}
	filterOrigin := ""
	if originFilter != "" {
		if o := originOf(originFilter); o != "" {
			filterOrigin = o
		} else {
			filterOrigin = originFilter
		}
	}
	names := make([]string, 0, len(s.flows))
	for k := range s.flows {
		names = append(names, k)
	}
	sort.Strings(names)
	flows := make([]map[string]any, 0, len(names))
	for _, k := range names {
		f := s.flows[k]
		if filterOrigin != "" && f.Origin != filterOrigin {
			continue
		}
		flows = append(flows, summarizeFlow(f))
	}
	return map[string]any{"flows": flows}, nil
}

// HintsForURL returns saved flow hints matching the URL's origin.
func (s *Store) HintsForURL(rawURL string) []map[string]any {
	u, err := url.Parse(rawURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil
	}
	origin := u.Scheme + "://" + u.Host
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLoadedLocked()
	var matches []map[string]any
	for _, f := range s.flows {
		if f.Origin != origin {
			continue
		}
		item := summarizeFlow(f)
		item["hint"] = fmt.Sprintf(`Call browser_flow({ operation: "run", name: %q, params: { ... } }) instead of driving the DOM.`, f.Name)
		matches = append(matches, item)
	}
	return matches
}

// Remove deletes a flow from memory and disk.
func (s *Store) Remove(name, explicitPath string) (map[string]any, error) {
	if err := validateName(name); err != nil {
		return nil, err
	}
	if explicitPath != "" {
		if err := validatePath(explicitPath); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	s.ensureLoadedLocked()
	_, existed := s.flows[name]
	delete(s.flows, name)
	targetPath := explicitPath
	if targetPath == "" && s.flowDir != "" {
		targetPath = filepath.Join(s.flowDir, name+".json")
	}
	s.mu.Unlock()

	removedFile := false
	if targetPath != "" {
		err := os.Remove(targetPath)
		if err == nil {
			removedFile = true
		} else if !os.IsNotExist(err) {
			return nil, err
		}
	}
	if !existed && !removedFile {
		return nil, errs.New("FLOW_NOT_FOUND", fmt.Sprintf("No saved flow named %q.", name), `Call browser_flow({ operation: "list" }) to inspect available flows.`, nil)
	}
	return map[string]any{"deleted": true, "name": name}, nil
}

// RunOptions configures a flow replay execution.
type RunOptions struct {
	Name        string
	Params      map[string]string
	Fields      []string
	Limit       int
	Mode        string // "auto", "http", "page"
	PageFetcher PageFetcher
	Timeout     time.Duration
	Path        string
}

// Run replays a saved flow via direct HTTP and/or in-page fetch with signature verification.
func (s *Store) Run(ctx context.Context, opts RunOptions) (map[string]any, error) {
	if opts.Name == "" && opts.Path == "" {
		return nil, errs.New("FLOW_NAME_INVALID", "Provide a flow name or path to run.", `Call browser_flow({ operation: "list" }) to inspect available flows.`, nil)
	}
	if opts.Name != "" {
		if err := validateName(opts.Name); err != nil {
			return nil, err
		}
	}
	s.mu.Lock()
	s.ensureLoadedLocked()
	var f *Flow
	if opts.Name != "" {
		f = s.flows[opts.Name]
	}
	if f == nil && opts.Path != "" {
		loaded, err := s.loadFromPathLocked(opts.Path)
		if err != nil {
			s.mu.Unlock()
			return nil, err
		}
		if opts.Name == "" || loaded.Name == opts.Name {
			f = loaded
		}
	}
	s.mu.Unlock()
	if f == nil {
		label := opts.Name
		if label == "" {
			label = opts.Path
		}
		return nil, errs.New("FLOW_NOT_FOUND", fmt.Sprintf("No saved flow named %q.", label), `Call browser_flow({ operation: "list" }) to inspect available flows, or capture and save a new flow.`, nil)
	}

	started := time.Now()
	provided, err := NormalizeParams(opts.Params)
	if err != nil {
		return nil, err
	}
	defaults := make(map[string]string, len(f.Params))
	for _, p := range f.Params {
		defaults[p.Name] = p.Example
	}
	boundURL, err := bindString(f.URLTemplate, provided, defaults, true)
	if err != nil {
		return nil, err
	}
	parsedURL, err := url.Parse(boundURL)
	if err != nil || parsedURL.Host == "" {
		return nil, errs.New("FLOW_URL_INVALID", "Bound flow URL is invalid: "+boundURL, "Check the supplied parameter values and flow template.", nil)
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return nil, errs.New("FLOW_URL_INVALID", "Flow replay only supports http and https URLs.", "Save flows targeting http or https endpoints.", nil)
	}

	boundHeaders := make(map[string]string)
	for k, v := range f.Headers {
		if ClassifyHeader(k) == "kept" {
			bv, err := bindString(v, provided, defaults, false)
			if err != nil {
				return nil, err
			}
			boundHeaders[k] = bv
		}
	}
	method := strings.ToUpper(f.Method)
	var boundBody *string
	if f.BodyTemplate != nil && method != "GET" && method != "HEAD" {
		bb, err := bindString(*f.BodyTemplate, provided, defaults, false)
		if err != nil {
			return nil, err
		}
		boundBody = &bb
	}
	isWriteMethod := method != "GET" && method != "HEAD" && method != "OPTIONS"

	mode := opts.Mode
	if mode == "" {
		mode = "auto"
	}
	var tiers []string
	switch mode {
	case "http":
		tiers = []string{"http"}
	case "page":
		tiers = []string{"page"}
	default:
		if f.HadCredentials {
			tiers = []string{"page"}
		} else {
			tiers = []string{"http", "page"}
		}
	}

	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 8 * time.Second
	}

	var lastFailure error
	for i, tier := range tiers {
		canFallback := i+1 < len(tiers)
		var status int
		var text string

		if tier == "http" {
			tctx, cancel := context.WithTimeout(ctx, timeout)
			var bodyReader io.Reader
			if boundBody != nil {
				bodyReader = strings.NewReader(*boundBody)
			}
			req, rerr := http.NewRequestWithContext(tctx, method, boundURL, bodyReader)
			if rerr == nil {
				for k, v := range boundHeaders {
					req.Header.Set(k, v)
				}
			}
			var resp *http.Response
			if rerr == nil {
				resp, rerr = (&http.Client{}).Do(req)
			}
			if rerr != nil {
				cancel()
				lastFailure = errs.New("FLOW_HTTP_ERROR", "Flow HTTP request failed: "+rerr.Error(), `Retry with mode: "page" on an open tab for this origin if the endpoint requires browser context.`, nil)
				if canFallback {
					continue
				}
				return nil, lastFailure
			}
			status = resp.StatusCode
			rawBytes, readErr := io.ReadAll(io.LimitReader(resp.Body, MaxReplayBodyBytes+1))
			resp.Body.Close()
			cancel()
			if readErr != nil {
				lastFailure = errs.New("FLOW_HTTP_ERROR", "Flow HTTP read failed: "+readErr.Error(), `Retry with mode: "page".`, nil)
				if canFallback {
					continue
				}
				return nil, lastFailure
			}
			if len(rawBytes) > MaxReplayBodyBytes {
				return nil, errs.New("FLOW_RESPONSE_LIMIT", "Flow response exceeded the 2 MiB limit.", "Use more specific parameters or limit the query result.", nil)
			}
			text = string(rawBytes)
		} else {
			if opts.PageFetcher == nil {
				if lastFailure != nil {
					return nil, lastFailure
				}
				return nil, errs.New("FLOW_PAGE_REQUIRED", "Replaying this flow requires an open browser tab.", fmt.Sprintf(`Select or open a tab on %s and call browser_flow({ operation: "run", name: %q }).`, f.Origin, f.Name), nil)
			}
			pageURL, st, txt, perr := opts.PageFetcher(ctx, boundURL, method, boundHeaders, boundBody)
			if perr != nil {
				return nil, perr
			}
			pageOrigin := originOf(pageURL)
			if pageOrigin != "" && pageOrigin != f.Origin && !IsFirstPartyURL(boundURL, pageURL) {
				return nil, errs.New("FLOW_ORIGIN_MISMATCH", fmt.Sprintf("Selected tab origin (%s) does not match flow origin (%s).", pageOrigin, f.Origin), fmt.Sprintf(`Navigate or select a tab on %s before running with mode: "page".`, f.Origin), nil)
			}
			status = st
			text = txt
			if len(text) > MaxReplayBodyBytes {
				return nil, errs.New("FLOW_RESPONSE_LIMIT", "Flow response exceeded the 2 MiB limit.", "Use more specific parameters or limit the query result.", nil)
			}
		}

		if (status == 401 || status == 403) && canFallback {
			lastFailure = errs.New("FLOW_HTTP_ERROR", fmt.Sprintf("Flow HTTP request returned status %d.", status), `Run on a logged-in tab with mode: "page".`, nil)
			continue
		}
		if status < 200 || status >= 300 {
			return nil, errs.New("FLOW_HTTP_ERROR", fmt.Sprintf("Flow request failed with HTTP %d.", status), "Verify flow parameters or capture a fresh flow.", nil)
		}

		var parsedJSON any
		if err := json.Unmarshal([]byte(text), &parsedJSON); err != nil {
			if canFallback && !isWriteMethod {
				lastFailure = errs.New("FLOW_RESPONSE_INVALID", "Flow HTTP response was not valid JSON.", `The endpoint may require browser session context; try mode: "page".`, nil)
				continue
			}
			return nil, errs.New("FLOW_RESPONSE_INVALID", "Flow response was not valid JSON.", "Inspect the site or capture a fresh flow.", nil)
		}

		matched, drift := SignatureMatches(f.Signature, parsedJSON, "$")
		if !matched && canFallback && !isWriteMethod {
			lastFailure = errs.New("FLOW_SIGNATURE_DRIFT", "Flow response structure changed: "+drift, "Capture and save a fresh flow for this endpoint.", nil)
			continue
		}

		items, count, total := ProjectOutput(parsedJSON, f.ArrayPath, opts.Fields, opts.Limit)
		res := map[string]any{
			"flow":   f.Name,
			"origin": f.Origin,
			"request": map[string]any{
				"method": method,
				"url":    boundURL,
			},
			"tier":       tier,
			"status":     status,
			"verified":   matched,
			"elapsed_ms": time.Since(started).Milliseconds(),
			"items":      items,
			"count":      count,
			"total":      total,
		}
		if !matched {
			res["drift"] = drift
		}
		return res, nil
	}

	if lastFailure != nil {
		return nil, lastFailure
	}
	return nil, errs.New("FLOW_RUN_FAILED", "Flow replay could not complete.", "Capture and save a fresh flow.", nil)
}
