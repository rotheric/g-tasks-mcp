.PHONY: build test run restart clean

LAUNCHD_LABEL := com.rotheric.g-tasks-mcp

node_modules: package.json
	npm install
	@touch node_modules

build: node_modules
	npm run build

test: node_modules
	npm test

run: build
	npm start

# Rebuild and restart the background service to pick up new code (macOS launchd).
# Linux/systemd users: `systemctl --user restart g-tasks-mcp` after `make build`.
restart: build
	launchctl kickstart -k gui/$(shell id -u)/$(LAUNCHD_LABEL)

clean:
	rm -rf dist node_modules
