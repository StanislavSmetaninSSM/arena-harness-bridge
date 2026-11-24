"""Terminal entry point for one Arena conversation and a local project."""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import sys
import threading
import time
import unicodedata
import uuid

from .harness import Harness, ToolLoop
from .journal import Journal, Problem
from .transport import Endpoint, ExtensionHandler


def state_path(root):
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / ".local" / "state"))
    key = hashlib.sha256(os.fsencode(os.path.normcase(str(root)))).hexdigest()[:24]
    return base / "ArenaHarnessBridge" / key


def read_pairing(directory):
    path = directory / "extension.token"
    try:
        fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        key = path.read_text(encoding="ascii").strip()
        if len(key) < 40:
            raise Problem("Invalid saved extension token")
        return key
    key = secrets.token_urlsafe(40)
    with os.fdopen(fd, "w", encoding="ascii") as f:
        f.write(key)
    return key


def printable(text):
    return "".join(c for c in text if c in "\n\t" or unicodedata.category(c) not in {"Cc", "Cf"})


HELP = """/status — tab, queue, held deliveries and pending approvals
/allow ID or /deny ID — decide one tool operation
/resolve ID sent|retry|skip — resolve uncertain delivery after inspecting the chat
/resolve ID send|skip — release or discard a held tool result
/inspect ID — inspect the complete held result or an uncertain delivery
/export-image ID — save a generated image or retained input image in this workspace
/export-text ID — save an original message or full oversized tool result
/resume — clear the local pause after an Arena limit has been resolved
/release — let the same chat pair from a replacement tab
/skill NAME MESSAGE — use a local skill explicitly
/image RELATIVE_FILE.png | MESSAGE — attach an actual project PNG
/catalog — send tool schemas and model-visible skill descriptions
/multi — compose several lines, then /send or /cancel
/pair — show the pairing token for the extension popup
/quit — close the local bridge"""


def submit(line, ctx):
    root, db, adapter, loop, token = ctx
    cmd, _, tail = line.partition(" ")
    if cmd == "/quit":
        return False
    if cmd == "/help":
        print(HELP)
    elif cmd == "/status":
        with db.lock:
            row = db.one("SELECT chat, tab FROM binding")
        info = dict(row) if row else "Open popup and bind a conversation"
        with loop.guard:
            approvals = dict(loop.approvals)
        age = round(time.monotonic() - db.last_poll, 1) if db.last_poll is not None else None
        print(printable(json.dumps({"project":str(root), "chat":info,"last_poll_seconds_ago":age,"pause":db.paused(),"deliveries":db.issues(),
                                    "approvals":approvals}, ensure_ascii=False, indent=2)))
    elif cmd == "/inspect":
        print(printable(json.dumps(db.inspect(tail), ensure_ascii=False, indent=2)))
    elif cmd == "/release":
        db.release()
    elif cmd == "/resume":
        db.resume()
    elif cmd == "/export-image":
        suffix, data = db.export_image(tail.strip())
        path = root / f"arena-image-{uuid.uuid4().hex}{suffix}"
        with path.open("xb") as stream:
            stream.write(data)
        print(path)
    elif cmd == "/export-text":
        text = db.export_text(tail)
        path = root / f"arena-text-{uuid.uuid4().hex}.txt"
        with path.open("x",encoding="utf-8") as stream:
            stream.write(text)
        print(path)
    elif cmd == "/pair":
        print(token)
    elif cmd == "/resolve":
        id, _, action = tail.partition(" ")
        db.resolve(id, action)
    elif cmd in ("/allow", "/deny"):
        loop.decide(tail.strip(), cmd == "/allow")
    elif cmd == "/catalog":
        db.use_catalog(adapter.instructions())
        print("Catalog refreshed. Changes accompany the next operator message.")
    elif cmd == "/image":
        file, sep, prompt = tail.partition("|")
        if not sep or not prompt.strip():
            raise Problem("Use /image file.png | prompt")
        path = (root / file.strip()).resolve(strict=True)
        if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size > 4 * 1024**2:
            raise Problem("Choose a project PNG up to 4 MiB")
        with path.open("rb") as stream:
            data = stream.read(4 * 1024**2 + 1)
        if len(data) > 4 * 1024**2 or not data.startswith(b"\x89PNG\r\n\x1a\n"):
            raise Problem("Expected PNG image data")
        print("Queued", db.queue(prompt.strip(), base64.b64encode(data).decode("ascii")))
    elif cmd.startswith("/"):
        name, _, prompt = tail.partition(" ") if cmd == "/skill" else (cmd[1:], " ", tail)
        if not prompt.strip():
            raise Problem("Use /skill NAME MESSAGE or /NAME MESSAGE")
        content = adapter.skill(name)
        print("Queued", db.queue(f"Operator selected local skill {name}:\n{content}\n\nTask:\n{prompt}"))
    elif line.strip():
        print("Queued", db.queue(line))
    return True


def display(db, stop, since):
    while not stop.wait(0.2):
        for event in db.log(since):
            since = event["seq"]
            print(printable(f"\n[{event['kind']}] {event['text']}"), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", type=Path)
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    if not root.is_dir():
        parser.error("--root must be a directory")
    private = state_path(root)
    if private.is_relative_to(root):
        parser.error("Select a project directory outside the bridge's private state")
    with Endpoint(("127.0.0.1", 8766), ExtensionHandler) as server:
        private.mkdir(mode=0o700, parents=True, exist_ok=True)
        token = read_pairing(private)
        db = Journal(private / "journal.sqlite", root)
        try:
            adapter = Harness(root)
        except BaseException:
            db.close()
            raise
        server.configure_pairing(token, accept_legacy=True)
        db.use_catalog(adapter.instructions())
        server.journal, server.adapter = db, adapter
        loop = ToolLoop(db, adapter)
        listener = threading.Thread(target=server.serve_forever, daemon=True)
        with db.lock:
            since = db.one("SELECT COALESCE(MAX(rowid),0) n FROM events")["n"]
        printer = threading.Thread(target=display, args=(db,loop.stop,since), daemon=True)
        listener.start()
        loop.thread.start()
        printer.start()
        print(f"Arena terminal | {root}\nPair extension at 127.0.0.1:8766. Use /pair for token, /help for commands.", flush=True)
        ctx = root, db, adapter, loop, token
        try:
            while True:
                line = input("arena> " if sys.stdin.isatty() else "")
                if line == "/multi":
                    lines = []
                    while True:
                        part = input()
                        if part in ("/send", "/cancel"):
                            break
                        lines.append(part)
                    if part == "/cancel":
                        continue
                    line = "\n".join(lines)
                try:
                    if not submit(line, ctx):
                        break
                except (OSError, ValueError) as error:
                    print(printable(str(error)), file=sys.stderr)
        except (EOFError, KeyboardInterrupt):
            pass
        finally:
            server.shutdown()
            loop.stop.set()
            loop.thread.join()
            printer.join()
            listener.join()
            server.server_close()
            adapter.close()
            db.close()


if __name__ == "__main__":
    main()
