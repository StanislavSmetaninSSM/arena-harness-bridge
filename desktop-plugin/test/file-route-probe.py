"""Exercise the Desktop journal with scripted browser events in a native Harness test."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from arena_terminal.desktop_provider import DesktopJournal


def respond(db, request, mode):
    session = request["sessionId"]
    db.pair_owner(session)
    chat = "https://arena.ai/agent/file-route-fixture"
    previous = db.one("SELECT id FROM binding")
    address = dict(chat=chat, tab=3, binding=previous["id"] if previous else db.bind(chat, 3))
    rid = db.start(request)["id"]

    def take():
        offer = db.poll(address, True)
        assert offer, db.status(rid, session)
        db.event(dict(address, kind="sent", id="sent-" + offer["id"], job=offer["id"]))
        return offer

    def command(offer, name, args):
        frame = {"$harness": "tool_call", "turn_id": offer["id"], "name": name, "arguments": args}
        event = dict(address, kind="assistant", id="answer-" + offer["id"], replyTo=offer["id"],
                     toolFrame=True, toolSource=json.dumps(frame), text="")
        db.event(event)
        db.event(event)

    offer = take()
    if "toolResult" in request:
        result = json.loads(request["toolResult"])
        assert not result["failed"], result["text"]
        db.event(dict(address, kind="assistant", id="final-" + offer["id"],
                      replyTo=offer["id"], text=result["text"]))
    else:
        command(offer, "read", {"file_path": "probe.txt"})
        if mode == "ptc":
            corrected = take()
            assert corrected["id"] != offer["id"]
            assert all(word in corrected["text"] for word in ("run_code", "read"))
            assert "probe.txt" not in corrected["text"]
            command(corrected, "run_code", {
                "description": "Read the requested fixture",
                "code": 'console.log(await tools.read({file_path:"probe.txt"}))',
            })
    assert db.poll(address, True) is None
    return db.status(rid, session)


if __name__ == "__main__":
    root = Path(sys.argv[1])
    journal = DesktopJournal(root / "probe.sqlite", root)
    try:
        print(json.dumps(respond(journal, json.load(sys.stdin.buffer), sys.argv[2])))
    finally:
        journal.close()
