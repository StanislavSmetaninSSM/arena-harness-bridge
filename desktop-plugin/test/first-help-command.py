"""Return the runnable example from the first actual Desktop delivery for this test profile."""
import json
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from arena_terminal.desktop_provider import DesktopJournal


def first_help_command(request):
    with TemporaryDirectory() as scratch:
        root = Path(scratch)
        db = DesktopJournal(root / "desktop.sqlite", root)
        try:
            db.pair_owner(request["sessionId"])
            chat = "https://arena.ai/agent/test-first-help"
            address = {"tab": 1, "chat": chat, "binding": db.bind(chat, 1)}
            db.start(request)
            offer = db.poll(address, True)
            example = offer["text"].split("```text\n", 1)[1].split("\n```", 1)[0]
            call = json.loads(example)
            assert call["turn_id"] == "CURRENT_DELIVERY_ID"
            call["turn_id"] = offer["id"]
            db.event(dict(address, kind="sent", id="sent", job=offer["id"]))
            db.event(dict(address, kind="assistant", id="reply", replyTo=offer["id"],
                          toolFrame=True, toolSource=json.dumps(call), text=""))
            return db.status(request["requestId"], request["sessionId"])["reply"]
        finally:
            db.close()


if __name__ == "__main__":
    print(json.dumps(first_help_command(json.load(sys.stdin.buffer))))
