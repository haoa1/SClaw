# SClaw Makefile
# Development convenience targets

.PHONY: help test test-e2e test-e2e-headed test-e2e-login test-e2e-chart test-e2e-chat install-e2e

help:
	@echo "Available targets:"
	@echo "  install-e2e       Install Playwright and browser dependencies for E2E tests"
	@echo "  test-e2e          Run E2E browser tests (headless)"
	@echo "  test-e2e-headed   Run E2E browser tests with visible browser window"
	@echo "  test-e2e-login    Run only the login test (headed)"
	@echo "  test-e2e-screen   Run only the screen run test (headed)"
	@echo "  test-e2e-chat     Run only the chat test (headed)"
	@echo "  test-e2e-structure Run only the page structure test (no server needed, headless)"

# =============================================================================
# E2E Browser Tests (Playwright)
# =============================================================================

install-e2e: ## Install Playwright and browser dependencies for E2E tests
	pip3 install pytest-playwright
	python3 -m playwright install chromium --with-deps

test-e2e: ## Run E2E browser tests (headless)
	python3 -m pytest tests/e2e/browser_test.py -v

test-e2e-headed: ## Run E2E browser tests with visible browser window
	python3 -m pytest tests/e2e/browser_test.py -v --headed --slowmo 500

test-e2e-login: ## Run only the login test (headed)
	python3 -m pytest tests/e2e/browser_test.py::test_login -v --headed --slowmo 500

test-e2e-screen: ## Run only the screen run test (headed)
	python3 -m pytest tests/e2e/browser_test.py::test_screen_run -v --headed --slowmo 500

test-e2e-chat: ## Run only the chat test (headed)
	python3 -m pytest tests/e2e/browser_test.py::test_chat -v --headed --slowmo 500

test-e2e-structure: ## Run only the page structure test (no server needed, headless)
	python3 -m pytest tests/e2e/browser_test.py::test_page_structure -v
