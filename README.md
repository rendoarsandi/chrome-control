# Chrome Control MCP

Control your existing Android Chrome from Codex, Claude Code, Antigravity, or another MCP client. The assistant supplies the reasoning; this Node.js server supplies browser tools over **MCP stdio**. It never calls an AI provider and requires no AI API key. Your assistant still needs its normal account or authentication.

Requires Node.js 20+, Chrome, and an accessible Chrome DevTools Protocol (CDP) endpoint. On Termux, use Android wireless debugging and ADB to expose that endpoint locally. No Python, Rust compilation, bundled Chromium, or Chrome extension is needed.

## Set up on Termux

Use a current Termux build and Android 11+ wireless debugging. On Samsung, enable Developer options and **Wireless debugging** while connected to Wi-Fi. Keep Chrome open.

```sh
pkg update
pkg install nodejs-lts android-tools git
cd ~/chrome-control
npm ci
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

If needed, install curl with `pkg install curl`. A successful response contains `webSocketDebuggerUrl`. When multiple devices are connected, set `ANDROID_SERIAL` in the MCP configuration so the server never guesses which phone to use.

## Connect your assistant

Use the **absolute** script path and `node` as the command. The typical Termux path is `/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp.mjs`. Adjust it for your checkout. You do not need to start a separate server process: the MCP client starts it.

### Codex CLI

```sh
codex mcp add chrome-control -- node /data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp.mjs
codex mcp list
```

Alternatively, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.chrome-control]
command = "node"
args = ["/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp.mjs"]
startup_timeout_sec = 20
tool_timeout_sec = 45

[mcp_servers.chrome-control.env]
CHROME_CDP_URL = "http://127.0.0.1:9222"
# ANDROID_SERIAL = "SERIAL_FROM_ADB_DEVICES"
```

### Claude Code

```sh
claude mcp add --transport stdio --scope user chrome-control -- node /data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp.mjs
claude mcp list
```

For a project configuration, place the following in `.mcp.json` at the project root. Claude Code may ask you to trust the project server.

### Antigravity and other JSON MCP clients

In Antigravity's MCP server settings, open the raw configuration and add the same `mcpServers` entry below. Other clients often accept this format too. Merge it with existing entries, then reload the servers.

```json
{
  "mcpServers": {
    "chrome-control": {
      "command": "node",
      "args": ["/data/data/com.termux/files/home/chrome-control/bin/chrome-control-mcp.mjs"],
      "env": {
        "CHROME_CDP_URL": "http://127.0.0.1:9222"
      }
    }
  }
}
```

The command runs **on the machine running the MCP client**. Desktop Antigravity cannot execute a Termux path directly. Either install this project on the desktop and forward the phone's Chrome socket using desktop ADB, or run the Termux server over an authenticated SSH connection. For desktop ADB:

```sh
adb -s DEVICE_SERIAL forward tcp:9222 localabstract:chrome_devtools_remote
```

Use the desktop script path in the client configuration and set `CHROME_AUTO_ADB` to `"0"` if managing forwarding yourself. Keep the CDP endpoint on localhost; it grants control of your browser session.

Optional installation of local command aliases:

```sh
npm install -g .
chrome-control-mcp --help
```

Use `node` directly in MCP configs for the most predictable setup. Avoid `npm start` there, since npm's status output can interfere with the stdio protocol.

## How the assistant uses it

Example instruction:

> Use the chrome-control MCP tools to inspect my Chrome tabs, select the shopping tab, search for a USB-C cable, and show me the options. Read snapshots after actions and report any tool error.

1. Call `browser_status` or `browser_tabs`.
2. If there are multiple tabs, use `browser_select_tab` with the intended `tab_id`. The server never assumes the first tab is the visible one.
3. Read `browser_snapshot`: it contains page text, frames, and elements with names, roles, state, dropdown options, and references.
4. Call an action with a reference such as `snapshot_12345678_2:e4` from that exact result.
5. Inspect the fresh snapshot returned by the action. A new snapshot invalidates old references.

References retain actual DOM nodes. A layout change cannot silently turn an old positional index into a different element. Removed nodes and old references produce `STALE_REF`, requesting a fresh snapshot. Password input values are omitted. An action reporting `executed: true` means the browser operation ran; the assistant must inspect the resulting page to determine whether the goal was achieved.

| Tool | Purpose |
| --- | --- |
| `browser_status` | Check connection, attempt configured ADB recovery, list tabs |
| `browser_tabs` | List tabs with explicit IDs |
| `browser_select_tab` | Select and foreground a tab, return a snapshot |
| `browser_new_tab`, `browser_close_tab` | Open or explicitly close a tab |
| `browser_handle_dialog` | Accept or dismiss a JavaScript alert, confirmation or prompt |
| `browser_snapshot` | Read bounded page text and interactive elements across frames and open shadow roots |
| `browser_click`, `browser_fill` | Click or replace input text using a current reference |
| `browser_select` | Select native dropdown options by value |
| `browser_press` | Press Enter, Tab, shortcuts, etc. |
| `browser_scroll` | Scroll the viewport or a referenced container |
| `browser_navigate`, `browser_back` | Navigate a selected tab |
| `browser_wait` | Wait up to five seconds and observe again |
| `browser_screenshot` | Return a viewport JPEG to the client |
| `browser_tap` | Click viewport CSS pixel coordinates for canvas or visual controls |
| `browser_evaluate` | JavaScript fallback with a result and fresh snapshot |

