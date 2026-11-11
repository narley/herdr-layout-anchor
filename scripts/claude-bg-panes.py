# Claude Code PostToolUse hook (Bash): when a session in a Herdr Desktop pane starts background
# sessions (`claude --bg`), shows each one beside it. The session keeps its pane on the left; the
# background sessions stack in one column on the right, evenly.
#
# Each background session is attached (`claude attach <id>`) in a child terminal of the session,
# labelled claude.bg=<id>, so the tree mods nest its card under the session. hc run doesn't place
# a terminal, so this adds it to the app's layout, which each machine's Herdr core keeps as the
# "herdr-app" doc. A write only lands if the doc hasn't changed since it was read, so it retries.
#
# Settings (each Claude config dir's settings.json):
#   "PostToolUse": [{"matcher": "Bash", "hooks": [{"type": "command",
#       "command": "python3 -I ~/.config/herdr/claude-bg-panes.py", "timeout": 30}]}]
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

LOG = Path.home() / ".cache/herdr-claude/bg-panes.log"
# hc and claude live here, whatever PATH the session was started with.
os.environ["PATH"] = os.pathsep.join([str(Path.home() / ".local/bin"), "/opt/homebrew/bin", os.environ.get("PATH", "")])


def log(msg):
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(f"{time.strftime('%F %T')} {msg}\n")


def hc(*args, stdin=None):
    r = subprocess.run(["hc", *args], input=stdin, capture_output=True, text=True, timeout=20)
    return r.stdout


def rpc(method, params):
    out = hc("connect", stdin=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}) + "\n")
    reply = json.loads(out.splitlines()[0])
    if "error" in reply:
        raise RuntimeError(f"{method}: {reply['error']}")
    return reply["result"]


def block(terminal):
    return {"type": "block", "id": "p" + secrets.token_hex(16), "content": {"terminal": terminal}}


def path_to(node, terminal, trail=()):
    """The chain of nodes from the root down to the block showing `terminal`."""
    trail = (*trail, node)
    if node.get("content", {}).get("terminal") == terminal:
        return trail
    for child in node.get("children", []):
        found = path_to(child, terminal, trail)
        if found:
            return found
    return None


def even(column):
    for child in column["children"]:
        child["size"] = {"weight": 1 / len(column["children"])}


def place(tab, parent, child, workers):
    """Puts `child` in the column of `parent`'s workers to its right, making that column if needed."""
    trail = path_to(tab["root"], parent)
    me, box = trail[-1], (trail[-2] if len(trail) > 1 else None)
    if box and box["type"] == "row":
        at = box["children"].index(me)
        nxt = box["children"][at + 1] if at + 1 < len(box["children"]) else None
        if nxt and nxt["type"] == "column" and all(
            c.get("content", {}).get("terminal") in workers for c in nxt["children"]
        ):
            nxt["children"].append(block(child))
            even(nxt)
            return
        half = me.get("size", {}).get("weight", 1 / len(box["children"])) / 2
        me["size"] = {"weight": half}
        column = {"type": "column", "id": "s" + secrets.token_hex(16), "size": {"weight": half}, "children": [block(child)]}
        even(column)
        box["children"].insert(at + 1, column)
        return
    # Alone in the tab, or stacked in a column: becomes a row of itself and the workers' column.
    column = {"type": "column", "id": "s" + secrets.token_hex(16), "size": {"weight": 0.5}, "children": [block(child)]}
    even(column)
    row = {"type": "row", "id": "s" + secrets.token_hex(16), "size": me.get("size", {"weight": 1.0}),
           "children": [dict(me, size={"weight": 0.5}), column]}
    if box is None:
        row["id"] = tab["root"]["id"]
        tab["root"] = row
    else:
        box["children"][box["children"].index(me)] = row


def show(parent, child):
    for _ in range(6):
        doc = rpc("doc.get", {"name": "herdr-app"})
        layout = doc["value"]
        tab = next((t for s in layout["spaces"] for t in s["tabs"] if path_to(t["root"], parent)), None)
        if tab is None:
            log(f"no app tab shows {parent}; {child} left without a pane")
            return
        if path_to(tab["root"], child):
            return
        live = json.loads(hc("ls", "--json") or "{}").get("terminals", [])
        workers = {t["address"] for t in live if t.get("parent") == parent}
        place(tab, parent, child, workers)
        try:
            rpc("doc.set", {"name": "herdr-app", "value": layout, "version": doc["version"]})
            return
        except RuntimeError as e:
            log(f"retrying {child}: {e}")
            time.sleep(0.3)
    log(f"gave up placing {child}")


def attached(bg_id):
    """A live terminal already attached to this background session."""
    for t in json.loads(hc("ls", "--json") or "{}").get("terminals", []):
        if t.get("state") == "live":
            labels = json.loads(hc("get", t["address"], "--json") or "{}").get("labels") or {}
            if labels.get("claude.bg") == bg_id:
                return True
    return False


def main():
    parent = os.environ.get("HC_TERMINAL_ID")
    event = json.load(sys.stdin)
    command = (event.get("tool_input") or {}).get("command", "")
    if not parent or event.get("tool_name") != "Bash" or not re.search(r"--(bg|background)\b", command):
        return
    response = event.get("tool_response") or {}
    output = response if isinstance(response, str) else f"{response.get('stdout', '')}\n{response.get('stderr', '')}"
    ids = list(dict.fromkeys(re.findall(r"claude attach ([0-9a-f]{6,})", output)))
    claude = shutil.which("claude") or str(Path.home() / ".local/bin/claude")
    env = ["env", f"PATH={os.environ.get('PATH', '')}"]
    if os.environ.get("CLAUDE_CONFIG_DIR"):
        env.append(f"CLAUDE_CONFIG_DIR={os.environ['CLAUDE_CONFIG_DIR']}")
    for bg_id in ids:
        if attached(bg_id):
            continue
        out = hc("run", "--bg", "--json", "--outlive-parent", "--no-notify", "--parent", parent,
                 "--label", f"claude.bg={bg_id}", "--cwd", event.get("cwd") or os.getcwd(),
                 *env, claude, "attach", bg_id)
        child = (json.loads(out or "{}") or {}).get("address")
        if not child:
            log(f"couldn't attach {bg_id}: {out.strip()}")
            continue
        show(parent, child)


try:
    main()
except Exception as e:  # a hook must never get in the session's way
    log(f"error: {e!r}")
