package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/rendoarsandi/chrome-control/internal/config"
	"github.com/rendoarsandi/chrome-control/internal/server"
)

const helpText = `chrome-control-mcp v3 (Go) — local Chrome browser tools over MCP stdio

Usage: chrome-control-mcp [--stdio]
       /absolute/path/chrome-control/bin/chrome-control-mcp

Register this binary in your MCP client; do not run it as an interactive REPL.
No Gemini, OpenAI or Anthropic API key is required by this server.

Configuration:
  CHROME_CDP_URL             Default: http://127.0.0.1:9222
  CHROME_AUTO_ADB            1 (default) or 0 to disable Android recovery
  ANDROID_SERIAL             Explicit ADB device when multiple devices exist
  CHROME_ANDROID_PACKAGE     Default: com.android.chrome
  CHROME_DEVTOOLS_SOCKET     Default: chrome_devtools_remote
  CHROME_ACTION_TIMEOUT_MS   Default: 8000
  CHROME_REQUEST_TIMEOUT_MS  Default: 30000
  CHROME_TOOL_MODE           full (default) or compact for three MCP tools
  CHROME_HELPER_FILES        JSON array of absolute JS helper file paths
  CHROME_FLOW_DIR            Optional absolute directory to persist browser_flow JSON files

See README.md for Termux setup and Codex/Claude Code/client configuration.`

func main() {
	args := os.Args[1:]
	for _, a := range args {
		if a == "--help" || a == "-h" {
			fmt.Println(helpText)
			return
		}
		if a != "--stdio" {
			fmt.Fprintln(os.Stderr, "Unknown option. chrome-control-mcp is an MCP server; use --help for usage.")
			os.Exit(1)
		}
	}

	cfg, err := config.ReadConfig(os.LookupEnv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "chrome-control-mcp: %s\n", err.Error())
		os.Exit(1)
	}

	app := server.NewApp(cfg, server.Options{})
	defer app.Close()

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	if err := app.MCP.ServeStdio(ctx, os.Stdin, os.Stdout); err != nil && ctx.Err() == nil {
		fmt.Fprintf(os.Stderr, "chrome-control-mcp: %s\n", err.Error())
		os.Exit(1)
	}
}
