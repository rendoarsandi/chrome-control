.PHONY: build test clean

build:
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/chrome-control-mcp ./cmd/chrome-control-mcp

test:
	CGO_ENABLED=0 go test -v ./...

clean:
	rm -f bin/chrome-control-mcp
