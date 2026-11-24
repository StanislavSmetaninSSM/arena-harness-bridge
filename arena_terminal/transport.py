"""Loopback-only extension interface. Operator approval has no HTTP endpoint."""
import hmac
import json
import os
import re
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .journal import Problem


class Endpoint(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second process bind a port that is already
    # being served: it starts without an error and never receives a request.
    allow_reuse_address = os.name != "nt"


class ExtensionHandler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(7)

    def log_message(self, format, *args):
        pass

    def reply(self, status, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.headers.get("Host") != f"127.0.0.1:{self.server.server_port}":
            return self.reply(403, {"error": "Loopback host required"})
        origin = self.headers.get("Origin")
        if origin is not None and not re.fullmatch("chrome-extension://[a-p]{32}", origin):
            return self.reply(403, {"error": "Extension origin required"})
        provided = self.headers.get("Authorization", "").encode("utf-8")
        if not hmac.compare_digest(provided, self.server.auth):
            return self.reply(401, {"error": "Check pairing token"})
        if self.headers.get_content_type() != "application/json":
            return self.reply(415, {"error": "JSON expected"})
        try:
            size = int(self.headers.get("Content-Length", "-1"))
            # Bound image events before parsing base64 plus the optional Unicode caption.
            maximum = 13 * 1024**2 if self.path == "/v1/event" else 1_400_000
            if not 1 <= size <= maximum:
                return self.reply(413, {"error": "Invalid request size"})
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise Problem("Expected an object")
            db = self.server.journal
            if self.path == "/v1/bind":
                settlement = ({"settled_delivery":body.get("settledDelivery")}
                              if getattr(db, "supports_pairing_settlement", False) else {})
                result = {"binding":db.bind(body.get("chat"), body.get("tab"), **settlement),
                          "lease":db.lease(), "context":db.context()}
            elif self.path == "/v1/poll" and "recoverTranscript" in body:
                recover = getattr(db, "recover_transcript", None)
                result = {"recoverTranscript":bool(recover and recover(body)), "job":None}
            elif self.path == "/v1/poll":
                closed = body.get("nativeQuestionClosed", False)
                if type(closed) is not bool:
                    raise Problem("Invalid native question closure")
                closure = db.close_site_question(body) if closed else None
                job = None if closed else db.poll(body, body.get("ready"))
                result = {"job":job, "queued":job is None and not body.get("nativeQuestionId") and db.eligible(body.get("supportsPngBatch")),
                          "lease":db.lease(),"context":db.context(),"supportsNativeQuestions":db.supports_native_questions,
                          "supportsImageChoices":getattr(db, "supports_image_choices", False)}
                if closure is not None:
                    result["nativeQuestionClosed"] = closure
            elif self.path == "/v1/file-chunk" and db.supports_files:
                result = db.file_chunk(body)
            elif self.path == "/v1/event":
                result = {"ok":True, **(db.event(body) or {})}
            elif self.path == "/v1/skill":
                db.check(body)
                name = body.get("name")
                if not isinstance(name, str) or not 0 < len(name) <= 150:
                    raise Problem("Expected a skill name")
                result = {"content":self.server.adapter.skill(name)}
            else:
                return self.reply(404, {"error":"Unknown endpoint"})
        except (ValueError, TypeError, KeyError, RecursionError) as error:
            return self.reply(400, {"error":str(error)})
        except sqlite3.Error as error:
            return self.reply(503, {"error":f"Local journal: {error}"})
        except OSError:
            return self.reply(503, {"error":"Local adapter unavailable"})
        self.reply(200, result)
