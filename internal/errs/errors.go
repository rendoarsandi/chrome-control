package errs

import (
	"errors"
	"regexp"
)

// ControlError is a structured error returned by chrome-control tools.
type ControlError struct {
	Code     string         `json:"code"`
	Message  string         `json:"message"`
	Recovery string         `json:"recovery"`
	Details  map[string]any `json:"details,omitempty"`
}

func (e *ControlError) Error() string {
	return e.Message
}

// New constructs a ControlError.
func New(code, message, recovery string, details map[string]any) *ControlError {
	return &ControlError{
		Code:     code,
		Message:  message,
		Recovery: recovery,
		Details:  details,
	}
}

var (
	timeoutPattern    = regexp.MustCompile(`(?i)timeout|timed out|deadline exceeded`)
	disconnectPattern = regexp.MustCompile(`(?i)browser has been closed|browser disconnected|connection closed|websocket.*(?:closed|hang up)|broken pipe|connection reset|use of closed network connection|eof`)
)

// ErrorDescription is the JSON-serializable error structure exposed to MCP clients.
type ErrorDescription struct {
	Code     string         `json:"code"`
	Message  string         `json:"message"`
	Recovery string         `json:"recovery"`
	Details  map[string]any `json:"details,omitempty"`
}

// Describe converts any error into an ErrorDescription.
func Describe(err error) ErrorDescription {
	if err == nil {
		return ErrorDescription{
			Code:     "BROWSER_ERROR",
			Message:  "Unknown error",
			Recovery: "Call browser_snapshot for fresh state. If disconnected, call browser_status to reconnect.",
		}
	}
	var ce *ControlError
	if errors.As(err, &ce) {
		rec := ce.Recovery
		if rec == "" {
			rec = "Call browser_snapshot for fresh state. If disconnected, call browser_status to reconnect. Do not blindly repeat a submitted action."
		}
		return ErrorDescription{
			Code:     ce.Code,
			Message:  ce.Message,
			Recovery: rec,
			Details:  ce.Details,
		}
	}
	msg := err.Error()
	code := "BROWSER_ERROR"
	if timeoutPattern.MatchString(msg) {
		code = "TIMEOUT"
	}
	return ErrorDescription{
		Code:     code,
		Message:  msg,
		Recovery: "Call browser_snapshot for fresh state. If disconnected, call browser_status to reconnect. Do not blindly repeat a submitted action.",
	}
}

var reconnectCodes = map[string]bool{
	"REQUEST_TIMEOUT":    true,
	"SESSION_TIMEOUT":    true,
	"SNAPSHOT_TIMEOUT":   true,
	"CDP_UNAVAILABLE":    true,
	"CDP_UNRESPONSIVE":   true,
	"CONNECTION_RESET":   true,
	"EXEC_TIMEOUT":       true,
	"EXEC_WORKER_FAILED": true,
	"EXEC_ABORTED":       true,
}

// NeedsReconnect reports whether the error warrants resetting the CDP connection.
func NeedsReconnect(err error) bool {
	if err == nil {
		return false
	}
	var ce *ControlError
	if errors.As(err, &ce) && reconnectCodes[ce.Code] {
		return true
	}
	return disconnectPattern.MatchString(err.Error())
}

// NeedsReconnectCode reports whether a serialized error code requires reconnect.
func NeedsReconnectCode(code, message string) bool {
	if reconnectCodes[code] {
		return true
	}
	return disconnectPattern.MatchString(message)
}
