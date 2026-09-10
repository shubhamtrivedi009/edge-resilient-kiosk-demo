from __future__ import annotations

import json
import queue
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

ROOT = Path(__file__).resolve().parents[1]
KIOSK_DIR = ROOT / "kiosk"
OPERATOR_DIR = ROOT / "operator"
DB_PATH = Path(__file__).resolve().parent / "kiosk_demo.db"

app = Flask(__name__)

_subscribers: set[queue.Queue[dict[str, Any]]] = set()
_subscribers_lock = threading.Lock()


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def get_db() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH, timeout=5)
    connection.row_factory = sqlite3.Row
    return connection


def init_db() -> None:
    with get_db() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS feedback (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                client_id TEXT NOT NULL UNIQUE,
                visitor_name TEXT NOT NULL DEFAULT '',
                rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
                comment TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            )
            """
        )
        db.commit()


def serialize_row(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "client_id": row["client_id"],
        "visitor_name": row["visitor_name"],
        "rating": row["rating"],
        "comment": row["comment"],
        "created_at": row["created_at"],
    }


def broadcast_feedback(item: dict[str, Any]) -> None:
    stale: list[queue.Queue[dict[str, Any]]] = []

    with _subscribers_lock:
        subscribers = list(_subscribers)

    for subscriber in subscribers:
        try:
            subscriber.put_nowait(item)
        except queue.Full:
            stale.append(subscriber)

    if stale:
        with _subscribers_lock:
            for subscriber in stale:
                _subscribers.discard(subscriber)


@app.get("/")
def kiosk_index():
    return send_from_directory(KIOSK_DIR, "index.html")


@app.get("/kiosk/<path:filename>")
def kiosk_assets(filename: str):
    return send_from_directory(KIOSK_DIR, filename)


@app.get("/operator")
@app.get("/operator/")
def operator_index():
    return send_from_directory(OPERATOR_DIR, "index.html")


@app.get("/operator/<path:filename>")
def operator_assets(filename: str):
    return send_from_directory(OPERATOR_DIR, filename)


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "time": utc_now()})


@app.get("/api/feedback")
def list_feedback():
    with get_db() as db:
        rows = db.execute(
            """
            SELECT id, client_id, visitor_name, rating, comment, created_at
            FROM feedback
            ORDER BY id DESC
            LIMIT 100
            """
        ).fetchall()

    return jsonify([serialize_row(row) for row in rows])


@app.post("/api/feedback")
def create_feedback():
    payload = request.get_json(silent=True) or {}

    client_id = str(payload.get("client_id", "")).strip()
    visitor_name = str(payload.get("visitor_name", "")).strip()[:80]
    comment = str(payload.get("comment", "")).strip()[:500]

    try:
        rating = int(payload.get("rating"))
    except (TypeError, ValueError):
        return jsonify({"error": "rating must be an integer from 1 to 5"}), 400

    if not client_id or len(client_id) > 100:
        return jsonify({"error": "client_id is required"}), 400

    if rating < 1 or rating > 5:
        return jsonify({"error": "rating must be between 1 and 5"}), 400

    created_at = utc_now()

    with get_db() as db:
        try:
            cursor = db.execute(
                """
                INSERT INTO feedback (client_id, visitor_name, rating, comment, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (client_id, visitor_name, rating, comment, created_at),
            )
            db.commit()
            row = db.execute(
                """
                SELECT id, client_id, visitor_name, rating, comment, created_at
                FROM feedback
                WHERE id = ?
                """,
                (cursor.lastrowid,),
            ).fetchone()
            item = serialize_row(row)
            created = True
        except sqlite3.IntegrityError:
            row = db.execute(
                """
                SELECT id, client_id, visitor_name, rating, comment, created_at
                FROM feedback
                WHERE client_id = ?
                """,
                (client_id,),
            ).fetchone()
            item = serialize_row(row)
            created = False

    if created:
        broadcast_feedback(item)

    return jsonify({"created": created, "feedback": item}), 201 if created else 200


@app.get("/api/events")
def events():
    subscriber: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=50)

    with _subscribers_lock:
        _subscribers.add(subscriber)

    @stream_with_context
    def generate():
        try:
            yield "retry: 3000\n\n"
            while True:
                try:
                    item = subscriber.get(timeout=15)
                    data = json.dumps(item, separators=(",", ":"))
                    yield f"event: feedback\ndata: {data}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            with _subscribers_lock:
                _subscribers.discard(subscriber)

    response = Response(generate(), mimetype="text/event-stream")
    response.headers["Cache-Control"] = "no-cache"
    response.headers["X-Accel-Buffering"] = "no"
    return response


@app.after_request
def add_demo_headers(response: Response):
    if request.path.startswith(("/kiosk/", "/operator/")) or request.path in {"/", "/operator"}:
        response.headers["Cache-Control"] = "no-store"
    return response


if __name__ == "__main__":
    init_db()
    app.run(host="127.0.0.1", port=5000, debug=True, threaded=True)
else:
    init_db()
