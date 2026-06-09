# SClaw End-to-End Browser Tests

Automated browser tests for the SClaw stock screening web application using **Playwright** (Python) and **pytest**.

## Prerequisites

- Python 3.9+
- Playwright with Chromium browser installed
- The SClaw backend and frontend servers running (for most tests)

## Installation

```bash
# Install pytest-playwright (includes Playwright Python bindings)
pip3 install pytest-playwright

# Install the Chromium browser for Playwright
python3 -m playwright install chromium --with-deps
```

## Test Configuration

The tests connect to `http://47.109.31.187:3001` by default (configured in `conftest.py`).

**Test credentials:**
- Username: `testuser`
- Password: `test123`

## Running Tests

### Quick run (requires server to be up):

```bash
# Run with browser visible (headed mode)
cd /Users/herotommyly/workspace/sclaw
python3 -m pytest tests/e2e/browser_test.py --headed --slowmo 500

# Run headless (for CI)
python3 -m pytest tests/e2e/browser_test.py
```

### Run a specific test:

```bash
python3 -m pytest tests/e2e/browser_test.py::test_login --headed
```

### Run with verbose output:

```bash
python3 -m pytest tests/e2e/browser_test.py -v --headed
```

### Save screenshots on failure:

```bash
python3 -m pytest tests/e2e/browser_test.py --headed --screenshot=only-on-failure
```

## Test Descriptions

| Test | Description | Backend Required |
|------|-------------|-----------------|
| `test_page_structure` | Verify basic HTML structure renders correctly | No |
| `test_login` | Log in with valid credentials and verify dashboard | Yes |
| `test_screen_run` | Select a strategy and run a stock screening | Yes |
| `test_chat` | Send a chat message and verify the response | Yes |
| `test_admin_garuda_page` | (Skipped) Garuda terminal page - not yet built | Yes |

## Test Fixtures (in `conftest.py`)

- **`base_url`**: The application URL (`http://47.109.31.187:3001`)
- **`test_credentials`**: Username/password dict for test authentication
- **`login`**: Reusable fixture that logs in and returns an authenticated page

## Project Structure

```
tests/e2e/
├── README.md          # This file
├── conftest.py        # Shared fixtures and configuration
└── browser_test.py    # Test implementations
```

## Troubleshooting

### "Backend Offline" error
The app shows "Backend Offline" when the backend API is not running.
Start the backend server first, or the test will skip.

### Playwright browser not found
Run `python3 -m playwright install chromium` to download Chromium.

### Test hangs on login
The app first checks health at `/api/health`. If the backend responds
but slowly, increase the `timeout` parameter in the `login` fixture.

### "Slowmo" warnings
Use `--slowmo 500` to add delays between actions for easier debugging.
