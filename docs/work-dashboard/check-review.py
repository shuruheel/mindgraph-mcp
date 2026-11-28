"""Exercise the story review specimen and dashboard wireframes using Chromium, ChromeDriver and Python 3."""
import json
import socket
import subprocess
import tempfile
import time
from pathlib import Path
from urllib.request import Request, urlopen

STORY_SPECIMEN = Path(__file__).with_name("story-review.html").resolve().as_uri()
WIREFRAMES = Path(__file__).with_name("wireframes.html").resolve().as_uri()


def exercise(port, profile):
    base = f"http://127.0.0.1:{port}"

    def request(method, route, payload=None):
        data = json.dumps(payload).encode() if payload is not None else None
        req = Request(base + route, method=method, data=data,
                      headers={"Content-Type": "application/json"})
        with urlopen(req, timeout=12) as response:
            return json.load(response)["value"]

    options = {"args": ["--headless", "--disable-background-networking",
                        "--disable-dev-shm-usage", f"--user-data-dir={profile}"]}
    session = request("POST", "/session", {"capabilities": {"alwaysMatch": {
        "browserName": "chrome", "goog:chromeOptions": options}}})
    root = "/session/" + session["sessionId"]

    def command(route, args):
        return request("POST", root + route, args)

    def element(selector):
        ids = command("/element", {"using": "css selector", "value": selector})
        return "/element/" + next(iter(ids.values()))

    def click(selector):
        command(element(selector) + "/click", {})

    def text(selector):
        return request("GET", root + element(selector) + "/text")

    def visible(selector):
        return command("/execute/sync", {
            "script": "const e = document.querySelector(arguments[0]); return Boolean(e && !e.hidden);",
            "args": [selector],
        })

    def wait_visible(selector, timeout=3.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if visible(selector):
                return
            time.sleep(0.02)
        raise AssertionError(f"Timed out waiting for {selector} to become visible")

    def nav(section_id):
        click(f'nav a[href="#{section_id}"]')
        wait_visible(f"#{section_id}")

    def active_id():
        return command("/execute/sync", {"script": "return document.activeElement && document.activeElement.id;", "args": []})

    try:
        # 1. Story review specimen — original approval path (failed target)
        command("/url", {"url": STORY_SPECIMEN})
        click("#citation")
        assert "a41c" in text("#passage")
        # All three branches should offer uniform comment buttons
        assert command("/execute/sync", {
            "script": "return document.querySelectorAll('.comment-btn').length === 3;", "args": []})
        click("#approve")
        click("#run")
        assert "approved revision 1 · 2/3" in text("#evidence")
        assert "Target missed" in text("#message")
        assert visible("#measured-value") and text("#measured-value") == "2/3"
        assert text("#case-unavailable") == "Fail"

        # 2. Story review specimen — narrow layout, multi-comment review, revision 2 & passing evidence
        command("/refresh", {})
        command("/window/rect", {"width": 390, "height": 844})
        click('.comment-btn[data-branch="renamed"]')
        command(element("#comment") + "/value", {"text": "Confirm old path is displayed alongside the new path."})
        click('#annotation button[type="submit"]')
        click('.comment-btn[data-branch="unavailable"]')
        comment = "Keep the citation visible when the original is unavailable."
        command(element("#comment") + "/value", {"text": comment})
        click('#annotation button[type="submit"]')
        assert comment in text("#thread")
        assert active_id() == "request-changes"
        click("#request-changes")
        assert not request("GET", root + element("#approve") + "/enabled")
        click("#revised")
        assert active_id() == "branch-unavailable"
        assert "Open the latest revision instead." in text("#prior-branch")
        assert "explain" in text("#branch-unavailable")
        click("#approve")
        click("#run")
        assert "approved revision 2 · 3/3" in text("#evidence")
        assert "target 3/3" in text("#evidence")
        assert text("#measured-value") == "3/3"
        assert text("#case-unavailable") == "Pass"
        assert command("/execute/sync", {
            "script": "return document.body.scrollWidth <= innerWidth", "args": []})

        # 3. Dashboard & Omarchy wireframes
        command("/window/rect", {"width": 1280, "height": 900})
        command("/url", {"url": WIREFRAMES})
        assert "Needs you · 2" in text("#needs")
        click("#preview")
        assert visible("#arrivals")
        click("#reveal")
        assert visible("#newEvent")

        # Pause Memory quality from Objective chat, verify suspended-lane Needs you & reverse undo
        nav("objective")
        click("#switch")
        assert "saving checkpoint" in text("#receipt")
        assert visible("#undoSwitch")
        nav("feed")
        assert "Needs you · 1" in text("#needs"), text("#needs")
        assert "Paused lane" in text("#blockedMeta")
        nav("objective")
        click("#undoSwitch")
        assert "Reversed" in text("#receipt")
        nav("feed")
        assert "Needs you · 2" in text("#needs"), text("#needs")

        # Omarchy launcher: connect, widget toggle, blocker dedupe, dismiss != resolve, disconnect cleanup
        nav("desktop")
        assert not visible("#pluginPanel")
        click("#connect")
        assert visible("#pluginPanel")
        click('.widgetOptions input[value="lanes"]')
        assert visible('[data-widget="lanes"]')
        click("#tryBlocker")
        assert visible("#alertPreview")
        click("#tryBlocker")
        assert "Already notified" in text("#delivery")
        click("#dismissBlocker")
        assert not visible("#alertPreview")
        assert "remains open" in text("#delivery")
        click("#disconnect")
        assert not visible("#pluginPanel")

        # Answer blocker and verify Needs you drops to 1 while thread stays accessible
        nav("feed")
        click("#answerLink")
        wait_visible("#question")
        command(element("#answer") + "/value", {"text": "Use fixture rename-01 at commit b82d."})
        click("#answerForm button")
        assert "Awaiting acknowledgement" in text("#answerReceipt")
        nav("feed")
        assert "Needs you · 1" in text("#needs"), text("#needs")
        assert "Answer sent" in text("#blockedMeta")

        print("Passed story review (original, revised, measured chart, narrow layout) and wireframes (feed, lane undo, Omarchy widgets, blocker dedupe).")
    finally:
        request("DELETE", root)


if __name__ == "__main__":
    with tempfile.TemporaryDirectory() as profile, socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
        sock.close()
        driver = subprocess.Popen(["chromedriver", f"--port={port}"], stdout=subprocess.DEVNULL)
        try:
            for _ in range(100):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        break
                except OSError:
                    if driver.poll() is not None:
                        raise RuntimeError("ChromeDriver exited before startup")
                    time.sleep(0.05)
            exercise(port, profile)
        finally:
            driver.terminate()
            driver.wait(timeout=10)
