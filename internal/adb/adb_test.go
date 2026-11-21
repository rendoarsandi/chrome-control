package adb

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rendoarsandi/chrome-control/internal/config"
	"github.com/rendoarsandi/chrome-control/internal/errs"
)

func TestCanForward(t *testing.T) {
	if !CanForward("http://127.0.0.1:9222") || !CanForward("ws://localhost:9222/dev") || !CanForward("http://[::1]:9222") {
		t.Fatal("expected local endpoints to be forwardable")
	}
	if CanForward("https://127.0.0.1:9222") || CanForward("http://192.168.1.5:9222") {
		t.Fatal("expected remote/https endpoints not to be forwardable")
	}
}

func TestForwardChromeMultipleDevicesRejected(t *testing.T) {
	cfg, _ := config.ReadConfig(func(string) (string, bool) { return "", false })
	runner := func(_ context.Context, _ string, args []string) (string, string, error) {
		if len(args) > 0 && args[0] == "devices" {
			return "List of devices attached\nSER1\tdevice\nSER2\tdevice\n", "", nil
		}
		return "", "", nil
	}
	_, err := ForwardChrome(context.Background(), cfg, runner, false)
	var ce *errs.ControlError
	if !errors.As(err, &ce) || ce.Code != "ADB_DEVICE_REQUIRED" {
		t.Fatalf("expected ADB_DEVICE_REQUIRED, got %v", err)
	}
}

func TestForwardChromeZeroDevicesMDNS(t *testing.T) {
	cfg, _ := config.ReadConfig(func(string) (string, bool) { return "", false })
	runner := func(_ context.Context, _ string, args []string) (string, string, error) {
		if len(args) > 0 && args[0] == "devices" {
			return "List of devices attached\n\n", "", nil
		}
		if len(args) >= 2 && args[0] == "mdns" && args[1] == "services" {
			return "List of discovered mdns services\nadb-phone\t_adb-tls-connect._tcp\t192.168.1.42:41234\n", "", nil
		}
		return "", "", nil
	}
	_, err := ForwardChrome(context.Background(), cfg, runner, false)
	var ce *errs.ControlError
	if !errors.As(err, &ce) || ce.Code != "ADB_DEVICE_REQUIRED" {
		t.Fatalf("expected ADB_DEVICE_REQUIRED, got %v", err)
	}
	if !strings.Contains(ce.Recovery, "192.168.1.42:41234") {
		t.Fatalf("expected mDNS address in recovery guidance, got %q", ce.Recovery)
	}
	svcs, ok := ce.Details["mdns_services"].([]MDNSService)
	if !ok || len(svcs) != 1 || svcs[0].Address != "192.168.1.42:41234" {
		t.Fatalf("unexpected mdns_services: %#v", ce.Details["mdns_services"])
	}
}

func TestForwardChromeWirelessReconnect(t *testing.T) {
	cfg, _ := config.ReadConfig(func(k string) (string, bool) {
		if k == "ANDROID_SERIAL" {
			return "192.168.1.50:40123", true
		}
		return "", false
	})
	var calls [][]string
	runner := func(_ context.Context, _ string, args []string) (string, string, error) {
		calls = append(calls, append([]string(nil), args...))
		if len(args) > 0 && args[0] == "disconnect" {
			return "", "error: no such device '192.168.1.50:40123'", errors.New("exit status 1")
		}
		return "connected", "", nil
	}
	res, err := ForwardChrome(context.Background(), cfg, runner, true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Serial != "192.168.1.50:40123" || res.Port != 9222 {
		t.Fatalf("unexpected result: %+v", res)
	}
	if len(calls) != 4 || calls[0][0] != "disconnect" || calls[1][0] != "connect" || calls[2][2] != "shell" || calls[3][2] != "forward" {
		t.Fatalf("unexpected adb call sequence: %v", calls)
	}
}
