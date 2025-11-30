.PHONY: install dev build test clean help version-patch version-minor version-major publish publish-dry lint format typecheck daemon-start daemon-stop daemon-status

# Absolute paths
ROOT_DIR := $(shell pwd)
DIST_DIR := $(ROOT_DIR)/dist

# Default target
help:
	@echo "Bounty-Net - Available commands:"
	@echo ""
	@echo "  Development:"
	@echo "    make install        Install all dependencies"
	@echo "    make dev            Build in watch mode"
	@echo "    make build          Build for production"
	@echo "    make test           Run tests"
	@echo "    make lint           Run ESLint"
	@echo "    make format         Format code with Prettier"
	@echo "    make typecheck      Run TypeScript type checking"
	@echo "    make clean          Remove build artifacts and node_modules"
	@echo ""
	@echo "  Daemon:"
	@echo "    make daemon-start   Start the background daemon"
	@echo "    make daemon-stop    Stop the background daemon"
	@echo "    make daemon-status  Check daemon status"
	@echo ""
	@echo "  Publishing:"
	@echo "    make version-patch  Bump patch version (0.1.0 -> 0.1.1)"
	@echo "    make version-minor  Bump minor version (0.1.0 -> 0.2.0)"
	@echo "    make version-major  Bump major version (0.1.0 -> 1.0.0)"
	@echo "    make publish-dry    Dry run of npm publish"
	@echo "    make publish        Build and publish to npm"
	@echo ""

# Install dependencies
install:
	@echo "Installing dependencies..."
	npm install
	@echo "Dependencies installed"

# Development mode with watch
dev:
	@echo "Starting development mode..."
	npm run dev

# Build for production
build:
	@echo "Building for production..."
	npm run build
	@echo "Build complete: $(DIST_DIR)"

# Run tests
test:
	@echo "Running tests..."
	npm test

# Lint code
lint:
	@echo "Running ESLint..."
	npm run lint

# Format code
format:
	@echo "Formatting code..."
	npm run format

# Type checking
typecheck:
	@echo "Running TypeScript type check..."
	npm run typecheck

# Clean up
clean:
	@echo "Cleaning up..."
	rm -rf $(DIST_DIR)
	rm -rf node_modules
	rm -rf ~/.bounty-net/bounty-net.db
	@echo "Cleaned"

# Daemon management
daemon-start:
	@echo "Starting daemon..."
	node $(DIST_DIR)/cli.js daemon start

daemon-stop:
	@echo "Stopping daemon..."
	node $(DIST_DIR)/cli.js daemon stop

daemon-status:
	@echo "Checking daemon status..."
	node $(DIST_DIR)/cli.js daemon status

# Version bumping (updates package.json, commits, and tags)
version-patch:
	@echo "Bumping patch version..."
	@npm version patch --no-git-tag-version
	@VERSION=$$(node -p "require('./package.json').version") && \
		git add package.json package-lock.json && \
		git commit -m "Bump version to v$$VERSION" && \
		git tag -a "v$$VERSION" -m "Release v$$VERSION" && \
		echo "Version bumped to v$$VERSION and tagged"

version-minor:
	@echo "Bumping minor version..."
	@npm version minor --no-git-tag-version
	@VERSION=$$(node -p "require('./package.json').version") && \
		git add package.json package-lock.json && \
		git commit -m "Bump version to v$$VERSION" && \
		git tag -a "v$$VERSION" -m "Release v$$VERSION" && \
		echo "Version bumped to v$$VERSION and tagged"

version-major:
	@echo "Bumping major version..."
	@npm version major --no-git-tag-version
	@VERSION=$$(node -p "require('./package.json').version") && \
		git add package.json package-lock.json && \
		git commit -m "Bump version to v$$VERSION" && \
		git tag -a "v$$VERSION" -m "Release v$$VERSION" && \
		echo "Version bumped to v$$VERSION and tagged"

# Dry run publish to see what would be published
publish-dry: build
	@echo "Dry run of npm publish..."
	npm pack --dry-run
	@echo ""
	@echo "Would publish version $$(node -p "require('./package.json').version")"

# Publish to npm
publish: build
	@echo "Publishing to npm..."
	npm publish
	@VERSION=$$(node -p "require('./package.json').version") && \
		echo "Published bounty-net@$$VERSION" && \
		git push && \
		git push --tags
