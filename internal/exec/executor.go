package exec

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/dop251/goja"
	"github.com/rendoarsandi/chrome-control/internal/errs"
	"github.com/rendoarsandi/chrome-control/internal/helpers"
)

const (
	MaxOutputChars = 20000
	MaxSteps       = 100
	MaxArgBytes    = 1000000
)

// HelperInvoker invokes a browser helper by name with positional arguments.
type HelperInvoker func(name string, args []any) (any, error)

// Step records one helper call made during a browser_exec invocation.
type Step struct {
	Index            int                    `json:"index"`
	Helper           string                 `json:"helper"`
	Completed        bool                   `json:"completed,omitempty"`
	MayHaveExecuted  bool                   `json:"may_have_executed,omitempty"`
	Executed         bool                   `json:"executed,omitempty"`
	ObservationError *errs.ErrorDescription `json:"observation_error,omitempty"`
	Wait             any                    `json:"wait,omitempty"`
	WaitError        *errs.ErrorDescription `json:"wait_error,omitempty"`
	Error            *errs.ErrorDescription `json:"error,omitempty"`
}

// Progress holds the execution trace accumulated during an exec call (also preserved on timeout/error).
type Progress struct {
	Action          string `json:"action"`
	Output          string `json:"output"`
	OutputTruncated bool   `json:"output_truncated,omitempty"`
	Steps           []Step `json:"steps"`
	SessionReset    bool   `json:"session_reset,omitempty"`
	Completed       bool   `json:"completed,omitempty"`
	Result          any    `json:"result,omitempty"`
	HasResult       bool   `json:"-"`
	ResultText      string `json:"result_text,omitempty"`
	ResultTruncated bool   `json:"result_truncated,omitempty"`
}

// RunOptions configures one browser_exec execution.
type RunOptions struct {
	HelperSources             []helpers.HelperSource
	SummarizeSnapshots        bool
	OnObservationInvalidation func()
}

// BrowserExecutor hosts a persistent pure-Go JavaScript runtime (goja) for browser_exec.
type BrowserExecutor struct {
	helperNames []string

	mu            sync.Mutex
	vm            *goja.Runtime
	loadedHelpers map[string]string
	active        *execState
	progress      Progress
}

type execState struct {
	invoke             HelperInvoker
	summarizeSnapshots bool
	onInvalidate       func()
	timedOut           bool
}

// New creates a new BrowserExecutor with the allowed helper names.
func New(helperNames []string) *BrowserExecutor {
	return &BrowserExecutor{
		helperNames:   append([]string(nil), helperNames...),
		loadedHelpers: make(map[string]string),
	}
}

// CurrentProgress returns a snapshot of the most recent execution progress.
func (e *BrowserExecutor) CurrentProgress() Progress {
	e.mu.Lock()
	defer e.mu.Unlock()
	p := e.progress
	p.Steps = append([]Step(nil), e.progress.Steps...)
	return p
}

// LastStep returns a pointer to the most recent step for enrichment by the caller.
func (e *BrowserExecutor) LastStep() *Step {
	e.mu.Lock()
	defer e.mu.Unlock()
	if len(e.progress.Steps) == 0 {
		return nil
	}
	return &e.progress.Steps[len(e.progress.Steps)-1]
}

// MarkSessionReset flags that the persistent namespace was reset.
func (e *BrowserExecutor) MarkSessionReset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.progress.SessionReset = true
}

// Reset discards the persistent JS runtime so the next call starts clean.
func (e *BrowserExecutor) Reset() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.vm != nil {
		e.vm.Interrupt("CONNECTION_RESET")
	}
	e.vm = nil
	e.loadedHelpers = make(map[string]string)
	e.active = nil
}

func (e *BrowserExecutor) appendOutput(text string) {
	e.mu.Lock()
	defer e.mu.Unlock()
	remaining := MaxOutputChars - len(e.progress.Output)
	if remaining > 0 {
		if len(text) > remaining {
			e.progress.Output += text[:remaining]
			e.progress.OutputTruncated = true
		} else {
			e.progress.Output += text
		}
	} else if len(text) > 0 {
		e.progress.OutputTruncated = true
	}
}

