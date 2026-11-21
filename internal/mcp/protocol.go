package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sync"
)

// Annotations describes MCP tool behavior hints.
type Annotations struct {
	ReadOnlyHint    bool `json:"readOnlyHint"`
	DestructiveHint bool `json:"destructiveHint"`
	OpenWorldHint   bool `json:"openWorldHint"`
}

// ToolDefinition defines a tool exposed in MCP tools/list.
type ToolDefinition struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
	Annotations Annotations    `json:"annotations"`
}

// ContentItem is one element in an MCP tool result's content array.
type ContentItem struct {
	Type     string `json:"type"`
	Text     string `json:"text,omitempty"`
	Data     string `json:"data,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
}

// ToolResult is returned by tool handlers.
type ToolResult struct {
	IsError           bool           `json:"isError,omitempty"`
	Content           []ContentItem  `json:"content"`
	StructuredContent map[string]any `json:"structuredContent,omitempty"`
}

// Handler executes a registered MCP tool.
type Handler func(ctx context.Context, args map[string]any) ToolResult

type registeredTool struct {
	def     ToolDefinition
	handler Handler
}

// Server implements an MCP JSON-RPC 2.0 server over newline-delimited stdio.
type Server struct {
	name         string
	version      string
	instructions string

	mu    sync.Mutex
	order []string
	tools map[string]registeredTool

	// Serializes tool executions so clients cannot race snapshots and actions.
	execMu sync.Mutex

	writeMu sync.Mutex
}

// NewServer creates a new MCP server.
func NewServer(name, version, instructions string) *Server {
	return &Server{
		name:         name,
		version:      version,
		instructions: instructions,
		tools:        make(map[string]registeredTool),
	}
}

// RegisterTool adds a tool to the MCP server.
func (s *Server) RegisterTool(def ToolDefinition, handler Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, exists := s.tools[def.Name]; !exists {
		s.order = append(s.order, def.Name)
	}
	s.tools[def.Name] = registeredTool{def: def, handler: handler}
}

// ListTools returns all registered tool definitions in registration order.
func (s *Server) ListTools() []ToolDefinition {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ToolDefinition, 0, len(s.order))
	for _, name := range s.order {
		out = append(out, s.tools[name].def)
	}
	return out
}

// CallTool invokes a registered tool directly (serialized).
func (s *Server) CallTool(ctx context.Context, name string, args map[string]any) (ToolResult, bool) {
	s.mu.Lock()
	tool, ok := s.tools[name]
	s.mu.Unlock()
	if !ok {
		return ToolResult{}, false
	}
	if args == nil {
		args = map[string]any{}
	}
	s.execMu.Lock()
	defer s.execMu.Unlock()
	return tool.handler(ctx, args), true
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// ServeStdio reads JSON-RPC 2.0 messages from r and writes responses to w until EOF or ctx cancellation.
func (s *Server) ServeStdio(ctx context.Context, r io.Reader, w io.Writer) error {
	scanner := bufio.NewScanner(r)
	// Support large tool call arguments (e.g., 16 MiB).
	scanner.Buffer(make([]byte, 64*1024), 16*1024*1024)

	writeResp := func(resp rpcResponse) error {
		data, err := json.Marshal(resp)
		if err != nil {
			return err
		}
		data = append(data, '\n')
		s.writeMu.Lock()
		defer s.writeMu.Unlock()
		_, err = w.Write(data)
		return err
	}

	for scanner.Scan() {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		var req rpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			_ = writeResp(rpcResponse{
				JSONRPC: "2.0",
				ID:      json.RawMessage("null"),
				Error:   &rpcError{Code: -32700, Message: "Parse error: " + err.Error()},
			})
			continue
		}

		// Notifications have no ID; do not send a response.
		isNotification := len(req.ID) == 0 || string(req.ID) == "null"

		switch req.Method {
		case "initialize":
			var params struct {
				ProtocolVersion string `json:"protocolVersion"`
			}
			_ = json.Unmarshal(req.Params, &params)
			proto := params.ProtocolVersion
			if proto == "" {
				proto = "2025-03-26"
			}
			if !isNotification {
				_ = writeResp(rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result: map[string]any{
						"protocolVersion": proto,
						"capabilities": map[string]any{
							"tools": map[string]any{"listChanged": false},
						},
						"serverInfo": map[string]any{
							"name":    s.name,
							"version": s.version,
						},
						"instructions": s.instructions,
					},
				})
			}
		case "notifications/initialized", "notifications/cancelled":
			// No-op notification.
		case "ping":
			if !isNotification {
				_ = writeResp(rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result:  map[string]any{},
				})
			}
		case "tools/list":
			if !isNotification {
				_ = writeResp(rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result: map[string]any{
						"tools": s.ListTools(),
					},
				})
			}
		case "tools/call":
			var params struct {
				Name      string         `json:"name"`
				Arguments map[string]any `json:"arguments"`
			}
			if err := json.Unmarshal(req.Params, &params); err != nil {
				if !isNotification {
					_ = writeResp(rpcResponse{
						JSONRPC: "2.0",
						ID:      req.ID,
						Error:   &rpcError{Code: -32602, Message: "Invalid params: " + err.Error()},
					})
				}
				continue
			}
			res, found := s.CallTool(ctx, params.Name, params.Arguments)
			if !found {
				if !isNotification {
					_ = writeResp(rpcResponse{
						JSONRPC: "2.0",
						ID:      req.ID,
						Error:   &rpcError{Code: -32601, Message: fmt.Sprintf("Unknown tool: %s", params.Name)},
					})
				}
				continue
			}
			if !isNotification {
				_ = writeResp(rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Result:  res,
				})
			}
		default:
			if !isNotification {
				_ = writeResp(rpcResponse{
					JSONRPC: "2.0",
					ID:      req.ID,
					Error:   &rpcError{Code: -32601, Message: fmt.Sprintf("Method not found: %s", req.Method)},
				})
			}
		}
	}
	if err := scanner.Err(); err != nil && err != io.EOF {
		return err
	}
	return nil
}
