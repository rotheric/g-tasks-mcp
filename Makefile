.DEFAULT_GOAL := help
.PHONY: help build test run embeddings embeddings-offline install restart status logs clean

LAUNCHD_LABEL := com.rotheric.g-tasks-mcp

help:
	@echo "Targets:"
	@echo "  build    Build the server (repair dependencies if needed)"
	@echo "  test     Run the test suite (repair dependencies if needed)"
	@echo "  run      Build and run in the foreground"
	@echo "  embeddings  Synchronize embeddings via the running MCP server (REBUILD=1 to regenerate)"
	@echo "  embeddings-offline  Synchronize directly with the server stopped (recovery)"
	@echo "  install  Build, install/update and start the macOS LaunchAgent"
	@echo "  restart  Build and restart the installed macOS service"
	@echo "  status   Show the macOS service state and last exit status"
	@echo "  logs     Follow stdout and stderr logs (Ctrl-C to stop)"
	@echo "  clean    Remove build output and dependencies"

build:
	npm run build

test:
	npm test

run: build
	npm start

embeddings: build
	node dist/index.js embeddings $(if $(filter 1,$(REBUILD)),--rebuild,)

embeddings-offline: build
	node dist/index.js embeddings-offline $(if $(filter 1,$(REBUILD)),--rebuild,)

install:
	node scripts/install-launchd.cjs --check-platform
	$(MAKE) build
	node scripts/install-launchd.cjs

# Rebuild and restart the background service to pick up new code (macOS launchd).
# Linux/systemd users: `systemctl --user restart g-tasks-mcp` after `make build`.
restart: build
	launchctl kickstart -k gui/$(shell id -u)/$(LAUNCHD_LABEL)

status:
	node scripts/install-launchd.cjs --check-platform
	launchctl print gui/$(shell id -u)/$(LAUNCHD_LABEL)

logs:
	node scripts/install-launchd.cjs --check-platform
	tail -n 100 -F "$$HOME/Library/Logs/g-tasks-mcp.log" "$$HOME/Library/Logs/g-tasks-mcp.error.log"

clean:
	rm -rf dist node_modules