func (e *BrowserExecutor) ensureVMLocked() *goja.Runtime {
	if e.vm != nil {
		return e.vm
	}
	vm := goja.New()
	e.loadedHelpers = make(map[string]string)

	printFn := func(call goja.FunctionCall) goja.Value {
		parts := make([]string, 0, len(call.Arguments))
		for _, arg := range call.Arguments {
			if goja.IsUndefined(arg) {
				parts = append(parts, "undefined")
			} else if goja.IsNull(arg) {
				parts = append(parts, "null")
			} else if s, ok := arg.Export().(string); ok {
				parts = append(parts, s)
			} else {
				b, err := json.Marshal(arg.Export())
				if err != nil {
					parts = append(parts, arg.String())
				} else {
					parts = append(parts, string(b))
				}
			}
		}
		e.appendOutput(strings.Join(parts, " ") + "\n")
		return goja.Undefined()
	}

	_ = vm.Set("print", printFn)
	consoleObj := vm.NewObject()
	for _, fn := range []string{"log", "info", "warn", "error", "debug"} {
		_ = consoleObj.Set(fn, printFn)
	}
	_ = vm.Set("console", consoleObj)

	_ = vm.Set("sleep", func(call goja.FunctionCall) goja.Value {
		if len(call.Arguments) == 0 {
			panic(vm.NewTypeError("sleep requires an integer from zero to 5000 milliseconds."))
		}
		ms := call.Arguments[0].ToInteger()
		if ms < 0 || ms > 5000 {
			panic(vm.NewTypeError("sleep requires an integer from zero to 5000 milliseconds."))
		}
		e.mu.Lock()
		st := e.active
		e.mu.Unlock()
		if st == nil {
			panic(vm.NewTypeError("sleep requires an active browser_exec call."))
		}
		if st.onInvalidate != nil {
			st.onInvalidate()
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		return goja.Undefined()
	})

	for _, name := range e.helperNames {
		helperName := name
		_ = vm.Set(helperName, func(call goja.FunctionCall) goja.Value {
			return e.invokeHelperFromJS(vm, helperName, call.Arguments)
		})
	}

	// Register ergonomic built-in element-matching helpers directly in Go.
	_ = vm.Set("find_elements", func(call goja.FunctionCall) goja.Value {
		return e.builtinFindElements(vm, call.Arguments, false)
	})
	_ = vm.Set("find_element", func(call goja.FunctionCall) goja.Value {
		return e.builtinFindElements(vm, call.Arguments, true)
	})
	_ = vm.Set("click_text", func(call goja.FunctionCall) goja.Value {
		return e.builtinClickText(vm, call.Arguments)
	})
	_ = vm.Set("fill_label", func(call goja.FunctionCall) goja.Value {
		return e.builtinFillLabel(vm, call.Arguments)
	})

	e.vm = vm
	return vm
}

func (e *BrowserExecutor) invokeHelperFromJS(vm *goja.Runtime, name string, jsArgs []goja.Value) goja.Value {
	e.mu.Lock()
	st := e.active
	if st == nil {
		e.mu.Unlock()
		panic(vm.NewTypeError("Browser helpers require an active browser_exec call."))
	}
	if len(e.progress.Steps) >= MaxSteps {
		e.mu.Unlock()
		panic(makeJSError(vm, "EXEC_STEP_LIMIT", "A browser_exec call supports at most 100 browser helpers.", "Inspect the completed steps and continue in another call."))
	}
	args := make([]any, len(jsArgs))
	for i, a := range jsArgs {
		if goja.IsUndefined(a) {
			args[i] = nil
		} else {
			args[i] = a.Export()
		}
	}
	if raw, err := json.Marshal(args); err == nil && len(raw) > MaxArgBytes {
		e.mu.Unlock()
		panic(vm.NewTypeError("Browser helper arguments exceed one megabyte."))
	}
	stepIdx := len(e.progress.Steps)
	e.progress.Steps = append(e.progress.Steps, Step{Index: stepIdx, Helper: name})
	invoke := st.invoke
	e.mu.Unlock()

	val, err := invoke(name, args)

	e.mu.Lock()
	if stepIdx < len(e.progress.Steps) {
		if err != nil {
			desc := errs.Describe(err)
			e.progress.Steps[stepIdx].Error = &desc
		} else {
			e.progress.Steps[stepIdx].Completed = true
		}
	}
	e.mu.Unlock()

	if err != nil {
		desc := errs.Describe(err)
		panic(makeJSError(vm, desc.Code, desc.Message, desc.Recovery))
	}
	// Normalize through JSON so Go maps/structs become clean JS objects/arrays.
	return toJSValue(vm, val)
}

func makeJSError(vm *goja.Runtime, code, msg, recovery string) *goja.Object {
	obj := vm.NewGoError(fmt.Errorf("%s", msg))
	_ = obj.Set("code", code)
	if recovery != "" {
		_ = obj.Set("recovery", recovery)
	}
	return obj
}

func toJSValue(vm *goja.Runtime, val any) goja.Value {
	if val == nil {
		return goja.Null()
	}
	raw, err := json.Marshal(val)
	if err != nil {
		return vm.ToValue(val)
	}
	var generic any
	if err := json.Unmarshal(raw, &generic); err != nil {
		return vm.ToValue(val)
	}
	return vm.ToValue(generic)
}

func (e *BrowserExecutor) resolveSnapshotElements(vm *goja.Runtime, opts map[string]any) []map[string]any {
	if opts != nil {
		if fromSnap, ok := opts["from_snapshot"].(map[string]any); ok {
			if els := toMapSlice(fromSnap["elements"]); els != nil {
				return els
			}
		}
	}
	snapVal := e.invokeHelperFromJS(vm, "page_info", nil)
	if m, ok := snapVal.Export().(map[string]any); ok {
		return toMapSlice(m["elements"])
	}
	return nil
}

func matchElements(elements []map[string]any, query any, opts map[string]any) []map[string]any {
	roleFilter := strings.ToLower(asString(opts["role"]))
	tagFilter := strings.ToLower(asString(opts["tag"]))
	frameFilter := asString(opts["frame_id"])
	hasViewportFilter := false
	wantViewport := false
	if v, ok := opts["in_viewport"].(bool); ok {
		hasViewportFilter = true
		wantViewport = v
	}

	var re *regexp.Regexp
	needle := ""
	if qre, ok := query.(*regexp.Regexp); ok {
		re = qre
	} else if query != nil {
		needle = strings.ToLower(strings.TrimSpace(fmt.Sprint(query)))
	}

	type scoredItem struct {
		el    map[string]any
		score int
	}
	var scored []scoredItem

	for _, el := range elements {
		if roleFilter != "" && strings.ToLower(asString(el["role"])) != roleFilter {
			continue
		}
		if tagFilter != "" && strings.ToLower(asString(el["tag"])) != tagFilter {
			continue
		}
		if hasViewportFilter {
			iv, _ := el["in_viewport"].(bool)
			if iv != wantViewport {
				continue
			}
		}
		if frameFilter != "" && asString(el["frame_id"]) != frameFilter {
			continue
		}
		name := asString(el["name"])
		fields := []string{name, asString(el["placeholder"]), asString(el["value"]), asString(el["href"])}
		if re != nil {
			matched := false
			for _, f := range fields {
				if re.MatchString(f) {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
			sc := 1
			if re.MatchString(name) {
				sc = 2
			}
			scored = append(scored, scoredItem{el: el, score: sc})
		} else if needle != "" {
			nl := strings.ToLower(strings.TrimSpace(name))
			switch {
			case nl == needle:
				scored = append(scored, scoredItem{el: el, score: 4})
			case strings.HasPrefix(nl, needle):
				scored = append(scored, scoredItem{el: el, score: 3})
			case strings.Contains(nl, needle):
				scored = append(scored, scoredItem{el: el, score: 2})
			default:
				for _, f := range fields {
					if strings.Contains(strings.ToLower(f), needle) {
						scored = append(scored, scoredItem{el: el, score: 1})
						break
					}
				}
			}
		} else {
			scored = append(scored, scoredItem{el: el, score: 1})
		}
	}

	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		ivi, _ := scored[i].el["in_viewport"].(bool)
		ivj, _ := scored[j].el["in_viewport"].(bool)
		return ivi && !ivj
	})
	out := make([]map[string]any, len(scored))
	for i, s := range scored {
		out[i] = s.el
	}
	return out
}

func extractQuery(arg goja.Value) any {
	if arg == nil || goja.IsUndefined(arg) || goja.IsNull(arg) {
		return nil
	}
	// Check if JS RegExp
	if obj, ok := arg.(*goja.Object); ok && obj.ClassName() == "RegExp" {
		src := obj.Get("source").String()
		flags := ""
		if f := obj.Get("flags"); f != nil && !goja.IsUndefined(f) {
			flags = f.String()
		}
		prefix := ""
		if strings.Contains(flags, "i") {
			prefix = "(?i)"
		}
		if re, err := regexp.Compile(prefix + src); err == nil {
			return re
		}
	}
	return arg.Export()
}

func (e *BrowserExecutor) builtinFindElements(vm *goja.Runtime, args []goja.Value, firstOnly bool) goja.Value {
	var query any
	if len(args) > 0 {
		query = extractQuery(args[0])
	}
	var opts map[string]any
	if len(args) > 1 && !goja.IsUndefined(args[1]) && !goja.IsNull(args[1]) {
		opts, _ = args[1].Export().(map[string]any)
	}
	els := e.resolveSnapshotElements(vm, opts)
	matches := matchElements(els, query, opts)
	if firstOnly {
		if len(matches) == 0 {
			return goja.Null()
		}
		return toJSValue(vm, matches[0])
	}
	return toJSValue(vm, matches)
}

func (e *BrowserExecutor) builtinClickText(vm *goja.Runtime, args []goja.Value) goja.Value {
	var query any
	if len(args) > 0 {
		query = extractQuery(args[0])
	}
	var opts map[string]any
	if len(args) > 1 && !goja.IsUndefined(args[1]) && !goja.IsNull(args[1]) {
		opts, _ = args[1].Export().(map[string]any)
	}
	els := e.resolveSnapshotElements(vm, opts)
	matches := matchElements(els, query, opts)
	if len(matches) == 0 {
		sample := sampleElements(els)
		panic(makeJSError(vm, "ELEMENT_NOT_FOUND",
			fmt.Sprintf(`No element matched %q. Available: %s`, fmt.Sprint(query), sample),
			"Inspect page_info() for exact element names and roles, or scroll to reveal the control."))
	}
	actionOpts := stripMatchOpts(opts)
	ref := asString(matches[0]["ref"])
	return e.invokeHelperFromJS(vm, "click", []goja.Value{vm.ToValue(ref), vm.ToValue(actionOpts)})
}

func (e *BrowserExecutor) builtinFillLabel(vm *goja.Runtime, args []goja.Value) goja.Value {
	var query any
	if len(args) > 0 {
		query = extractQuery(args[0])
	}
	text := ""
	if len(args) > 1 && !goja.IsUndefined(args[1]) {
		text = args[1].String()
	}
	var opts map[string]any
	if len(args) > 2 && !goja.IsUndefined(args[2]) && !goja.IsNull(args[2]) {
		opts, _ = args[2].Export().(map[string]any)
	}
	els := e.resolveSnapshotElements(vm, opts)
	candidates := els
	if asString(opts["role"]) == "" && asString(opts["tag"]) == "" {
		fillable := map[string]bool{"textbox": true, "searchbox": true, "spinbutton": true, "combobox": true}
		var filtered []map[string]any
		for _, el := range els {
			r := strings.ToLower(asString(el["role"]))
			t := strings.ToLower(asString(el["tag"]))
			if fillable[r] || t == "input" || t == "textarea" {
				filtered = append(filtered, el)
			}
		}
		candidates = filtered
	}
	matches := matchElements(candidates, query, opts)
	if len(matches) == 0 {
		sample := sampleElements(candidates)
		panic(makeJSError(vm, "ELEMENT_NOT_FOUND",
			fmt.Sprintf(`No fillable element matched %q. Available inputs: %s`, fmt.Sprint(query), sample),
			"Inspect page_info() for exact input labels and refs."))
	}
	actionOpts := stripMatchOpts(opts)
	ref := asString(matches[0]["ref"])
	return e.invokeHelperFromJS(vm, "fill", []goja.Value{vm.ToValue(ref), vm.ToValue(text), vm.ToValue(actionOpts)})
}

func sampleElements(els []map[string]any) string {
	var parts []string
	for _, el := range els {
		name := asString(el["name"])
		if name == "" {
			continue
		}
		parts = append(parts, fmt.Sprintf(`%s:%q`, asString(el["role"]), name))
		if len(parts) >= 10 {
			break
		}
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, ", ")
}

func stripMatchOpts(opts map[string]any) map[string]any {
	out := make(map[string]any)
	for k, v := range opts {
		switch k {
		case "role", "tag", "in_viewport", "frame_id", "from_snapshot":
			continue
		default:
			out[k] = v
		}
	}
	return out
}

// Run executes assistant-authored JavaScript in the persistent goja runtime with a hard timeout.
func (e *BrowserExecutor) Run(code string, invoke HelperInvoker, timeout time.Duration, opts RunOptions) (Progress, error) {
	e.mu.Lock()
	e.progress = Progress{Action: "exec", Output: "", Steps: []Step{}}
	vm := e.ensureVMLocked()
	st := &execState{
		invoke:             invoke,
		summarizeSnapshots: opts.SummarizeSnapshots,
		onInvalidate:       opts.OnObservationInvalidation,
	}
	e.active = st
	e.mu.Unlock()

	timer := time.AfterFunc(timeout, func() {
		e.mu.Lock()
		st.timedOut = true
		e.progress.SessionReset = true
		if e.vm == vm {
			vm.Interrupt("EXEC_TIMEOUT")
		}
		e.mu.Unlock()
	})
	defer func() {
		timer.Stop()
		e.mu.Lock()
		if e.active == st {
			e.active = nil
		}
		e.mu.Unlock()
	}()

	// Load/reload helper files if changed.
	for _, src := range opts.HelperSources {
		e.mu.Lock()
		prevHash := e.loadedHelpers[src.Path]
		e.mu.Unlock()
		if prevHash == src.Hash {
			continue
		}
		prepared := StripAsyncAwait(src.Code)
		if _, err := vm.RunScript(src.Path, prepared); err != nil {
			return e.handleRunError(vm, st, timeout, err)
		}
		e.mu.Lock()
		e.loadedHelpers[src.Path] = src.Hash
		e.mu.Unlock()
	}

	prepared := StripAsyncAwait(code)
	val, err := vm.RunScript("browser_exec", prepared)
	if err != nil {
		return e.handleRunError(vm, st, timeout, err)
	}

	e.mu.Lock()
	e.progress.Completed = true
	if val != nil && !goja.IsUndefined(val) {
		exported := val.Export()
		if opts.SummarizeSnapshots {
			exported = summarizeNestedSnapshots(exported)
		}
		raw, jerr := json.Marshal(exported)
		if jerr != nil {
			s := fmt.Sprint(exported)
			if len(s) > MaxOutputChars {
				s = s[:MaxOutputChars]
				e.progress.ResultTruncated = true
			}
			e.progress.ResultText = s
		} else if len(raw) > MaxOutputChars {
			e.progress.ResultText = string(raw[:MaxOutputChars])
			e.progress.ResultTruncated = true
		} else {
			var normalized any
			_ = json.Unmarshal(raw, &normalized)
			e.progress.Result = normalized
			e.progress.HasResult = true
		}
	}
	out := e.progress
	out.Steps = append([]Step(nil), e.progress.Steps...)
	e.mu.Unlock()
	return out, nil
}

func (e *BrowserExecutor) handleRunError(vm *goja.Runtime, st *execState, timeout time.Duration, err error) (Progress, error) {
	e.mu.Lock()
	timedOut := st.timedOut
	e.mu.Unlock()

	if timedOut {
		e.Reset()
		e.MarkSessionReset()
		return e.CurrentProgress(), errs.New(
			"EXEC_TIMEOUT",
			fmt.Sprintf("Browser execution exceeded %d ms.", timeout.Milliseconds()),
			"The execution namespace and browser connection were reset. Inspect the page and completed steps; input is never replayed.",
			nil,
		)
	}
	if _, isInterrupt := err.(*goja.InterruptedError); isInterrupt {
		e.Reset()
		e.MarkSessionReset()
		return e.CurrentProgress(), errs.New(
			"EXEC_TIMEOUT",
			fmt.Sprintf("Browser execution exceeded %d ms.", timeout.Milliseconds()),
			"The execution namespace and browser connection were reset. Inspect the page and completed steps; input is never replayed.",
			nil,
		)
	}

	code := "EXEC_ERROR"
	msg := err.Error()
	recovery := "Inspect output and completed steps before repeating input. Variables persist unless session_reset is true."
	if ex, ok := err.(*goja.Exception); ok {
		if obj, ok := ex.Value().(*goja.Object); ok {
			if c := obj.Get("code"); c != nil && !goja.IsUndefined(c) {
				code = c.String()
			}
			if m := obj.Get("message"); m != nil && !goja.IsUndefined(m) {
				msg = m.String()
			}
			if r := obj.Get("recovery"); r != nil && !goja.IsUndefined(r) {
				recovery = r.String()
			}
		} else {
			msg = ex.Value().String()
		}
	}
	if len(msg) > 4000 {
		msg = msg[:4000]
	}
	return e.CurrentProgress(), errs.New(code, msg, recovery, nil)
}

func summarizeNestedSnapshots(v any) any {
	switch x := v.(type) {
	case map[string]any:
		if sid, ok := x["snapshot_id"].(string); ok && sid != "" {
			_, hasFrames := x["frames"].([]any)
			_, hasElements := x["elements"].([]any)
			_, hasElementsText := x["elements_text"].(string)
			if hasFrames && (hasElements || hasElementsText) {
				return map[string]any{
					"snapshot_reference": sid,
					"tab_id":             x["tab_id"],
				}
			}
		}
		out := make(map[string]any, len(x))
		for k, val := range x {
			out[k] = summarizeNestedSnapshots(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, item := range x {
			out[i] = summarizeNestedSnapshots(item)
		}
		return out
	default:
		return v
	}
}

// StripAsyncAwait strips standalone `await` and `async` (before function/arrow) outside strings and comments
// so async/await browser_exec scripts work seamlessly in goja's synchronous JS engine.
func StripAsyncAwait(src string) string {
	n := len(src)
	var out strings.Builder
	out.Grow(n)

	isIdentStart := func(b byte) bool {
		return (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || b == '_' || b == '$'
	}
	isIdentPart := func(b byte) bool {
		return isIdentStart(b) || (b >= '0' && b <= '9')
	}

	i := 0
	var prevNonSpace byte
	for i < n {
		c := src[i]
		// Single-line comment
		if c == '/' && i+1 < n && src[i+1] == '/' {
			start := i
			i += 2
			for i < n && src[i] != '\n' {
				i++
			}
			out.WriteString(src[start:i])
			continue
		}
		// Block comment
		if c == '/' && i+1 < n && src[i+1] == '*' {
			start := i
			i += 2
			for i+1 < n && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			if i+1 < n {
				i += 2
			}
			out.WriteString(src[start:i])
			continue
		}
		// Strings and template literals
		if c == '\'' || c == '"' || c == '`' {
			quote := c
			start := i
			i++
			for i < n {
				if src[i] == '\\' && i+1 < n {
					i += 2
					continue
				}
				if src[i] == quote {
					i++
					break
				}
				i++
			}
			out.WriteString(src[start:i])
			prevNonSpace = quote
			continue
		}
		// Identifiers / keywords
		if isIdentStart(c) {
			start := i
			i++
			for i < n && isIdentPart(src[i]) {
				i++
			}
			word := src[start:i]
			// Do not strip property access like obj.await or obj.async
			if prevNonSpace != '.' {
				if word == "await" {
					// Skip keyword and single following space if present
					if i < n && (src[i] == ' ' || src[i] == '\t') {
						i++
					}
					continue
				}
				if word == "async" {
					// Strip `async` if followed by `function`, `(`, or an identifier + `=>`
					j := i
					for j < n && unicode.IsSpace(rune(src[j])) {
						j++
					}
					if j < n && (strings.HasPrefix(src[j:], "function") && (j+8 == n || !isIdentPart(src[j+8])) || src[j] == '(') {
						i = j
						continue
					}
					if j < n && isIdentStart(src[j]) {
						k := j + 1
						for k < n && isIdentPart(src[k]) {
							k++
						}
						for k < n && unicode.IsSpace(rune(src[k])) {
							k++
						}
						if k+1 < n && src[k] == '=' && src[k+1] == '>' {
							i = j
							continue
						}
					}
				}
			}
			out.WriteString(word)
			prevNonSpace = word[len(word)-1]
			continue
		}

		out.WriteByte(c)
		if !unicode.IsSpace(rune(c)) {
			prevNonSpace = c
		}
		i++
	}
	return out.String()
}

func asString(v any) string {
	if v == nil {
		return ""
	}
	if s, ok := v.(string); ok {
		return s
	}
	return fmt.Sprint(v)
}

func toMapSlice(v any) []map[string]any {
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
