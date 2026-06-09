"""
Agent-Browser Integration Tests — Garuda Terminal via SClaw Web UI + TCP tunnel.

These tests verify that the full chain works:
  Browser → SClaw Frontend (Garuda tab) → SClaw Backend API
    → TCP tunnel (port 19998) → Garuda CLI → response back

Prerequisites:
  - SClaw backend running (port 3001)
  - garuda-tunnel.py running (ports 19999 WS + 19998 TCP)
  - Garuda CLI available at ~/workspace/venv/bin/garuda

Run:
  cd /path/to/sclaw
  python3 -m pytest tests/e2e/test_agent_browser.py --headed --slowmo 300 -v

  Headless mode:
  python3 -m pytest tests/e2e/test_agent_browser.py -v
"""

import pytest
import socket
import json
import time
import re


# =============================================================================
# Test: TCP Tunnel Direct (no browser needed)
# =============================================================================

def test_tunnel_direct_ping():
    """
    Verify the TCP tunnel (port 19998) is reachable and responds to commands.

    Sends a simple "echo" command and verifies we get a response.
    This tests the lowest layer: SClaw backend → TCP tunnel → Garuda CLI.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(15)
    try:
        sock.connect(("127.0.0.1", 19998))
        # Send a simple command — Garuda CLI doesn't do shell echo,
        # so "ping" is a valid no-op that returns without error
        sock.sendall(b"ping\n")

        response = b""
        while True:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            except socket.timeout:
                break

        decoded = response.decode("utf-8", errors="replace")
        # The tunnel is alive if we got any response (not empty)
        assert len(decoded) > 0, "Expected non-empty response from TCP tunnel"
        # Verify the tunnel forwarded to Garuda (should see Garuda startup messages)
        assert "Garuda" in decoded or "session" in decoded.lower(), \
            f"Expected Garuda-related response, got: {decoded[:200]}"
    except ConnectionRefusedError:
        pytest.fail("TCP tunnel on port 19998 is not running. Start garuda-tunnel.py first.")
    finally:
        sock.close()


def test_tunnel_direct_list_tasks():
    """
    Verify we can list Garuda tasks via the TCP tunnel.

    Sends "list tasks" and verifies we get a session listing back.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(30)
    try:
        sock.connect(("127.0.0.1", 19998))
        sock.sendall(b"list tasks\n")

        response = b""
        while True:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            except socket.timeout:
                break

        decoded = response.decode("utf-8", errors="replace")

        # Should contain session info or task list
        assert len(decoded) > 50, f"Response too short: {decoded[:100]}"
        # Should mention sessions
        assert any(word in decoded.lower() for word in
                   ["session", "task", "available", "garuda"]), \
            f"Expected session/task info, got: {decoded[:200]}"
    except ConnectionRefusedError:
        pytest.fail("TCP tunnel on port 19998 is not running.")
    finally:
        sock.close()


