"""
Shared fixtures for SClaw browser tests.

Uses pytest-playwright for browser automation.
"""

import pytest

# Base URL for the SClaw application
BASE_URL = "http://47.109.31.187:3001"

# Test user credentials
TEST_USERNAME = "testuser"
TEST_PASSWORD = "test123"


@pytest.fixture(scope="session")
def base_url() -> str:
    """Base URL for the SClaw application."""
    return BASE_URL


@pytest.fixture(scope="session")
def test_credentials() -> dict:
    """Test user credentials."""
    return {"username": TEST_USERNAME, "password": TEST_PASSWORD}


@pytest.fixture(scope="function")
def login(page, base_url, test_credentials):
    """Log in as testuser and return the page."""
    page.goto(base_url)
    page.wait_for_load_state("networkidle")

    # Wait for login form to appear (handles backend check/offline states)
    page.wait_for_selector('input[placeholder="Enter username"]', timeout=30000)

    # Fill in credentials
    page.fill('input[placeholder="Enter username"]', test_credentials["username"])
    page.fill('input[placeholder="Enter password"]', test_credentials["password"])

    # Click login button
    page.click('button[type="submit"]')

    # Wait for dashboard to load (look for the SClaw header)
    page.wait_for_selector('header:has-text("SClaw")', timeout=30000)
    return page
