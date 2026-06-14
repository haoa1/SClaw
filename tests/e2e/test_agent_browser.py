"""
Agent-Browser Integration Tests — Garuda UDS Server via SClaw Web UI + TCP tunnel.

Protocol (JSON-lines over TCP):
  Client → Server:  {"type":"ping"} | {"type":"msg","content":"..."}
  Server → Client:  {"type":"pong"} | {"type":"done","response":"..."}

Architecture:
  Browser → SClaw Frontend (Garuda tab) → SClaw Backend API (REST)
    → TCP socket (localhost:19998, SSH tunnel) → localhost socat
    → UDS (/tmp/garuda.sock) → Garuda --serve (UDS server)

Prerequisites:
  - SClaw backend running (port 3001, PM2)
  - SSH tunnel active (port 19998 → localhost socat → UDS)
  - Garuda --serve listening on /tmp/garuda.sock

Run:
  cd /root/sclaw
  python3 -m pytest tests/e2e/test_agent_browser.py -v

  With browser:
  python3 -m pytest tests/e2e/test_agent_browser.py --headed --slowmo 300 -v
"""

import pytest
import socket
import json
import time
import re
import urllib.request
import urllib.error


# =============================================================================
# Helpers
# =============================================================================

TUNNEL_HOST = "127.0.0.1"
TUNNEL_PORT = 19998
BACKEND_URL = "http://127.0.0.1:3001"
JSON_TIMEOUT = 15  # SSH tunnel adds ~5.5s latency per connection


STREAMING_TYPES = {"reasoning", "tool_call", "tool_result", "bash_stream"}

def _send_json(host, port, obj, timeout=JSON_TIMEOUT):
    """Send a JSON-lines message and read streaming events until terminal event.
    
    Garuda streams: reasoning → tool_call → tool_result → ... → done
    Ping responses: pong (terminal)
    Error responses: error (terminal)
    This reads all events and returns the terminal event (not reasoning/tool_call/tool_result).
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect((host, port))
        sock.sendall((json.dumps(obj) + "\n").encode("utf-8"))
        buf = b""
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                try:
                    event = json.loads(line.decode("utf-8"))
                    if event.get("type") not in STREAMING_TYPES:
                        return event
                except json.JSONDecodeError:
                    continue
        return None
    finally:
        sock.close()


def _http_get(path, timeout=15):
    """Simple HTTP GET returning parsed JSON."""
    req = urllib.request.Request(f"{BACKEND_URL}{path}")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _http_post(path, body, timeout=30):
    """Simple HTTP POST returning parsed JSON."""
    data = json.dumps(body).encode()
    req = urllib.request.Request(
        f"{BACKEND_URL}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode())


def _admin_login():
    """Login as jack, return auth token. Skips test if unavailable."""
    try:
        return _http_post("/api/auth/login", {"username": "jack", "password": "jack123"})
    except urllib.error.HTTPError as e:
        pytest.skip(f"Admin login failed (HTTP {e.code})")
    except urllib.error.URLError:
        pytest.skip("Backend not reachable")


# =============================================================================
# Layer 1: TCP Tunnel (JSON-lines protocol, lowest layer)
# =============================================================================

def test_tunnel_ping():
    """
    Verify TCP tunnel responds to JSON-lines ping.
    Send {"type":"ping"} → expect {"type":"pong"}.
    Tests: TCP socket → SSH tunnel → socat → UDS → garuda --serve
    """
    resp = _send_json(TUNNEL_HOST, TUNNEL_PORT, {"type": "ping"}, timeout=15)
    assert resp is not None, "No response from tunnel (port 19998)"
    assert resp.get("type") == "pong", f"Expected 'pong', got: {resp}"


def test_tunnel_msg_simple():
    """
    Verify TCP tunnel can send a simple message and get AI reply.
    Send {"type":"msg","content":"Say hi in 3 words"} → expect {"type":"done","response":"..."}
    Tests: full JSON-lines protocol through tunnel.
    """
    resp = _send_json(TUNNEL_HOST, TUNNEL_PORT,
                      {"type": "msg", "content": "Say hi in 3 words"},
                      timeout=90)
    assert resp is not None, "No response from tunnel for msg"
    assert resp.get("type") == "done", f"Expected 'done', got: {resp}"
    assert resp.get("response"), f"Missing 'response' field: {resp}"
    assert len(resp["response"]) > 0, f"Empty response: {resp}"


def test_tunnel_hello_world():
    """
    Verify Garuda can write Hello World code.
    Tests: AI coding capability through JSON-lines protocol.
    """
    resp = _send_json(TUNNEL_HOST, TUNNEL_PORT,
                      {"type": "msg", "content": "Write a Hello World program in Python"},
                      timeout=120)
    assert resp is not None, "No response from tunnel"
    assert resp.get("type") == "done", f"Expected 'done', got: {resp}"
    resp_text = resp.get("response", "")
    assert "print" in resp_text.lower() or "hello" in resp_text.lower(), \
        f"Response should contain Hello World code: {resp_text[:200]}"


def _read_until_done(sock, timeout=60):
    """Read from socket until we get a terminal event (done/pong/error), return it."""
    sock.settimeout(timeout)
    buf = b""
    while True:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            try:
                event = json.loads(line.decode("utf-8"))
                if event.get("type") not in STREAMING_TYPES:
                    return event
            except json.JSONDecodeError:
                continue
    return None


def test_tunnel_conversation():
    """
    Verify Garuda can hold a short multi-turn conversation.
    Two messages in sequence on the same connection.
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(60)
    try:
        sock.connect((TUNNEL_HOST, TUNNEL_PORT))

        # Turn 1: greeting
        sock.sendall((json.dumps({"type": "msg", "content": "Say hello"}) + "\n").encode())
        resp1 = _read_until_done(sock, timeout=60)
        assert resp1 is not None, "Turn 1: No response from tunnel"
        assert resp1.get("type") == "done", f"Turn 1 expected done: {resp1}"
        assert resp1.get("response"), f"Turn 1 missing response: {resp1}"

        # Turn 2: follow-up on same connection
        sock.sendall((json.dumps({"type": "msg", "content": "What is 2+2?"}) + "\n").encode())
        resp2 = _read_until_done(sock, timeout=60)
        assert resp2 is not None, "Turn 2: No response from tunnel"
        assert resp2.get("type") == "done", f"Turn 2 expected done: {resp2}"
        assert "4" in resp2.get("response", ""), \
            f"2+2 should be 4: {resp2['response'][:100]}"
    finally:
        sock.close()


