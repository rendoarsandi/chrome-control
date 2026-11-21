# Chrome Control MCP (Go)

Control your existing Android Chrome from Codex, Claude Code, Antigravity, or another MCP client. The assistant supplies the reasoning; this lightweight **pure-Go** binary supplies browser tools over **MCP stdio** by speaking Chrome DevTools Protocol (CDP) directly over WebSocket. It never calls an AI provider and requires no AI API key.

Requires Go 1.22+ (to build from source), Chrome, and an accessible CDP endpoint. On Termux, use Android wireless debugging and ADB to expose that endpoint locally. **No Node.js, Python, Playwright, CGO, bundled Chromium, or Chrome extension is needed.**

## Set up on Termux

Use a current Termux build and Android 11+ wireless debugging. On Samsung, enable Developer options and **Wireless debugging** while connected to Wi-Fi. Keep Chrome open.

```sh
pkg update
pkg install golang android-tools git
cd ~/chrome-control
CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/chrome-control-mcp ./cmd/chrome-control-mcp
```

In Android's Wireless debugging screen, choose **Pair device with pairing code**. Use the pairing address and port displayed there:

```sh
adb pair PHONE_IP:PAIRING_PORT
```

Enter the pairing code when prompted. Then use the **connection** address and port from the main Wireless debugging screen; this port differs from the pairing port:

```sh
adb connect PHONE_IP:CONNECTION_PORT
adb devices
```

The device must show `device`, rather than `offline` or `unauthorized`. Do not hardcode a port: Android can change it when wireless debugging restarts. The MCP server can wake Chrome and establish port forwarding after a connection failure, but pairing and `adb connect` must already work.

To verify the bridge manually, use the serial shown by `adb devices`:

```sh
adb -s DEVICE_SERIAL forward tcp:9222 localabstract:chrome_devtools_remote
curl http://127.0.0.1:9222/json/version
```

A successful response contains `webSocketDebuggerUrl`. When multiple devices are connected, set `ANDROID_SERIAL` in the MCP configuration so the server never guesses which phone to use.

## Connect your assistant

Use the **absolute** binary path. The typical Termux path is `/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp`. You do not need to start a separate server process: the MCP client starts it.

### Codex CLI

```sh
codex mcp add chrome-control -- /data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp
codex mcp list
```

Alternatively, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.chrome-control]
command = "/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp"
startup_timeout_sec = 20
tool_timeout_sec = 45

