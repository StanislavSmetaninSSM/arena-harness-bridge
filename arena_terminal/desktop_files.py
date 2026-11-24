"""Original Desktop attachments staged privately and read by their offered browser job."""
import base64
import hashlib
import re
import time

from .journal import Problem


CHUNK_BYTES = 256 * 1024
DIGEST = re.compile(r"[0-9a-f]{64}")


def valid_size(value):
    # JSON integers crossing the JavaScript boundary must be exact.
    return type(value) is int and 0 <= value <= 2**53 - 1


class DesktopFileStore:
    """All calls run under the journal lock; linking a job uses the caller's transaction."""

    def __init__(self, connection):
        self.sql = connection
        self.next_sweep = 0
        self.sql.executescript("""
          CREATE TABLE IF NOT EXISTS desktop_uploads(
            id INTEGER PRIMARY KEY, binding TEXT NOT NULL, session TEXT NOT NULL, request TEXT NOT NULL,
            digest TEXT NOT NULL, size INTEGER NOT NULL, received INTEGER NOT NULL DEFAULT 0,
            verified INTEGER NOT NULL DEFAULT 0, touched INTEGER NOT NULL, UNIQUE(session,request,digest));
          CREATE TABLE IF NOT EXISTS desktop_upload_chunks(
            upload INTEGER NOT NULL, offset INTEGER NOT NULL, digest BLOB NOT NULL, data BLOB, PRIMARY KEY(upload,offset));
          CREATE TABLE IF NOT EXISTS desktop_job_files(
            job TEXT NOT NULL, position INTEGER NOT NULL, upload INTEGER NOT NULL,
            name TEXT NOT NULL, media_type TEXT NOT NULL, PRIMARY KEY(job,position));
          CREATE INDEX IF NOT EXISTS desktop_job_file_upload ON desktop_job_files(upload);
          CREATE TRIGGER IF NOT EXISTS purge_orphan_upload_chunks AFTER DELETE ON desktop_uploads
            BEGIN DELETE FROM desktop_upload_chunks WHERE upload=OLD.id; END;
          CREATE TRIGGER IF NOT EXISTS retire_desktop_file_job AFTER UPDATE OF state ON jobs
            WHEN NEW.state IN ('done','superseded')
            BEGIN UPDATE desktop_upload_chunks SET data=NULL WHERE data IS NOT NULL
              AND upload IN (SELECT upload FROM desktop_job_files WHERE job=NEW.id); END;
          CREATE TRIGGER IF NOT EXISTS retire_failed_desktop_files AFTER UPDATE OF error ON requests
            WHEN NEW.error IS NOT NULL
            BEGIN UPDATE desktop_upload_chunks SET data=NULL WHERE data IS NOT NULL
              AND upload IN (SELECT upload FROM desktop_job_files WHERE job=NEW.job); END;
          CREATE TRIGGER IF NOT EXISTS requeue_desktop_files AFTER UPDATE OF state ON jobs
            WHEN NEW.state='queued' AND EXISTS(SELECT 1 FROM desktop_job_files WHERE job=NEW.id)
            BEGIN UPDATE jobs SET state='files_queued' WHERE id=NEW.id; END;
        """)
        self.sweep_abandoned()

    def sweep_abandoned(self):
        if time.monotonic() < self.next_sweep:
            return
        with self.sql:
            # A paused transfer can finish after a restart. Expire only an entire
            # uncommitted request that has received no chunks for over a day.
            self.sql.execute("""DELETE FROM desktop_uploads WHERE
                NOT EXISTS (SELECT 1 FROM desktop_job_files WHERE upload=desktop_uploads.id)
                AND NOT EXISTS (SELECT 1 FROM desktop_uploads recent
                    WHERE recent.session=desktop_uploads.session AND recent.request=desktop_uploads.request
                    AND recent.touched>=?)""", (int(time.time()) - 86400,))
        self.next_sweep = time.monotonic() + 600

    def discard_uncommitted(self, session=None, request=None):
        query = """DELETE FROM desktop_uploads WHERE
            NOT EXISTS (SELECT 1 FROM desktop_job_files WHERE upload=desktop_uploads.id)"""
        if session is None:
            return self.sql.execute(query).rowcount
        return self.sql.execute(query + " AND session=? AND request=?", (session, request)).rowcount

    def stage(self, chunk, binding):
        size, offset, digest, data = (chunk.get(key) for key in ("size", "offset", "sha256", "data"))
        if not valid_size(size) or not valid_size(offset) or offset > size:
            raise Problem("Invalid Desktop file size or chunk offset")
        if not isinstance(digest, str) or not DIGEST.fullmatch(digest):
            raise Problem("Invalid Desktop file SHA-256")
        if not isinstance(data, str) or len(data) > 4 * ((CHUNK_BYTES + 2) // 3):
            raise Problem("Invalid Desktop file chunk")
        try:
            raw = base64.b64decode(data, validate=True)
        except ValueError as error:
            raise Problem("Invalid Desktop file chunk encoding") from error
        end = offset + len(raw)
        if len(raw) > CHUNK_BYTES or end > size or (size and not raw):
            raise Problem("Desktop file chunk does not fit the declared file")
        key = (chunk["sessionId"], chunk["requestId"], digest)
        piece_hash = hashlib.sha256(raw).digest()
        now = int(time.time())
        checksum_failed = False
        with self.sql:
            upload = self.sql.execute("""SELECT * FROM desktop_uploads
                WHERE session=? AND request=? AND digest=?""", key).fetchone()
            if upload is None:
                if offset or self.sql.execute("SELECT 1 FROM requests WHERE id=?", (key[1],)).fetchone():
                    raise Problem("Cannot append a new Desktop file at this offset or to a committed request")
                cursor = self.sql.execute("""INSERT INTO desktop_uploads(session,request,digest,binding,size,touched)
                    VALUES(?,?,?,?,?,?)""", (*key, binding, size, now))
                upload_id = cursor.lastrowid
            else:
                upload_id = upload["id"]
                if upload["binding"] != binding or upload["size"] != size:
                    raise Problem("Desktop file staging has changed binding or size")
                if upload["verified"] or offset < upload["received"]:
                    prior = self.sql.execute("""SELECT digest FROM desktop_upload_chunks
                        WHERE upload=? AND offset=?""", (upload_id, offset)).fetchone()
                    if prior is None or prior["digest"] != piece_hash:
                        raise Problem("Retried Desktop file chunk differs from the staged bytes")
                    self.sql.execute("UPDATE desktop_uploads SET touched=? WHERE id=?", (now, upload_id))
                    return {"nextOffset":end}
                if offset != upload["received"]:
                    raise Problem("Desktop file chunks must be staged in order")
            self.sql.execute("INSERT INTO desktop_upload_chunks VALUES(?,?,?,?)", (upload_id, offset, piece_hash, raw))
            if end == size:
                checksum = hashlib.sha256()
                for piece in self.sql.execute("SELECT data FROM desktop_upload_chunks WHERE upload=? ORDER BY offset",
                                              (upload_id,)):
                    checksum.update(piece["data"])
                checksum_failed = checksum.hexdigest() != digest
            if checksum_failed:
                # Permit a complete restage after a corrupt source without retaining its bad prefix.
                self.sql.execute("DELETE FROM desktop_uploads WHERE id=?", (upload_id,))
            else:
                self.sql.execute("UPDATE desktop_uploads SET received=?, verified=?, touched=? WHERE id=?",
                                 (end, end == size, now, upload_id))
        if checksum_failed:
            raise Problem("Desktop file SHA-256 does not match its original bytes")
        return {"nextOffset":end}

    def attach(self, job, items, session, request, binding):
        if not isinstance(items, list) or not items:
            raise Problem("Expected original Desktop file attachments")
        for position, item in enumerate(items):
            if not isinstance(item, dict) or set(item) != {"name", "mediaType", "sha256", "size"}:
                raise Problem("Invalid original Desktop file metadata")
            name, mime, digest, size = (item[key] for key in ("name", "mediaType", "sha256", "size"))
            if (not isinstance(name, str) or name in ("", ".", "..") or any(c in name for c in "/\\\x00")
                    or not isinstance(mime, str) or not isinstance(digest, str) or not DIGEST.fullmatch(digest)
                    or not valid_size(size)):
                raise Problem("Invalid original Desktop file name or metadata")
            upload = self.sql.execute("""SELECT id FROM desktop_uploads WHERE binding=? AND session=?
                AND request=? AND digest=? AND size=? AND verified=1""", (binding, session, request, digest, size)).fetchone()
            if upload is None:
                raise Problem("Missing a verified original file for this Desktop request and browser binding")
            self.sql.execute("INSERT INTO desktop_job_files VALUES(?,?,?,?,?)",
                             (job, position, upload["id"], name, mime))

    def manifest(self, job):
        return [dict(row) for row in self.sql.execute("""SELECT f.name,f.media_type AS mediaType,u.size,u.digest AS sha256
            FROM desktop_job_files f JOIN desktop_uploads u ON u.id=f.upload WHERE job=? ORDER BY position""", (job,))]

    def read(self, address):
        job, position, offset = (address.get(key) for key in ("job", "index", "offset"))
        if not isinstance(job, str) or not valid_size(position) or not valid_size(offset):
            raise Problem("Invalid Desktop file chunk identity")
        upload = self.sql.execute("""SELECT u.id,u.size FROM desktop_job_files f
            JOIN desktop_uploads u ON u.id=f.upload JOIN jobs j ON j.id=f.job
            JOIN requests r ON r.job=f.job JOIN desktop_session s ON s.id=r.session
            JOIN request_context c ON c.id=r.id AND c.binding=u.binding
            WHERE f.job=? AND f.position=? AND u.binding=? AND j.state='offered'
              AND r.error IS NULL AND r.reply IS NULL""", (job, position, address["binding"])).fetchone()
        if upload is None or offset > upload["size"]:
            raise Problem("File is not available at this offset in the offered Arena delivery")
        if offset == upload["size"]:
            return {"data":"", "nextOffset":offset}
        chunk = self.sql.execute("""SELECT offset,data FROM desktop_upload_chunks WHERE upload=? AND offset<=?
            ORDER BY offset DESC LIMIT 1""", (upload["id"], offset)).fetchone()
        raw = chunk["data"][offset - chunk["offset"]:]
        return {"data":base64.b64encode(raw).decode("ascii"), "nextOffset":offset + len(raw)}
