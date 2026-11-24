"""Private stdio companion for the DeepSeek Harness Desktop model provider."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import threading

from .__main__ import read_pairing
from .journal import (
    InvalidToolSource, Journal, Problem, TOOL_REPLY_GUIDANCE, decode_generated_images,
    new_id, source_tool_frame, tool_frame,
)
from .transport import Endpoint, ExtensionHandler


TOOL_RESULT_HEADER = "DeepSeek Harness tool result:"
READ_BATCH = "arena_read_batch"
READ_BATCH_TOOLS = {"read", "glob", "grep"}
DESKTOP_CANCELLED = "Desktop cancelled this request"
DESKTOP_TOOL_HANDOFF = (
    "For local Windows work, put the tool request in your visible reply for Desktop. "
    "Arena's shell runs in the cloud. "
    + TOOL_REPLY_GUIDANCE
    + " End the reply after issuing the request. Desktop executes it and returns the result in the next message."
)
TEXT_ARGUMENTS = {"pwsh": "command"}
TEXT_ARGUMENT_GUIDANCE = (
    'For a multiline pwsh script, use "command":{"$text":"script"} in the same JSON tool call. '
    'In the same reply add one top-level fenced block opening with ```harness-text script and closing with ```. '
    'Put the actual script between those lines with normal newlines, quotes, and backslashes. '
    'Desktop inserts that text as the native command string. For a short one-line command, use a normal JSON command string.'
)
TEXT_BLOCK_NAME = r"[A-Za-z][A-Za-z0-9_-]{0,31}"
PLAN_ACTIVE = (
    "DeepSeek Harness plan mode: ACTIVE. Use only read-only inspection. Do not modify files or settings, "
    "commit, or implement the task. Ask the user only about decisions that inspection cannot resolve. "
    "When the plan is ready, reply with one fenced json block to request local review. "
    'Use this object shape: {"$harness":"tool_call","turn_id":"CURRENT_DELIVERY_ID","name":"exit_plan_mode","arguments":{"plan":"# Plan"}}. '
    "Replace CURRENT_DELIVERY_ID with the ID on the final Bridge delivery line of this request. "
    "Replace # Plan with the complete Markdown plan, including its heading. The local bridge reads this "
    "reply and Desktop opens its built-in plan review. Use this route for approval. Arena's question "
    "cards are for clarification only. Keep planning if the Desktop review is declined. "
    "Implementation begins after approval in Desktop or when the user turns plan mode off."
)
PLAN_INACTIVE = (
    "DeepSeek Harness plan mode: INACTIVE. This supersedes earlier plan-mode instructions. "
    "Proceed with the user's task under the current Desktop permissions."
)


def desktop_handoff(names):
    if any(name in TEXT_ARGUMENTS for name in names):
        return DESKTOP_TOOL_HANDOFF + "\n" + TEXT_ARGUMENT_GUIDANCE
    return DESKTOP_TOOL_HANDOFF


def bind_argument_text(frame, block):
    """Bind a reserved reference to one body recovered from the exact browser source."""
    arguments = frame["arguments"]
    field = TEXT_ARGUMENTS.get(frame["name"])
    value = arguments.get(field)
    references = []
    pending = [arguments]
    while pending:
        item = pending.pop()
        if isinstance(item, dict):
            if set(item) == {"$text"} or item is value and "$text" in item:
                references.append(item)
            pending.extend(item.values())
        elif isinstance(item, list):
            pending.extend(item)
    if not references and block is None:
        return
    if block is None or len(references) != 1 or references[0] is not value:
        raise InvalidToolSource("A text argument requires a confirmed original reply and an allowed tool field.")
    name = value["$text"]
    if set(value) != {"$text"} or not isinstance(name, str) or not re.fullmatch(TEXT_BLOCK_NAME, name):
        raise InvalidToolSource("Invalid text argument reference in the Arena tool call.")
    label, line_break, body = block.partition("\n")
    if label != name or not line_break or not body.strip():
        raise InvalidToolSource("Expected one nonempty top-level harness-text block matching the tool argument reference.")
    arguments[field] = body


def desktop_tools(tools, supports_read_batch):
    # This entry describes a bridge operation, never a native Harness tool.
    tools = [tool for tool in tools if tool["name"] != READ_BATCH]
    names = sorted(READ_BATCH_TOOLS.intersection(tool["name"] for tool in tools))
    if supports_read_batch is not True or not names:
        return tools
    return [*tools, {
        "name": READ_BATCH,
        "description": (
            "Send two or more independent text inspection calls together using this name in one tool_call "
            "with the current turn_id. Use each tool's native arguments. Use single requests when one "
            "call needs a previous result. Desktop returns all results in one message in call order "
            "with a distinct tool call ID, status and output for each call."
        ),
        "parameters": {"type":"object", "required":["calls"], "additionalProperties":False, "properties":{
            "calls":{"type":"array", "minItems":2, "items":{
                "type":"object", "required":["name", "arguments"], "additionalProperties":False,
                "properties":{"name":{"enum":names}, "arguments":{"type":"object"}},
            }},
        }},
    }]


def read_batch_reply(frame, names):
    arguments = frame["arguments"]
    calls = arguments.get("calls")
    if (set(arguments) != {"calls"} or not isinstance(calls, list) or len(calls) < 2
            or not all(isinstance(call, dict) and set(call) == {"name", "arguments"}
                       and isinstance(call["name"], str) and call["name"] in READ_BATCH_TOOLS
                       and call["name"] in names and isinstance(call["arguments"], dict) for call in calls)):
        raise InvalidToolSource("Arena sent an invalid read batch. No tool in the batch was run.")
    reply = {"kind":"tool-batch", "calls":calls}
    if "text" in frame:
        reply["text"] = frame["text"]
    return reply


def result_origin(data):
    """Validate the grouped result shape before consulting the original request."""
    if isinstance(data, dict) and set(data) == {"results"}:
        results = data["results"]
        if (not isinstance(results, list) or len(results) < 2
                or not all(isinstance(row, dict) and set(row) == {"toolCallId", "failed", "text"}
                           and isinstance(row["toolCallId"], str) and isinstance(row["failed"], bool)
                           and isinstance(row["text"], str) for row in results)):
            raise Problem("Expected one native result for each call in the Arena read batch")
        prefix, _, _ = results[0]["toolCallId"].rpartition("_")
        if not prefix.startswith("arena_") or not all(
                row["toolCallId"] == f"{prefix}_{index}" for index, row in enumerate(results)):
            raise Problem("Arena read batch contains mismatched native call IDs")
        return prefix[len("arena_"):], len(results)
    tool_id = data.get("toolCallId") if isinstance(data, dict) else None
    if not isinstance(tool_id, str) or not tool_id.startswith("arena_"):
        raise Problem("Native tool result is missing its original call ID")
    return tool_id[len("arena_"):], None


def readable_result(data, view):
    """Render a validated Desktop result for Arena, preserving the original data for routing."""
    if not isinstance(view, dict) or set(view) not in (set(), {"process"}, {"image"}):
        raise Problem("Invalid Desktop result presentation")
    rows = data["results"] if set(data) == {"results"} else [data]
    if len(rows) != 1 and view:
        raise Problem("Expected only text results in an Arena read batch")
    parts = []
    for row in rows:
        if not isinstance(row.get("text"), str) or not isinstance(row.get("failed"), bool):
            raise Problem("Invalid Desktop result text or status")
        status = "failed" if row["failed"] else "ok"
        lines = [f"Tool {row['toolCallId']} ({status})"]
        output = row["text"].replace("\r\n", "\n")
        if "process" in view:
            process = view["process"]
            if (not isinstance(process, dict) or set(process) != {"exitCode", "signal", "timedOut"}
                    or type(process["exitCode"]) not in (int, type(None))
                    or type(process["signal"]) not in (str, type(None))
                    or not isinstance(process["timedOut"], bool) or row["failed"]):
                raise Problem("Invalid PowerShell process status")
            code, signal = process["exitCode"], process["signal"]
            if signal:
                lines.append(f"Process signal: {signal}")
                output = output.removesuffix(f"\n[killed by signal: {signal}]")
            if code is not None:
                lines.append(f"Process exit code: {code}")
                if code != 0 and not signal:
                    output = output.removesuffix(f"\n[exit code: {code}]")
            if process["timedOut"]:
                lines.append("Process timed out")
        if "image" in view:
            output = view["image"]
            if not isinstance(output, str) or not 0 < len(output) <= 512 or row["failed"]:
                raise Problem("Invalid Desktop image caption")
        parts.append("\n".join([*lines, output]))
    # Browser editors normalize carriage returns, and SQLite requires Unicode scalars.
    # Retain lone control characters and split UTF-16 pairs as visible escapes.
    return "\n\n".join(parts).replace("\r", "\\r").encode("utf-8", "backslashreplace").decode("utf-8")


def request_fingerprint(request, omit=()):
    content = {key:value for key, value in request.items() if key not in omit}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def desktop_pngs(request):
    if "pngs" in request:
        items = request["pngs"]
        if "png" in request or not isinstance(items, list) or not 2 <= len(items) <= 20:
            raise Problem("Expected 2 to 20 PNGs in a batch, with no singleton PNG field")
    elif request.get("png") is not None:
        items = [request["png"]]
    else:
        return []
    decoded = []
    total = 0
    for item in items:
        if not isinstance(item, str) or not 0 < len(item) <= 4 * ((4 * 1024**2 + 2) // 3):
            raise Problem("Each Desktop PNG must fit within 4 MiB")
        raw = base64.b64decode(item, validate=True)
        if (len(raw) > 4 * 1024**2 or base64.b64encode(raw).decode("ascii") != item
                or not raw.startswith(b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
                or not raw.endswith(b"\x00\x00\x00\x00IEND\xaeB\x60\x82")):
            raise Problem("Invalid Desktop PNG")
        total += len(raw)
        if total > 32 * 1024**2:
            raise Problem("Desktop PNGs exceed the 32 MiB limit per turn")
        decoded.append(raw)
    return decoded


def site_card(value):
    if not isinstance(value, dict) or set(value) != {"id","question","options"}:
        raise Problem("Invalid Arena question card")
    for key, limit in (("id",256), ("question",16000)):
        if not isinstance(value[key], str) or not value[key].strip() or len(value[key]) > limit:
            raise Problem("Invalid Arena question identity or prompt")
    options = value["options"]
    if (not isinstance(options,list) or not 1 <= len(options) <= 64
            or not all(isinstance(label,str) and label.strip() and len(label) <= 2000 for label in options)
            or len(set(options)) != len(options)):
        raise Problem("Expected distinct labeled options on the native Arena question")
    return value


def selected_option(card, result):
    if result.get("failed") is not False or not isinstance(result.get("text"),str):
        raise Problem("The Desktop question failed or was cancelled. No Arena option was selected.")
    reply = json.loads(result["text"])
    answers = reply.get("answers") if isinstance(reply,dict) else None
    if not isinstance(answers,list) or len(answers) != 1 or not isinstance(answers[0],dict):
        raise Problem("Expected one answer to the original Arena question")
    item = answers[0]
    selected = item.get("selected")
    if (item.get("id") != card["id"] or item.get("custom") not in (None,"")
            or not isinstance(selected,list) or len(selected) != 1 or selected[0] not in card["options"]):
        raise Problem("A native Arena card requires one of its displayed options. No choice was sent.")
    return selected[0]


class DesktopJournal(Journal):
    supports_native_questions = True
    supports_image_choices = True
    supports_pairing_settlement = True

    def __init__(self, path, root):
        super().__init__(path, root)
        self.sql.executescript("""
          CREATE TABLE IF NOT EXISTS desktop_session(id TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, session TEXT, fingerprint TEXT,
            job TEXT UNIQUE, names TEXT, reply TEXT, error TEXT);
          CREATE TABLE IF NOT EXISTS request_context(id TEXT PRIMARY KEY, binding TEXT, browser_turn INTEGER,
            origin TEXT UNIQUE);
          CREATE TABLE IF NOT EXISTS site_questions(job TEXT PRIMARY KEY, binding TEXT NOT NULL, card_id TEXT NOT NULL,
            card TEXT NOT NULL, answer_job TEXT UNIQUE, answer TEXT, UNIQUE(binding,card_id));
          CREATE TABLE IF NOT EXISTS closed_site_questions(job TEXT PRIMARY KEY);
          CREATE TABLE IF NOT EXISTS desktop_cancelled_deliveries(
            job TEXT PRIMARY KEY, confirmed INTEGER NOT NULL, card TEXT);
          CREATE TABLE IF NOT EXISTS desktop_tool_retries(
            request TEXT PRIMARY KEY, rejected_job TEXT UNIQUE NOT NULL);
          CREATE TABLE IF NOT EXISTS desktop_transcript_faults(
            binding TEXT PRIMARY KEY, event TEXT NOT NULL);
          -- Even an older companion performing a retry must keep this answer out of its ordinary text queue.
          CREATE TRIGGER IF NOT EXISTS requeue_site_answer AFTER UPDATE OF state ON jobs
            WHEN NEW.state='queued' AND EXISTS(SELECT 1 FROM site_questions WHERE answer_job=NEW.id)
            BEGIN UPDATE jobs SET state='question_queued' WHERE id=NEW.id; END;
          UPDATE jobs SET state='question_queued' WHERE state='queued' AND id IN (SELECT answer_job FROM site_questions);
        """)

    def pair_owner(self, session):
        if not isinstance(session,str) or not 0 < len(session) <= 256:
            raise Problem("Open Connect Arena from a Desktop conversation")
        with self.lock, self.sql:
            previous = self.one("SELECT id FROM desktop_session")
            if previous and previous["id"] != session:
                raise Problem("Arena is paired with another Desktop conversation. Run /arena-reset here, then run /arena-pair.")
            self.sql.execute("INSERT OR IGNORE INTO desktop_session VALUES(?)",(session,))

    def bind(self,chat,tab,settled_delivery=None):
        if settled_delivery is not None and (not isinstance(settled_delivery, str)
                                             or not re.fullmatch(r"[a-f0-9]{32}", settled_delivery)):
            raise Problem("Invalid completed Arena delivery receipt")
        with self.lock, self.sql:
            if not self.one("SELECT id FROM desktop_session"):
                raise Problem("Open Connect Arena in the target Desktop conversation first")
            existing = self.one("SELECT id FROM binding")
            binding = super().bind(chat,tab)
            if existing is None:
                return binding
            if settled_delivery:
                # The old answer was inspected during explicit pairing. Retire the delivery,
                # preserving its prior outcome and never accepting the old reply as new work.
                self.sql.execute("""UPDATE jobs SET state='done' WHERE id=? AND state IN ('offered','waiting','uncertain')
                                  AND id IN (SELECT r.job FROM requests r JOIN request_context c ON c.id=r.id
                                    JOIN desktop_session s ON s.id=r.session
                                    WHERE c.binding=? AND r.reply IS NULL
                                    AND NOT EXISTS (SELECT 1 FROM site_questions q WHERE q.answer_job=r.job OR q.job=r.job)
                                    AND NOT EXISTS (SELECT 1 FROM calls WHERE job=r.job))""",
                                 (settled_delivery, existing["id"]))
            # A manually reconnected document baselines its visible history. A
            # turn while disconnected may have no journal event, even at the
            # same URL and Chrome tab ID. Invalidate work from that interval.
            binding = new_id()
            self.sql.execute("UPDATE binding SET id=?", (binding,))
            self.sql.execute("DELETE FROM desktop_cancelled_deliveries")
            self.sql.execute("DELETE FROM desktop_transcript_faults")
            self.sql.execute("UPDATE requests SET error='Browser reconnected. Inspect the prior turn in Arena.' WHERE reply IS NULL AND error IS NULL")
            self.sql.execute("UPDATE jobs SET state='done' WHERE state IN ('queued','question_queued','held')")
            self.sql.execute("UPDATE jobs SET state='uncertain' WHERE state IN ('offered','waiting')")
            return binding

    def start(self, request):
        rid, session = request.get("requestId"), request.get("sessionId")
        if not all(isinstance(value, str) and 0 < len(value) <= 256 for value in (rid,session)):
            raise Problem("Desktop request and session IDs are required")
        text = request.get("text", "")
        result = request.get("toolResult")
        if result is not None and not isinstance(result, str):
            raise Problem("Expected the native tool result as text")
        if not isinstance(text, str):
            raise Problem("Expected the Desktop message as text")
        plan_mode = request.get("planMode")
        if "planMode" in request and not isinstance(plan_mode, bool):
            raise Problem("Expected Desktop plan mode as a boolean")
        images = desktop_pngs(request)
        tools = request.get("tools", [])
        if not isinstance(tools, list) or not all(isinstance(t,dict) and isinstance(t.get("name"),str) for t in tools):
            raise Problem("Invalid active Desktop tool catalog")
        tools = desktop_tools(tools, request.get("supportsReadBatch"))
        handoff = desktop_handoff(tool["name"] for tool in tools)
        schema = json.dumps(tools, separators=(",",":"), sort_keys=True, ensure_ascii=False)
        skills = request.get("skills", [])
        if not isinstance(skills,list) or not all(isinstance(s,dict) and isinstance(s.get("name"),str)
                                                  and isinstance(s.get("description"),str) for s in skills):
            raise Problem("Invalid native skill catalogue")
        skill_list = [{"name":s["name"],"description":s["description"]} for s in skills]
        context = ("DeepSeek Harness Desktop is connected. For image generation, use Arena's own image tool "
                   "and include the image in your final answer. Arena's cloud helpers run in Arena. "
                   "Use Desktop tools for local project or computer operations, and ask_user_question for "
                   "questions to the Desktop user when available. Native tool catalog: " + schema
                   + "\nAvailable skills: " + json.dumps(skill_list,ensure_ascii=False))
        guidance = request.get("computerUseGuidance")
        if request.get("toolHelpViaCode") is True and any(t["name"] == "run_code" for t in tools):
            context += ("\nBefore using an unfamiliar Desktop tool, request its current Harness documentation. "
                        "Inside run_code use inspect(await tools.arena_tool_help({})) to list available names, "
                        "{name:'read'} for one tool, {guide:'tool:...'} for a listed shared instruction or "
                        "{sdk:true} for the program SDK. Use nextCursor as cursor for the next page.")
        if "computerUseGuidance" in request:
            if not isinstance(guidance, str):
                raise Problem("Expected Desktop Computer Use guidance as text")
            # Keep the catalog a single paragraph: the browser uses its blank line to locate the user prompt.
            if guidance:
                context += ("\nCurrent Desktop Computer Use instructions (replace earlier instructions for this tool): "
                            + json.dumps(guidance, ensure_ascii=False))
            else:
                context += ("\nComputer Use guidance is unavailable in this Desktop session. "
                            "Disregard earlier Computer Use instructions. If a task needs GUI control, "
                            "report that the instructions are unavailable and leave the desktop untouched.")
        # Capability negotiation affects the initial catalog only. Replaying a
        # previously admitted request must retain its original catalog and ID.
        presentation = request.get("toolResultView")
        fingerprint = request_fingerprint(request, ("supportsReadBatch", "toolResultView", "computerUseGuidance", "toolHelpViaCode"))
        with self.lock, self.sql:
            owner = self.one("SELECT id FROM desktop_session")
            if not owner or owner["id"] != session:
                raise Problem("Open Connect Arena in the selected Desktop conversation. Disconnect any previous owner first.")
            binding = self.one("SELECT id FROM binding")
            if not binding:
                raise Problem("Connect an Arena Agent Mode tab in the Desktop connection settings first")
            browser_turn = self.one("SELECT COALESCE(MAX(rowid),0) AS n FROM events WHERE kind='user'")["n"]
            old = self.one("SELECT * FROM requests WHERE id=?", (rid,))
            if old:
                # Older companions may have included a presentation or capability hint in the digest.
                if old["session"] != session or (old["fingerprint"] != fingerprint and not any(
                    old["fingerprint"] == request_fingerprint(request, (*omitted, "computerUseGuidance", "toolHelpViaCode"))
                    for omitted in ((), ("supportsReadBatch",), ("toolResultView",))
                )):
                    raise Problem("Desktop request ID reused with different content")
                route = self.one("SELECT binding FROM request_context WHERE id=?", (rid,))
                if not route or route["binding"] != binding["id"]:
                    raise Problem("The original browser binding has changed")
                return {"id":rid}
            origin = None
            prior_job = None
            selection = None
            if result is not None:
                tool_data = json.loads(result)
                origin, batch_count = result_origin(tool_data)
                prior = self.lookup(origin,session)
                reply = json.loads(prior["reply"]) if prior["reply"] else {}
                route = self.one("SELECT binding,browser_turn FROM request_context WHERE id=?", (origin,))
                if (not route or route["binding"] != binding["id"] or route["browser_turn"] != browser_turn
                        or prior["error"] or not reply):
                    raise Problem("The browser conversation changed before this tool result. Inspect the original result in Desktop.")
                if batch_count is not None:
                    if reply["kind"] != "tool-batch" or len(reply["calls"]) != batch_count or images or request.get("text"):
                        raise Problem("The native results do not match the original Arena read batch")
                elif reply["kind"] not in ("tool", "image-choice"):
                    raise Problem("The native result does not match the original Arena tool request")
                if presentation is not None:
                    if isinstance(presentation, dict) and (
                        ("process" in presentation and reply.get("name") != "pwsh") or
                        ("image" in presentation and (reply.get("name") != "read_image" or len(images) != 1))
                    ):
                        raise Problem("Desktop result presentation does not match the original tool")
                    rendered_result = readable_result(tool_data, presentation)
                else:
                    rendered_result = result
                text = TOOL_RESULT_HEADER + " " + handoff + "\n" + rendered_result + ("\n\n" + text if text else "")
                if self.one("SELECT id FROM request_context WHERE origin=?", (origin,)):
                    raise Problem("This native tool result already has a delivery")
                prior_job = prior["job"]
                site = self.one("SELECT card FROM site_questions WHERE job=?", (prior_job,))
                if site:
                    if self.one("SELECT job FROM closed_site_questions WHERE job=?", (prior_job,)):
                        raise Problem("The original Arena question card has closed. No choice was sent.")
                    if images or request.get("text"):
                        raise Problem("A native Arena answer must contain only the Desktop selection")
                    selection = selected_option(json.loads(site["card"]), tool_data)
            else:
                if not text and images:
                    text = "Review the attached image." if len(images) == 1 else "Review the attached images."
                if not text.strip():
                    raise Problem("Expected a message of at most 180000 characters")
                if tools:
                    text += "\n\n" + handoff
            meta = self.pending_catalog(context) if selection is None and (not prior_job or guidance is not None) else None
            if selection is None and plan_mode is not None:
                text += "\n\n" + (PLAN_ACTIVE if plan_mode else PLAN_INACTIVE)
            if len(text) + (len(meta["text"]) + 2 if meta else 0) > 180000:
                raise Problem("Message and native tool instructions exceed the bridge text limit")
            if self.paused():
                raise Problem(self.paused())
            if self.one("SELECT id FROM jobs WHERE state NOT IN ('done','superseded')"):
                raise Problem("A previous turn is still active. Inspect Arena and the connection status first.")
            self.use_catalog(context)
            job = self._insert_job(text,request.get("png"),prior_job,"question_queued" if selection is not None else "queued")
            if selection is not None:
                self.sql.execute("UPDATE site_questions SET answer_job=?,answer=? WHERE job=?", (job,selection,prior_job))
            if len(images) > 1:
                self.sql.executemany("INSERT INTO outgoing_pngs(job,position,bytes) VALUES(?,?,?)",
                                     ((job, index, raw) for index, raw in enumerate(images)))
            if meta:
                # A queued turn can outlive the companion that constructed its native catalog.
                self.sql.execute("INSERT INTO outgoing_context VALUES(?,?,?)", (job,meta["id"],meta["text"]))
            names = json.dumps([t["name"] for t in tools])
            self.sql.execute("INSERT INTO requests VALUES(?,?,?,?,?,NULL,NULL)", (rid,session,fingerprint,job,names))
            self.sql.execute("INSERT INTO request_context VALUES(?,?,?,?)",(rid,binding["id"],browser_turn,origin))
            return {"id":rid}

    def stop_changed_transcript(self, data):
        binding = data["binding"]
        # The event transaction owns the lock. Retire only work from this owner's
        # old history, including a continuation that has not been offered yet.
        self.sql.execute("""UPDATE jobs SET state='done' WHERE state NOT IN ('done','superseded','limited')
                            AND (id IN (SELECT r.job FROM requests r JOIN request_context c ON c.id=r.id
                                        JOIN desktop_session s ON s.id=r.session WHERE c.binding=?)
                                 OR id IN (SELECT job FROM browser_inputs))""", (binding,))
        self._stop_pending_requests(binding, data["text"])
        self.sql.execute("UPDATE request_context SET binding=NULL WHERE binding=?", (binding,))
        self.sql.execute("DELETE FROM desktop_cancelled_deliveries")
        self.sql.execute("INSERT OR REPLACE INTO desktop_transcript_faults VALUES(?,?)", (binding, data["id"]))
        return True

    def _stop_pending_requests(self, binding, reason):
        # A command already executed by Desktop can retain its evidence. A command
        # still awaiting pickup must no longer be delivered from the cached reply.
        self.sql.execute("""UPDATE requests SET error=? WHERE error IS NULL
                            AND id IN (SELECT c.id FROM request_context c WHERE c.binding=?)
                            AND (reply IS NULL OR (
                                 json_extract(reply,'$.kind') IN ('tool','tool-batch','image-choice')
                                 AND NOT EXISTS (SELECT 1 FROM request_context WHERE origin=requests.id)))""",
                         (reason, binding))

    def recover_transcript(self, address):
        with self.lock:
            self.check(address)
            if address.get("ready") is not False or address.get("nativeQuestionId") is not None:
                raise Problem("A transcript recovery check cannot claim a delivery")
            fault = self.one("SELECT event FROM desktop_transcript_faults WHERE binding=?", (address["binding"],))
            if not fault or fault["event"] != address.get("recoverTranscript") or self.paused():
                return False
            return bool(self.one("""SELECT 1 FROM jobs j JOIN requests r ON r.job=j.id
                                    JOIN request_context c ON c.id=r.id JOIN desktop_session s ON s.id=r.session
                                    WHERE c.binding=? AND c.origin IS NULL AND j.state='queued'
                                      AND r.reply IS NULL AND r.error IS NULL""", (address["binding"],)))

    def poll(self, address, ready):
        with self.lock:
            self.check(address)
            fault = self.one("SELECT event FROM desktop_transcript_faults WHERE binding=?", (address["binding"],))
            if fault and fault["event"] != address.get("recoveredTranscript"):
                return None
            return super().poll(address, ready)

    def event(self, data):
        with self.lock:
            if data.get("kind") in ("assistant", "user"):
                self.check(data)
                fault = self.one("SELECT event FROM desktop_transcript_faults WHERE binding=?", (data["binding"],))
                if fault and fault["event"] != data.get("recoveredTranscript"):
                    return
            return super().event(data)

    def native_question(self, data, replay):
        card = site_card(data["nativeQuestion"])
        previews = None
        if "choicePreviews" in data:
            previews = data["choicePreviews"]
            decode_generated_images(previews)
            expected = [f"Image {i}" for i in range(1, len(previews) + 1)]
            if card["options"] not in (expected, expected + ["Skip"]):
                raise Problem("Arena image choices and previews do not match")
        origin = data.get("replyTo")
        if not isinstance(origin,str) or not 0 < len(origin) <= 256:
            raise Problem("Missing Desktop job for the Arena question")
        existing = self.one("""SELECT q.job,q.card,r.reply FROM site_questions q JOIN requests r ON r.job=q.job
                               WHERE q.binding=? AND q.card_id=?""", (data["binding"],card["id"]))
        if existing:
            reply = json.loads(existing["reply"])
            if (existing["job"] != origin or json.loads(existing["card"]) != card
                    or reply.get("previews", reply.get("images")) != previews):
                raise Problem("The Arena question no longer matches its original turn")
            return "interactive" if reply["kind"] in ("tool", "image-choice") else "display-only"
        cancelled = self.confirmed_cancelled_delivery(data)
        if cancelled:
            if cancelled["card"] is not None:
                if json.loads(cancelled["card"]) != card:
                    raise Problem("The Arena question no longer matches its cancelled turn")
            elif replay:
                raise Problem("The replayed event does not match the original Arena question")
            else:
                self.sql.execute("UPDATE desktop_cancelled_deliveries SET card=? WHERE job=?",
                                 (json.dumps(card), origin))
            return "display-only"
        if replay:
            raise Problem("The replayed event does not match the original Arena question")
        request = self.one("""SELECT r.id,r.names FROM requests r JOIN request_context c ON c.id=r.id
                              JOIN desktop_session s ON s.id=r.session WHERE c.binding=? AND r.job=?
                              AND r.reply IS NULL AND r.error IS NULL AND r.job=(
                              SELECT id FROM jobs WHERE state='waiting' ORDER BY rowid DESC LIMIT 1)""", (data["binding"],origin))
        if not request:
            raise Problem("Arena question does not belong to the waiting Desktop request")
        self.sql.execute("INSERT INTO site_questions(job,binding,card_id,card) VALUES(?,?,?,?)",
                         (origin,data["binding"],card["id"],json.dumps(card)))
        if "ask_user_question" in json.loads(request["names"]):
            question = {"id":card["id"],"question":card["question"],"options":[{"label":label} for label in card["options"]]}
            reply = {"kind":"tool","name":"ask_user_question","arguments":{"questions":[question]}}
            if previews is not None:
                reply.update(kind="image-choice", previews=previews)
        else:
            text = card["question"] + "\n" + "\n".join(card["options"]) + "\nDesktop's active profile does not offer ask_user_question."
            reply = {"kind":"text","text":text}
            if previews is not None:
                reply["images"] = previews
        self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (origin,))
        self.sql.execute("UPDATE requests SET reply=? WHERE id=?", (json.dumps(reply),request["id"]))
        return "interactive" if reply["kind"] in ("tool", "image-choice") else "display-only"

    def close_site_question(self, address):
        with self.lock, self.sql:
            self.check(address)
            card_id = address.get("nativeQuestionId")
            if (address.get("supportsNativeQuestions") is not True or address.get("ready") is not False
                    or not isinstance(card_id,str) or not 0 < len(card_id) <= 256):
                raise Problem("Expected the original closed Arena question on a compatible poll")
            card = self.one("SELECT job,answer_job FROM site_questions WHERE binding=? AND card_id=?", (address["binding"],card_id))
            if not card:
                raise Problem("Unknown closed Arena question in this binding")
            answer_job = card["answer_job"]
            if answer_job:
                state = self.state(answer_job)
                if state in ("offered","waiting","uncertain","limited"):
                    raise Problem("An answer may already have reached Arena. Inspect the original question.")
                if state in ("question_queued","held"):
                    self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (answer_job,))
                    self.sql.execute("UPDATE requests SET error='The Arena question closed before the choice could be sent.' WHERE job=?",
                                     (answer_job,))
            self.sql.execute("INSERT OR IGNORE INTO closed_site_questions(job) VALUES(?)", (card["job"],))
            return card_id

    def native_answer(self, job):
        row = self.one("""SELECT q.card,q.answer FROM site_questions q JOIN binding b ON b.id=q.binding
                          JOIN requests r ON r.job=q.answer_job JOIN desktop_session s ON s.id=r.session
                          JOIN request_context c ON c.id=r.id WHERE q.answer_job=? AND r.error IS NULL
                          AND r.reply IS NULL AND c.browser_turn=(
                          SELECT COALESCE(MAX(rowid),0) FROM events WHERE kind='user')""", (job,))
        return {**json.loads(row["card"]), "answer":row["answer"]} if row else None

    def observe_delivery(self, kind, job):
        if kind == "user":
            self.sql.execute("""UPDATE jobs SET state='superseded' WHERE state NOT IN ('done','superseded')
                               AND id IN (SELECT r.job FROM requests r JOIN desktop_tool_retries retry ON retry.request=r.id
                                          JOIN request_context route ON route.id=r.id WHERE r.error IS NULL AND r.reply IS NULL
                                          AND route.browser_turn < (SELECT MAX(rowid) FROM events WHERE kind='user'))""")
        elif kind == "sent":
            self.sql.execute("UPDATE desktop_cancelled_deliveries SET confirmed=1 WHERE job=?", (job,))
        elif job:
            self.sql.execute("DELETE FROM desktop_cancelled_deliveries WHERE job=?", (job,))
        else:
            self.sql.execute("DELETE FROM desktop_cancelled_deliveries")

    def discard_delivery_update(self, job):
        return bool(self.one("""SELECT 1 FROM jobs j JOIN requests r ON r.job=j.id
                             JOIN desktop_tool_retries retry ON retry.request=r.id
                             WHERE j.id=? AND j.state='superseded'""", (job,)))

    def confirmed_cancelled_delivery(self, data):
        origin = data.get("replyTo")
        if not isinstance(origin, str) or not 0 < len(origin) <= 256:
            return None
        return self.one("""SELECT d.job,d.card FROM desktop_cancelled_deliveries d JOIN jobs j ON j.id=d.job
                          JOIN requests r ON r.job=j.id JOIN request_context c ON c.id=r.id
                          JOIN desktop_session s ON s.id=r.session WHERE d.job=? AND d.confirmed=1
                          AND j.state IN ('waiting','uncertain') AND r.error=? AND r.reply IS NULL
                          AND c.binding=? AND c.browser_turn=(
                          SELECT COALESCE(MAX(rowid),0) FROM events WHERE kind='user')""",
                        (origin, DESKTOP_CANCELLED, data["binding"]))

    def discard_cancelled_reply(self, data, active):
        cancelled = self.confirmed_cancelled_delivery(data)
        settled = cancelled is not None and cancelled["card"] is None
        if settled:
            job = cancelled["job"]
        else:
            if (not active or (("replyTo" in data or "images" in data) and data.get("replyTo") != active["origin"])
                    or not self.one("SELECT 1 FROM requests WHERE job=? AND error IS NOT NULL", (active["id"],))):
                return False
            job = active["id"]
        if "images" in data:
            decode_generated_images(data["images"])
        if settled:
            self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (job,))
            self.sql.execute("DELETE FROM desktop_cancelled_deliveries WHERE job=?", (job,))
        self.sql.execute("UPDATE events SET kind='discarded',text=? WHERE id=?",
                         (f"Ignored a reply to cancelled Desktop delivery {job}", data["id"]))
        return True

    def answer(self, job, text, delivery, tool_source=None):
        request = self.one("""SELECT id,names,error,EXISTS(SELECT 1 FROM site_questions q WHERE q.answer_job=r.job) AS site_choice
                              FROM requests r WHERE job=?""", (job,))
        if request and request["error"]:
            return
        if not request:
            self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (job,))
            return
        reply = {"kind":"text","text":text}
        # Clicking a site's answer option never sends the job's delivery marker to the model.
        names = json.loads(request["names"])
        block = None
        if tool_source is not None:
            if request["site_choice"]:
                raise InvalidToolSource("An Arena selection cannot authorize a local tool command.")
            command = tool_source
            if tool_source.startswith("\x1e"):
                command, separator, block = tool_source[1:].partition("\x1e")
                if not separator:
                    raise InvalidToolSource("Invalid browser transport for a text argument.")
            frame = source_tool_frame(command, delivery, names)
            if text.strip():
                frame["text"] = text
        else:
            frame = None if request["site_choice"] else tool_frame(text, delivery, names)
        if frame:
            bind_argument_text(frame, block)
            reply = read_batch_reply(frame, names) if frame["name"] == READ_BATCH else {"kind":"tool", **frame}
        self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (job,))
        self.sql.execute("UPDATE requests SET reply=? WHERE id=?", (json.dumps(reply),request["id"]))

    def retry_tool_reply(self, job, diagnostic):
        # The event transaction already owns the lock. Keep the rejection and new delivery atomic.
        request = self.one("""SELECT r.id,r.names,j.parent FROM requests r JOIN jobs j ON j.id=r.job
                              JOIN request_context c ON c.id=r.id JOIN binding b ON b.id=c.binding
                              JOIN desktop_session s ON s.id=r.session
                              WHERE j.id=? AND j.state='waiting' AND r.reply IS NULL AND r.error IS NULL
                                AND c.browser_turn=(SELECT COALESCE(MAX(rowid),0) FROM events WHERE kind='user')
                                AND NOT EXISTS (SELECT 1 FROM calls WHERE job=j.id)
                                AND NOT EXISTS (SELECT 1 FROM site_questions WHERE answer_job=j.id OR job=j.id)""", (job,))
        if not request or not self.sql.execute("INSERT OR IGNORE INTO desktop_tool_retries VALUES(?,?)",
                                               (request["id"], job)).rowcount:
            return False
        prompt = (diagnostic + " Reissue the single intended tool call as valid JSON. "
                  "Use the fresh ID on the final Bridge delivery line. Keep the current task and plan mode. "
                  "Return one command and wait for its result.\n\n" + desktop_handoff(json.loads(request["names"])))
        retry = self._insert_job(prompt, None, request["parent"], "queued")
        self.sql.execute("UPDATE jobs SET state='done' WHERE id=?", (job,))
        self.sql.execute("UPDATE requests SET job=? WHERE id=?", (retry, request["id"]))
        return True

    def reject_tool_reply(self, job, diagnostic):
        super().reject_tool_reply(job, diagnostic)
        self.sql.execute("UPDATE requests SET error=? WHERE job=?", (diagnostic, job))

    def lookup(self, rid, session):
        row = self.one("SELECT * FROM requests WHERE id=? AND session=?", (rid,session))
        if not row:
            raise Problem("Unknown request for this Desktop conversation")
        return row

    def status(self, rid, session):
        with self.lock:
            r = self.lookup(rid, session)
            if r["error"]:
                return {"state":"failed","error":r["error"]}
            if r["reply"]:
                reply = json.loads(r["reply"])
                if reply["kind"] == "tool-batch" and not self.one("""
                    SELECT 1 FROM request_context c JOIN binding b ON b.id=c.binding
                    JOIN desktop_session s ON s.id=? WHERE c.id=?
                    AND c.browser_turn=(SELECT COALESCE(MAX(rowid),0) FROM events WHERE kind='user')
                    AND NOT EXISTS (SELECT 1 FROM request_context WHERE origin=c.id)
                    """, (session, rid)):
                    return {"state":"failed", "error":"Arena read batch is no longer pending in its original browser turn"}
                if reply["kind"] == "text":
                    images = self.generated_images(r["job"])
                    if images:
                        reply["images"] = images
                return {"state":"done","reply":reply}
            state = self.state(r["job"])
            if state in ("superseded","held"):
                return {"state":"failed","error":"A different browser turn replaced the Desktop request; inspect the native result in Desktop"}
            paused = self.paused()
            if paused and state in ("queued","question_queued"):
                return {"state":"limited","error":paused}
            if state in ("limited","uncertain"):
                issue = self.one("SELECT reason FROM delivery_issues WHERE job=?", (r["job"],))
                reason = paused or (issue["reason"] if issue else None)
                return {"state":state,"error":reason or "Inspect the Arena chat before resuming this delivery"}
            return {"state":"queued" if state in ("queued","question_queued") else "waiting"}

    def cancel(self, rid, session):
        with self.lock, self.sql:
            r = self.lookup(rid, session)
            if (r["reply"] and not r["error"] and json.loads(r["reply"])["kind"] == "tool-batch"
                    and not self.one("SELECT 1 FROM request_context WHERE origin=?", (rid,))):
                self.sql.execute("UPDATE requests SET error=? WHERE id=?", (DESKTOP_CANCELLED, rid))
            if not r["reply"] and not r["error"]:
                state = self.state(r["job"])
                # An exact, later reply may settle a confirmed ordinary send.
                # A selection on an Arena question has no outbound turn stamp.
                target = "done" if state in ("queued","question_queued") else "uncertain"
                self.sql.execute("UPDATE jobs SET state=? WHERE id=?", (target,r["job"]))
                self.sql.execute("UPDATE requests SET error=? WHERE id=?", (DESKTOP_CANCELLED, rid))
                if state in ("offered","waiting") and not self.one(
                    "SELECT 1 FROM site_questions WHERE answer_job=?", (r["job"],)
                ):
                    self.sql.execute("INSERT INTO desktop_cancelled_deliveries VALUES(?,?,NULL)",
                                     (r["job"], state == "waiting"))
            return {"ok":True}

    def disconnect(self, session, *, reset=False):
        if reset and (not isinstance(session,str) or not 0 < len(session) <= 256):
            raise Problem("Run /arena-reset from a Desktop conversation")
        with self.lock, self.sql:
            owner = self.one("SELECT id FROM desktop_session")
            if owner and owner["id"] != session and not reset:
                raise Problem("Only the original Desktop conversation can disconnect its bridge")
            reason = "Operator reset the Arena connection" if reset else "Operator disconnected the original Arena conversation"
            if reset and (binding := self.one("SELECT id FROM binding")):
                self._stop_pending_requests(binding["id"], reason)
            self.sql.execute("UPDATE requests SET error=? WHERE reply IS NULL AND error IS NULL", (reason,))
            self.sql.execute("UPDATE jobs SET state='done' WHERE state NOT IN ('done','superseded')")
            self.sql.execute("DELETE FROM desktop_session")
            self.sql.execute("DELETE FROM binding")
            self.sql.execute("DELETE FROM desktop_cancelled_deliveries")
            self.sql.execute("DELETE FROM desktop_transcript_faults")
            self.sql.execute("DELETE FROM released")
            self.sql.execute("DELETE FROM pause")
            self.sql.execute("DELETE FROM catalog")
            self.catalog = None
            return {"ok":True}

    def skill(self, name):
        raise Problem("Select this skill using the native DeepSeek Harness Desktop interface")


def serve():
    state = os.environ.get("ARENA_DESKTOP_STATE")
    home = Path(os.environ.get("DSH_HOME") or Path.home()/".dsh")
    private = Path(state) if state else home / "arena-bridge"
    private.mkdir(mode=0o700, parents=True, exist_ok=True)
    with Endpoint(("127.0.0.1",8766),ExtensionHandler) as server:
        pair = read_pairing(private)
        db = DesktopJournal(private/"desktop.sqlite", private)
        server.journal, server.adapter = db, db
        server.auth = ("Bearer "+pair).encode("ascii")
        listener = threading.Thread(target=server.serve_forever,daemon=True)
        listener.start()
        try:
            for line in sys.stdin.buffer:
                rid = None
                try:
                    packet = json.loads(line)
                    rid = packet["id"]
                    method = packet["method"]
                    params = packet.get("params", {})
                    if method == "setup":
                        if "sessionId" in params:
                            db.pair_owner(params["sessionId"])
                        with db.lock:
                            bound = db.one("SELECT chat FROM binding")
                        result = {"chat":bound["chat"] if bound else None, "port":8766, "supportsPngBatch":True,
                                  "supportsResultView":True, "supportsComputerUseGuidance":True, "supportsToolHelp":True,
                                  "mode":"desktop", "pause":db.paused(), "deliveries":db.issues()}
                        if "sessionId" in params:
                            result["pairToken"] = pair
                    elif method == "start":
                        result = db.start(params)
                    elif method == "status":
                        result = db.status(params["id"],params["sessionId"])
                    elif method == "cancel":
                        result = db.cancel(params["id"],params["sessionId"])
                    elif method == "disconnect":
                        result = db.disconnect(params["sessionId"])
                    elif method == "reset":
                        result = db.disconnect(params["sessionId"], reset=True)
                    else:
                        raise Problem("Unknown Desktop method")
                    reply = {"jsonrpc":"2.0","id":rid,"result":result}
                except (ValueError, KeyError, TypeError, RecursionError) as error:
                    reply = {"jsonrpc":"2.0","id":rid,"error":{"code":-32602,"message":str(error)}}
                sys.stdout.buffer.write(json.dumps(reply,ensure_ascii=True).encode("ascii")+b"\n")
                sys.stdout.buffer.flush()
        finally:
            server.shutdown()
            listener.join()
            db.close()


if __name__ == "__main__":
    serve()