def test_tunnel_error_on_bad_json():
    """
    Verify tunnel returns error on invalid JSON.
    Send garbage → expect {"type":"error","content":"..."}
    """
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.settimeout(10)
    try:
        sock.connect((TUNNEL_HOST, TUNNEL_PORT))
        sock.sendall(b"this is not json\n")
        buf = b""
        while b"\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk:
                break
            buf += chunk
        line = buf.split(b"\n", 1)[0]
        resp = json.loads(line.decode())
        assert resp.get("type") == "error", f"Expected error: {resp}"
    finally:
        sock.close()


# =============================================================================
# Layer 2: SClaw Backend API (HTTP + net.Socket)
# =============================================================================

def test_backend_health():
    """
    Verify SClaw backend Garuda health endpoint.
    GET /api/admin/garuda/health → {"ok":true,"status":"connected"}
    Tests: HTTP API → net.Socket → TCP tunnel → UDS → Garuda ping
    """
    data = _http_get("/api/admin/garuda/health", timeout=15)
    assert data.get("ok") is True, f"Expected ok=true, got: {data}"
    assert data.get("status") == "connected", f"Expected connected: {data}"


def test_backend_exec_say_hi():
    """
    Verify exec endpoint with simple command.
    POST /api/admin/garuda/exec {"command":"Say hi"}
    Tests: HTTP API → net.Socket → JSON-lines tunnel → response
    """
    result = _http_post("/api/admin/garuda/exec", {"command": "Say hi in 5 words"}, timeout=90)
    assert result.get("ok") is True, f"Expected ok=true, got: {result}"
    assert result.get("output"), f"Missing output: {result}"
    assert len(result["output"]) > 3, f"Output too short: {result['output'][:100]}"


def test_backend_exec_hello_world():
    """
    Verify exec endpoint with Hello World request.
    POST /api/admin/garuda/exec {"command":"Write Hello World in Python"}
    """
    result = _http_post("/api/admin/garuda/exec",
                        {"command": "Write Hello World in Python"},
                        timeout=120)
    assert result.get("ok") is True, f"Expected ok=true, got: {result}"
    assert "print" in result.get("output", "").lower(), \
        f"Expected print() in output: {result['output'][:200]}"


def test_backend_tasks():
    """
    Verify tasks endpoint returns Garuda status.
    GET /api/admin/garuda/tasks
    """
    result = _http_get("/api/admin/garuda/tasks", timeout=60)
    assert result.get("ok") is True, f"Expected ok=true, got: {result}"
    output = result.get("output", "")
    assert len(output) > 20, f"Tasks output too short: {output[:100]}"


# =============================================================================
# Layer 3: Browser UI — Garuda Terminal Tab (admin-only)
# =============================================================================