Tools return JSON text and structured results; screenshots additionally return MCP image content. Errors have `isError: true` and an error code, message, and recovery guidance. Requests are serialized and bounded. On a request timeout, the connection is reset; inspect the page before repeating an action because it may have executed. Startup and tool discovery work even when Chrome is unavailable. Normal stdio output contains only MCP messages.

### Recover without restarting Codex

Call `browser_status` with `{"reconnect":true}` to discard a stalled CDP connection and repair ADB forwarding. For a wireless device, this disconnects and reconnects only the selected ADB address using existing authorization. Chrome and its tabs remain open. Select the intended tab again and use fresh snapshot refs after reconnecting.

When Android changes its wireless debugging connection port, supply the new address: `browser_status({"android_serial":"192.168.100.14:41803"})`. The server reconnects that explicit device with existing ADB authorization and remembers the choice for subsequent requests. Use the connection port from Android's Wireless debugging screen, not its pairing port. No MCP configuration change or Codex restart is needed for these connection changes.

Tab discovery reads Chrome's target metadata without evaluating every page. A paused background renderer cannot block actions in a healthy selected tab. Snapshot reads have frame deadlines; an unresponsive child frame produces a warning, while an unresponsive main frame resets the connection. Element cleanup does not block subsequent tools. Attaching preserves Chrome's existing focus, media and download settings.

Chrome may expose native or not-yet-navigated targets with an empty URL. These are left open and skipped during attachment so they cannot block usable web tabs. They become available when Chrome reports a page URL. New tabs are created with their requested destination directly; if Chrome creates a tab but does not expose its page, the tool reports that outcome so you can inspect before retrying.

Only untargeted reads (`browser_status` and `browser_tabs`) can automatically retry after a connection failure. Clicks, submissions, navigation and evaluation are never automatically repeated. Errors include `may_have_executed` when input may have been sent and `executed` when the operation completed before observation failed. Inspect the page before repeating it.

JavaScript dialogs remain open for the assistant to inspect and explicitly accept or dismiss. A snapshot reports the dialog's type, message and default prompt value. Page actions are blocked until it is handled.

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

## Troubleshooting and limits

- **Assistant writes Python instead of using tools:** check its MCP server list, reload the configuration, and explicitly ask it to use the `chrome-control` tools. This repository's `AGENTS.md` also describes that workflow.
- **Device unavailable:** check `adb devices`, repeat `adb connect` with the current wireless debugging connection port, and keep Chrome open. Pair again if Android revoked authorization.
- **Connection stalled or port changed:** call `browser_status` with `reconnect: true`, or supply the current address as `android_serial`. This repairs the connection inside the running MCP server. Source code updates still require reloading the MCP server once to load the new version; subsequent connection repairs do not require restarting Codex.
- **Wrong tab:** use `browser_tabs` and `browser_select_tab`. Android does not expose a dependable active-tab flag through ordinary CDP discovery.
- **Page still loading:** inspect again with `browser_wait`. If text or elements are truncated, increase `browser_snapshot` limits or scroll to the relevant area.
- **Blank tool response or long pause:** the client should surface the error within the configured request deadline. Set its tool timeout above that deadline (45 seconds for the default 30 seconds).
- **Clicks stall while snapshots work:** Android can pause animation frames even while CDP and JavaScript timers respond. For main-frame controls, the server uses timer-based geometry checks and native mouse input after checking visibility, disabled state and hit testing. If the target is covered or moving, or belongs to an iframe with paused rendering, keep Chrome in the foreground with the screen unlocked and inspect again before retrying.
- **Controls absent from the snapshot:** open shadow roots and web frames are supported. Closed shadow roots, canvas UI, and Chrome's native menus may require visual interaction or manual input. CDP controls web content; it does not automate Android system dialogs or Chrome's native address bar.
- **Termux pauses when Chrome opens:** Android may suspend or kill background apps. Samsung battery settings and `termux-wake-lock` can help keep Termux active; memory usage and survival depend on the device and OS settings.

Screenshots are viewport-sized JPEGs. DOM outputs are bounded to limit memory and context usage. This is a Node.js client controlling the already running browser, so it avoids installing another browser on the phone. It does not guarantee a fixed memory footprint or immunity to Android process termination.

## Development and migration

```sh
npm ci
npm test
CHROME_TEST_EXECUTABLE=/usr/bin/chromium npm test
```

The default tests exercise MCP discovery without Chrome, connection errors, ADB device selection, wireless reconnection arguments, cancellation, configuration, and deadlines. Setting `CHROME_TEST_EXECUTABLE` additionally runs real browser tests through an MCP stdio client, including page actions, iframes, shadow DOM, stale refs after removal and manual navigation, screenshots, dialogs, a paused background renderer, explicit reconnect without restarting the MCP client, recovery from a stalled mutation without replaying it, and preservation of tabs after disconnect. The server does not download a test browser. Desktop tests do not verify Samsung's wireless debugging or Termux process lifecycle.

Version 2 replaces the Gemini agent, Python dependencies, and course/survey solvers with a reusable MCP server. `chrome-control-cli` is now a compatibility entry point for the MCP server. Old flags such as `--solve-course`, `--get-text`, and `--interactive` are removed; clients call the browser tools instead. Configure your existing AI assistant rather than launching `termux_agent.js` or supplying `GEMINI_API_KEY`.