[mcp_servers.chrome-control.env]
CHROME_CDP_URL = "http://127.0.0.1:9222"
# ANDROID_SERIAL = "SERIAL_FROM_ADB_DEVICES"
```

### Claude Code

```sh
claude mcp add --transport stdio --scope user chrome-control -- /data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp
claude mcp list
```

### Antigravity and other JSON MCP clients

```json
{
  "mcpServers": {
    "chrome-control": {
      "command": "/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp",
      "env": {
        "CHROME_CDP_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

The command runs **on the machine running the MCP client**. Desktop Antigravity cannot execute a Termux path directly. Either build this binary on the desktop and forward the phone's Chrome socket using desktop ADB (`adb -s DEVICE_SERIAL forward tcp:9222 localabstract:chrome_devtools_remote`), or run the Termux binary over an authenticated SSH connection. Set `CHROME_AUTO_ADB` to `"0"` if managing forwarding yourself.

## Tools (33 in `full` mode, 3 in `compact` mode)

| Tool | Purpose |
| --- | --- |
| `browser_status` | Check connection, attempt configured ADB recovery (with mDNS wireless discovery), list tabs |
| `browser_tabs` | List tabs with explicit IDs without waking suspended background renderers |
| `browser_select_tab` | Select and foreground a tab, return a snapshot |
| `browser_new_tab`, `browser_close_tab` | Open or explicitly close a tab |
| `browser_handle_dialog` | Accept or dismiss a JavaScript alert, confirmation or prompt |
| `browser_snapshot` | Read bounded page text and interactive elements (`mode: "dom"`), accessibility tree (`"aria"`), or `"both"`. Supports `format: "compact"`, `viewport_only`, `scope`, `filter`, `roles`, `include_bbox`, and passive CAPTCHA/verification handoff (`human_interaction_required`) |
| `browser_click`, `browser_hover`, `browser_fill` | Click (`button`, `click_count`, `modifiers`, `covered_by` diagnostics), hover, or fill (`press_enter`, `slowly`) using a current reference |
| `browser_drag` | Drag between two element refs or by pixel offset `(dx, dy)` |
| `browser_batch` | Perform a guarded sequence of up to 10 known actions from one snapshot and observe once |
| `browser_exec` | Run persistent JavaScript (embedded pure-Go `goja` runtime; accepts synchronous or `async`/`await` syntax) with helpers (`find_element`, `find_elements`, `click_text`, `fill_label`, etc.) |
| `browser_upload` | Attach local host files via `DataTransfer` (works across devices) to a `file_input` ref or intercepted chooser |
| `browser_downloads` | List captured file downloads or save a download to an explicit local path |
| `browser_cookies` | Inspect, set, delete, or clear cookies via CDP (including `HttpOnly`) |
| `browser_select` | Select native dropdown options by value or visible label |
| `browser_press` | Press Enter, Tab, shortcuts (`Control+A`, `Shift+Tab`), etc. |
| `browser_scroll` | Scroll the viewport, a referenced container, or center an element (`into_view: true`) |
| `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload` | Navigate, traverse history, or reload a selected tab |
| `browser_wait` | Wait for `wait_for` conditions (`text`, `text_absent`, `url`, `selector`, `network_idle: true`) or observe again |
| `browser_screenshot` | Viewport, full page or element JPEG; optional `annotate: true` Set-of-Marks badges (`e1`, `e2`, ...) and `max_dim` limit |
| `browser_tap` | Click viewport CSS pixel coordinates for canvas or visual controls |
| `browser_evaluate` | JavaScript fallback with a result and fresh snapshot |
| `browser_console_messages` | Watch or drain console logs and uncaught exceptions on the selected tab |
| `browser_network_requests` | Watch, drain, or wait for network idle on the selected tab |
| `browser_route` | Add, list, or remove CDP `Fetch` request mocks/interceptions (`fulfill`, `continue`, `abort`) |
| `browser_pdf` | Export the selected tab to PDF via CDP `Page.printToPDF` (file path or base64) |
| `browser_flow` | Capture first-party JSON API requests, save parameterized flows, list schemas, and replay over HTTP or in-page fetch |
| `browser_media` | Inspect, control, download, or record video and audio from the selected tab to a local file path |

Set `CHROME_TOOL_MODE=compact` to expose only `browser_status`, `browser_exec`, and `browser_screenshot` (all other tools remain callable inside `browser_exec`).

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `CHROME_CDP_URL` | `http://127.0.0.1:9222` | HTTP discovery URL or browser WebSocket endpoint |
| `CHROME_AUTO_ADB` | `1` | Set `0` to disable automatic ADB recovery |
| `ANDROID_SERIAL` | unset | Explicit phone serial; otherwise exactly one authorized device is required |
| `CHROME_ANDROID_PACKAGE` | `com.android.chrome` | Android Chrome package to wake |
| `CHROME_DEVTOOLS_SOCKET` | `chrome_devtools_remote` | Android Chrome debugging socket |
| `CHROME_ACTION_TIMEOUT_MS` | `8000` | Per-action timeout, 1000–30000 ms |
| `CHROME_REQUEST_TIMEOUT_MS` | `30000` | Tool execution deadline, 10000–60000 ms |
| `CHROME_TOOL_MODE` | `full` | `compact` exposes three tools while keeping all exec helpers |
| `CHROME_HELPER_FILES` | `[]` | JSON array of absolute paths to assistant-authored JS helper files |
| `CHROME_FLOW_DIR` | unset | Optional absolute directory path to persist saved `browser_flow` JSON files |

## Keeping Termux alive on Android

Running a pure-Go binary drastically reduces RAM compared to Node.js + Playwright, and to prevent Android from suspending or killing background processes while Chrome is foregrounded:

1. Run `termux-wake-lock` in Termux.
2. Set battery optimization to **Unrestricted** for both **Termux** and **Chrome**.
3. In Android **Developer options**, enable **Disable child process restrictions** (prevents Android 12+ Phantom Process Killer).

## Development

```sh
CGO_ENABLED=0 go test -v ./...
CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/chrome-control-mcp ./cmd/chrome-control-mcp
```

All tests run cleanly without needing a browser or network access (using an in-process mock CDP WebSocket server). Real Android wireless debugging and Termux process lifecycle behavior must still be verified on a real Android device.