def test_browser_garuda_tab_visible(page, base_url):
    """
    Verify Garuda Terminal tab is visible for admin (jack) users.

    Logs in as jack via API, sets token in localStorage, navigates,
    clicks Garuda tab, verifies component renders.
    """
    auth = _admin_login()
    token = auth.get("token", "")
    if not token:
        pytest.skip("No auth token from admin login")

    # Navigate and inject auth
    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.evaluate(f"window.localStorage.setItem('auth-token', '{token}')")
    page.reload()
    page.wait_for_load_state("networkidle")

    # Wait for header
    page.wait_for_selector('header:has-text("SClaw")', timeout=15000)

    # Click Garuda tab
    garuda_tab = page.locator('button:has-text("Garuda")')
    assert garuda_tab.is_visible(timeout=5000), \
        "Garuda tab should be visible for admin users"

    # Check plug emoji
    tab_html = garuda_tab.inner_html()
    assert "🔌" in tab_html, f"Expected 🔌 emoji in tab: {tab_html}"

    garuda_tab.click()
    page.wait_for_timeout(2000)

    # Verify terminal heading
    terminal = page.locator("text=Garuda Terminal")
    assert terminal.is_visible(timeout=10000), \
        "Garuda Terminal heading should be visible"

    # Verify connection status indicator
    status_dot = page.locator('[class*="status"], .text-green-500, [class*="connected"]')
    if status_dot.is_visible(timeout=3000):
        pass  # Nice to have but not critical


def test_browser_send_hi_command(page, base_url):
    """
    Full E2E: Browser → Garuda tab → type "Say Hi" → send → verify response.

    Tests the complete chain:
      Browser UI → fetch() → HTTP API → net.Socket → TCP tunnel
      → socat → UDS → Garuda LLM → response → browser display
    """
    auth = _admin_login()
    token = auth.get("token", "")
    if not token:
        pytest.skip("No auth token")

    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.evaluate(f"window.localStorage.setItem('auth-token', '{token}')")
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_selector('header:has-text("SClaw")', timeout=15000)

    # Click Garuda tab
    garuda_tab = page.locator('button:has-text("Garuda")')
    if not garuda_tab.is_visible(timeout=5000):
        pytest.skip("Garuda tab not visible")
    garuda_tab.click()
    page.wait_for_timeout(2000)

    # Wait for terminal to load and health check
    page.wait_for_selector("text=Garuda Terminal", timeout=10000)
    page.wait_for_timeout(3000)  # Let health check complete

    # Type command
    cmd_input = page.locator('input[placeholder*="Type a command"]')
    assert cmd_input.is_visible(timeout=5000), "Command input not visible"
    cmd_input.fill("Say hi")
    page.wait_for_timeout(500)

    # Click Send
    send_button = page.locator('button:has-text("Send")')
    assert send_button.is_visible(), "Send button not visible"
    send_button.click()

    # Wait for response
    page.wait_for_timeout(15000)

    # Verify terminal output area has content
    output_area = page.locator('[class*="overflow-y-auto"], [class*="terminal-output"], pre')
    text = output_area.text_content()
    assert text, "Terminal output should have content"
    assert len(text) > 10, f"Output too short: {text[:100]}"


def test_browser_hello_world(page, base_url):
    """
    Full E2E: Send "write a Hello World program" and verify code output.

    Tests AI coding capability through the full browser→backend→tunnel→Garuda chain.
    """
    auth = _admin_login()
    token = auth.get("token", "")
    if not token:
        pytest.skip("No auth token")

    page.goto(base_url)
    page.wait_for_load_state("networkidle")
    page.evaluate(f"window.localStorage.setItem('auth-token', '{token}')")
    page.reload()
    page.wait_for_load_state("networkidle")
    page.wait_for_selector('header:has-text("SClaw")', timeout=15000)

    garuda_tab = page.locator('button:has-text("Garuda")')
    if not garuda_tab.is_visible(timeout=5000):
        pytest.skip("Garuda tab not visible")
    garuda_tab.click()
    page.wait_for_timeout(2000)
    page.wait_for_selector("text=Garuda Terminal", timeout=10000)
    page.wait_for_timeout(3000)

    cmd_input = page.locator('input[placeholder*="Type a command"]')
    cmd_input.fill("Write a Hello World program in Python")
    page.wait_for_timeout(500)

    send_button = page.locator('button:has-text("Send")')
    send_button.click()

    # Wait for AI response to render
    page.wait_for_timeout(20000)

    output_area = page.locator('[class*="overflow-y-auto"], [class*="terminal-output"], pre')
    text = output_area.text_content()
    assert text, "Terminal output should have content"

    # Should contain some code-like output
    assert "print" in text.lower() or "def " in text or "hello" in text.lower(), \
        f"Expected Hello World code in output: {text[:200]}"


def test_browser_garuda_tab_not_visible_for_testuser(login, page):
    """
    Verify testuser (non-admin) cannot see the Garuda tab.
    Tests admin-only access control in the UI.
    """
    page = login

    # Verify the standard user is logged in
    page.wait_for_selector('header:has-text("SClaw")', timeout=15000)

    # The Garuda tab should NOT be visible for testuser
    garuda_tab = page.locator('button:has-text("Garuda")')
    assert not garuda_tab.is_visible(timeout=3000), \
        "Garuda tab should NOT be visible for non-admin users"