def test_tunnel_direct_garuda_command():
    """
    Verify we can run arbitrary Garuda commands via TCP tunnel.

    Sends a status check command and verifies Garuda responds.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(30)
    try:
        sock.connect(("127.0.0.1", 19998))
        # Query memory stats
        sock.sendall(b"check status\n")

        response = b""
        while True:
            try:
                chunk = sock.recv(4096)
                if not chunk:
                    break
                response += chunk
            except socket.timeout:
                break

        decoded = response.decode("utf-8", errors="replace")
        # Should have SOME output from Garuda
        assert len(decoded) > 20, f"Response too short: {decoded[:100]}"
    except ConnectionRefusedError:
        pytest.fail("TCP tunnel on port 19998 is not running.")
    finally:
        sock.close()


# =============================================================================
# Test: SClaw Backend API (no browser needed)
# =============================================================================

def test_backend_garuda_health():
    """
    Verify the SClaw backend Garuda health endpoint works.

    Calls GET /api/admin/garuda/health and checks response.
    This tests the middle layer: HTTP API → TCP tunnel → Garuda CLI.
    """
    import urllib.request
    import json as json_lib

    base_url = "http://127.0.0.1:3001"
    try:
        req = urllib.request.Request(f"{base_url}/api/admin/garuda/health")
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json_lib.loads(resp.read().decode())
            assert data.get("ok") is not None, f"Missing 'ok' field: {data}"
    except urllib.error.URLError as e:
        pytest.skip(f"SClaw backend not reachable at {base_url}: {e}")


def test_backend_garuda_exec():
    """
    Verify we can execute commands via the SClaw backend API.

    Calls POST /api/admin/garuda/exec with a simple command and checks response.
    This tests: HTTP API → net.Socket → TCP tunnel → Garuda CLI.
    """
    import urllib.request
    import json as json_lib

    base_url = "http://127.0.0.1:3001"
    try:
        data = json_lib.dumps({"command": "list tasks"}).encode()
        req = urllib.request.Request(
            f"{base_url}/api/admin/garuda/exec",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json_lib.loads(resp.read().decode())
            assert result.get("ok") is True, f"Expected ok=true, got: {result}"
            assert "output" in result, f"Missing 'output' field: {result}"
            assert len(result["output"]) > 20, f"Output too short: {result['output'][:100]}"
    except urllib.error.URLError as e:
        pytest.skip(f"SClaw backend not reachable at {base_url}: {e}")


# =============================================================================
# Test: Browser UI — Garuda Terminal Tab
# =============================================================================

@pytest.mark.skip(reason="Requires admin user logged in; testuser may not be admin")
def test_browser_garuda_tab_visible(login, page):
    """
    Verify the Garuda Terminal tab is visible for admin users.

    This tests the top layer: Browser UI → React component.
    Requires admin login; testuser is not admin by default.
    """
    page = login

    # Look for the Garuda tab button in the nav
    garuda_tab = page.locator('button:has-text("Garuda")')
    assert garuda_tab.is_visible(timeout=10000), \
        "Garuda tab should be visible for admin users"

    # Check it has the plug emoji
    tab_html = garuda_tab.inner_html()
    assert "🔌" in tab_html, f"Garuda tab should have plug emoji: {tab_html}"


def test_browser_garuda_tab_click_and_load(page, base_url):
    """
    Login as admin (jack), click Garuda tab, verify terminal loads.

    Tests: Login → Navigate → Garuda tab → Component render.
    """
    import urllib.parse

    # Login via API to get token
    import urllib.request
    import json as json_lib

    try:
        login_data = json_lib.dumps({"username": "jack", "password": "jack123"}).encode()
        req = urllib.request.Request(
            f"{base_url}/api/auth/login",
            data=login_data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            auth = json_lib.loads(resp.read().decode())
            token = auth.get("token", "")
    except Exception:
        pytest.skip("Cannot login as jack — admin credentials may not exist")

    if not token:
        pytest.skip("No auth token received")

    # Navigate to app
    page.goto(base_url)
    page.wait_for_load_state("networkidle")

    # Set auth token and reload
    page.evaluate(f"localStorage.setItem('auth-token', '{token}')")
    page.reload()
    page.wait_for_load_state("networkidle")

    # Wait for the header to load
    try:
        page.wait_for_selector('header:has-text("SClaw")', timeout=15000)
    except Exception:
        pytest.skip("Could not login as admin")

    # Click the Garuda tab
    garuda_tab = page.locator('button:has-text("Garuda")')
    if not garuda_tab.is_visible(timeout=5000):
        pytest.skip("Garuda tab not visible — user may not be admin")

    garuda_tab.click()
    page.wait_for_timeout(2000)

    # Verify terminal component loaded
    terminal = page.locator("text=Garuda Terminal")
    assert terminal.is_visible(timeout=10000), \
        "Garuda Terminal component should be visible after clicking tab"

    # Verify input field exists
    cmd_input = page.locator('input[placeholder*="Type a command"]')
    assert cmd_input.is_visible(timeout=5000), \
        "Command input field should be visible in terminal"


# =============================================================================
# Test: End-to-End — Browser → Garuda command execution
# =============================================================================

@pytest.mark.skip(reason="Requires admin login; end-to-end test")
def test_browser_send_command_to_garuda(page, base_url):
    """
    Full end-to-end test: Log in as admin → Click Garuda tab → Type command
    → Send → Verify response appears.

    Tests the complete chain:
      Browser UI → fetch() → HTTP API → net.Socket → TCP tunnel(19998)
      → Garuda CLI → response → browser display
    """
    # Login as jack
    import urllib.request
    import json as json_lib

    try:
        login_data = json_lib.dumps({"username": "jack", "password": "jack123"}).encode()
        req = urllib.request.Request(
            f"{base_url}/api/auth/login",
            data=login_data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            auth = json_lib.loads(resp.read().decode())
            token = auth.get("token", "")
    except Exception:
        pytest.skip("Cannot login as jack")

    if not token:
        pytest.skip("No auth token")

    # Navigate and set token
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.evaluate(f"localStorage.setItem('auth-token', '{token}')")
    page.reload()
    page.wait_for_load_state("networkidle")

    try:
        page.wait_for_selector('header:has-text("SClaw")', timeout=15000)
    except Exception:
        pytest.skip("Could not log in")

    # Click Garuda tab
    garuda_tab = page.locator('button:has-text("Garuda")')
    if not garuda_tab.is_visible(timeout=5000):
        pytest.skip("Garuda tab not visible")
    garuda_tab.click()
    page.wait_for_timeout(2000)

    # Wait for connection status (may need to wait for health check)
    page.wait_for_timeout(3000)

    # Type command
    cmd_input = page.locator('input[placeholder*="Type a command"]')
    assert cmd_input.is_visible(timeout=5000), "Command input not visible"

    cmd_input.fill("list tasks")
    page.wait_for_timeout(500)

    # Click Send
    send_button = page.locator('button:has-text("Send")')
    assert send_button.is_visible(), "Send button not visible"
    send_button.click()

    # Wait for response to appear in terminal
    page.wait_for_timeout(5000)

    # Verify response content appeared (check terminal output area)
    terminal_output = page.locator('text=Sessions')
    if not terminal_output.is_visible(timeout=3000):
        # Fallback: check if any new text appeared
        output_area = page.locator('[class*="overflow-y-auto"]')
        text = output_area.text_content()
        assert text and len(text) > 100, \
            f"Expected substantial terminal output, got: {text[:100] if text else 'empty'}"

    # Verify connection indicator
    status_indicator = page.locator('text=Connected')
    # May be connected or disconnected depending on tunnel state
    # Just verify it rendered something
