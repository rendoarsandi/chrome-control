package adb

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/rendoarsandi/chrome-control/internal/config"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

// Runner executes an external command with bounded output and context cancellation.
type Runner func(ctx context.Context, name string, args []string) (stdout, stderr string, err error)

// DefaultRunner executes commands via exec.CommandContext using argument arrays.
func DefaultRunner(ctx context.Context, name string, args []string) (string, string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &limitedWriter{buf: &outBuf, max: 256 * 1024}
	cmd.Stderr = &limitedWriter{buf: &errBuf, max: 64 * 1024}
	err := cmd.Run()
	return outBuf.String(), errBuf.String(), err
}

type limitedWriter struct {
	buf *bytes.Buffer
	max int
}

func (w *limitedWriter) Write(p []byte) (int, error) {
	rem := w.max - w.buf.Len()
	if rem > 0 {
		if len(p) > rem {
			w.buf.Write(p[:rem])
		} else {
			w.buf.Write(p)
		}
	}
	return len(p), nil
}

// CanForward reports whether the endpoint is a local HTTP/WebSocket address suitable for ADB port forwarding.
func CanForward(endpoint string) bool {
	u, err := url.Parse(endpoint)
	if err != nil {
		return false
	}
	if u.Scheme != "http" && u.Scheme != "ws" {
		return false
	}
	host := u.Hostname()
	return host == "127.0.0.1" || host == "localhost" || host == "::1"
}

var (
	wirelessPattern = regexp.MustCompile(`^(?:\[[\da-fA-F:]+\]|[\w.-]+):\d{1,5}$`)
	noDevicePattern = regexp.MustCompile(`(?i)error:\s*no such device\b`)
	mdnsHeader      = regexp.MustCompile(`(?i)^list of discovered`)
)

// MDNSService represents a wireless debugging service advertised over mDNS.
type MDNSService struct {
	Name    string `json:"name"`
	Type    string `json:"type"`
	Address string `json:"address"`
}

// ForwardResult summarizes a successful ADB port-forwarding setup.
type ForwardResult struct {
	Serial string
	Port   int
}

// ForwardChrome wakes Chrome on the target Android device and establishes local ADB port forwarding.
func ForwardChrome(ctx context.Context, cfg config.Config, run Runner, reconnect bool) (ForwardResult, error) {
	if run == nil {
		run = DefaultRunner
	}
	if !CanForward(cfg.Endpoint) {
		return ForwardResult{}, errs.New(
			"CDP_UNAVAILABLE",
			"The configured remote CDP endpoint is unreachable.",
			"Check CHROME_CDP_URL and the forwarding tunnel on the machine running this server.",
			nil,
		)
	}
	u, _ := url.Parse(cfg.Endpoint)

	runADB := func(timeout time.Duration, args ...string) (string, string, error) {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		tctx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		return run(tctx, "adb", args)
	}

	serial := cfg.Serial
	if serial == "" {
		stdout, _, err := runADB(5*time.Second, "devices")
		if err != nil {
			return ForwardResult{}, wrapADBError(err)
		}
		var devices []string
		for _, line := range strings.Split(stdout, "\n") {
			parts := strings.Fields(strings.TrimSpace(line))
			if len(parts) >= 2 && parts[1] == "device" {
				devices = append(devices, parts[0])
			}
		}
		if len(devices) != 1 {
			var mdnsServices []MDNSService
			if len(devices) == 0 {
				if mdnsOut, _, merr := runADB(1500*time.Millisecond, "mdns", "services"); merr == nil {
					for _, rawLine := range strings.Split(mdnsOut, "\n") {
						line := strings.TrimSpace(rawLine)
						if line == "" || mdnsHeader.MatchString(line) {
							continue
						}
						parts := strings.Fields(line)
						var addr string
						for _, p := range parts {
							if wirelessPattern.MatchString(p) {
								addr = p
								break
							}
						}
						if addr != "" {
							svcType := ""
							if len(parts) > 1 {
								svcType = parts[1]
							}
							mdnsServices = append(mdnsServices, MDNSService{
								Name:    parts[0],
								Type:    svcType,
								Address: addr,
							})
						}
					}
				}
			}

			msg := "No authorized ADB device is connected."
			recovery := "Pair and connect wireless debugging, then check adb devices. See the README Termux setup."
			if len(devices) > 1 {
				msg = "Multiple authorized ADB devices are connected."
				recovery = "Set ANDROID_SERIAL to the intended device serial from adb devices."
			} else if len(mdnsServices) > 0 {
				recovery = fmt.Sprintf(`Discovered wireless ADB services via mDNS. Call browser_status with android_serial set to the connect address (e.g. %q).`, mdnsServices[0].Address)
			}
			details := map[string]any{"devices": devices}
			if devices == nil {
				details["devices"] = []string{}
			}
			if len(mdnsServices) > 0 {
				details["mdns_services"] = mdnsServices
			}
			return ForwardResult{}, errs.New("ADB_DEVICE_REQUIRED", msg, recovery, details)
		}
		serial = devices[0]
	}

	if wirelessPattern.MatchString(serial) {
		if reconnect {
			_, stderr, err := runADB(5*time.Second, "disconnect", serial)
			if err != nil {
				if ctx.Err() != nil || (!noDevicePattern.MatchString(stderr) && !noDevicePattern.MatchString(err.Error())) {
					return ForwardResult{}, wrapADBError(err)
				}
			}
		}
		if _, _, err := runADB(5*time.Second, "connect", serial); err != nil {
			return ForwardResult{}, wrapADBError(err)
		}
	}

	if _, _, err := runADB(5*time.Second,
		"-s", serial, "shell", "am", "start",
		"-a", "android.intent.action.MAIN",
		"-c", "android.intent.category.LAUNCHER",
		"-p", cfg.Package,
	); err != nil {
		return ForwardResult{}, wrapADBError(err)
	}

	portStr := u.Port()
	if portStr == "" {
		portStr = "80"
	}
	if _, _, err := runADB(5*time.Second, "-s", serial, "forward", "tcp:"+portStr, "localabstract:"+cfg.Socket); err != nil {
		return ForwardResult{}, wrapADBError(err)
	}
	port, _ := strconv.Atoi(portStr)
	return ForwardResult{Serial: serial, Port: port}, nil
}

func wrapADBError(err error) error {
	var ce *errs.ControlError
	if errors.As(err, &ce) {
		return ce
	}
	return errs.New(
		"ADB_FAILED",
		fmt.Sprintf("ADB setup failed: %s", err.Error()),
		"Check adb devices and keep Chrome open. If the wireless port changed, call browser_status with android_serial set to the current address (IP:port). Pair again only if authorization was revoked.",
		nil,
	)
}
