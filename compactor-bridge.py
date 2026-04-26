#!/usr/bin/env python3
"""
Bridge script for claw-compactor integration with QwenCoder.
Called from Node.js via execFile, reads JSON from stdin, writes JSON to stdout.
"""
import sys
import json

_engine_cache = None

def get_engine():
    """Try to import FusionEngine from claw-compactor. Caches the singleton instance."""
    global _engine_cache
    if _engine_cache is not None:
        return _engine_cache
    try:
        from claw_compactor import FusionEngine
        _engine_cache = FusionEngine(rewind=True)
        return _engine_cache
    except ImportError:
        pass
    try:
        from scripts.lib.fusion.engine import FusionEngine
        _engine_cache = FusionEngine(rewind=True)
        return _engine_cache
    except ImportError:
        pass
    return None


def cmd_status():
    engine = get_engine()
    if engine:
        rewind_enabled = getattr(engine, 'rewind_enabled', hasattr(engine, 'rewind'))
        print(json.dumps({
            "installed": True,
            "version": getattr(engine, 'version', '7.0+'),
            "rewind_enabled": bool(rewind_enabled),
        }))
    else:
        print(json.dumps({"installed": False, "error": "claw-compactor not found. Install with: pip install claw-compactor"}))


def cmd_compress_messages():
    data = json.loads(sys.stdin.read())
    messages = data.get("messages", [])
    options = data.get("options", {})

    engine = get_engine()
    if not engine:
        print(json.dumps({"messages": messages, "stats": {"compressed": False, "error": "not installed"}}))
        return

    try:
        # Forward per-message contentType hints
        hints = []
        for msg in messages:
            hint = msg.get("contentType")
            hints.append(hint if hint else "auto")

        # Build kwargs for compress_messages
        kwargs = {}
        if options.get("dedup"):
            kwargs["dedup"] = True
        if options.get("keepRecent") is not None:
            kwargs["keep_recent"] = options["keepRecent"]

        result = engine.compress_messages(messages, content_type_hints=hints, **kwargs)
        compressed_msgs = result.get("messages", messages)
        stats = result.get("stats", {})
        stats["compressed"] = True

        # Include per-message stats
        per_message = []
        raw_per_message = stats.get("per_message", [])
        for i, msg in enumerate(compressed_msgs):
            if i < len(raw_per_message):
                pm = raw_per_message[i]
            else:
                pm = {}
            per_message.append({
                "original_tokens": pm.get("original_tokens", 0),
                "compressed_tokens": pm.get("compressed_tokens", 0),
                "reduction_pct": pm.get("reduction_pct", 0),
                "stages_applied": pm.get("stages_applied", []),
            })
        stats["per_message"] = per_message

        print(json.dumps({"messages": compressed_msgs, "stats": stats}))
    except Exception as e:
        # Error fallback: return original messages with error field
        print(json.dumps({
            "messages": messages,
            "stats": {"compressed": False, "error": str(e)}
        }))


def cmd_compress_text():
    data = json.loads(sys.stdin.read())
    text = data.get("text", "")
    content_type = data.get("content_type", "auto")

    engine = get_engine()
    if not engine:
        print(json.dumps({"compressed": text, "stats": {"compressed": False, "error": "not installed"}}))
        return

    try:
        result = engine.compress(text, content_type=content_type)
        stats = {
            "compressed": True,
            "original_tokens": result.get("stats", {}).get("original_tokens", 0),
            "compressed_tokens": result.get("stats", {}).get("compressed_tokens", 0),
            "reduction_pct": result.get("stats", {}).get("reduction_pct", 0),
            "stages_applied": result.get("stats", {}).get("stages_applied", []),
        }
        output = {
            "compressed": result.get("compressed", text),
            "stats": stats,
        }
        # Include rewind_key when RewindStore is enabled
        rewind_key = result.get("rewind_key")
        if rewind_key:
            output["rewind_key"] = rewind_key
        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"compressed": text, "stats": {"compressed": False, "error": str(e)}}))


def cmd_rewind():
    data = json.loads(sys.stdin.read())
    key = data.get("key", "")

    engine = get_engine()
    if not engine:
        print(json.dumps({"found": False, "error": "claw-compactor not installed"}))
        return

    try:
        result = engine.rewind(key)
        if result and result.get("content") is not None:
            print(json.dumps({"content": result["content"], "found": True}))
        else:
            print(json.dumps({"found": False, "error": "Content no longer available"}))
    except Exception as e:
        print(json.dumps({"found": False, "error": str(e)}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        cmd_status()
    elif cmd == "compress-messages":
        cmd_compress_messages()
    elif cmd == "compress-text":
        cmd_compress_text()
    elif cmd == "rewind":
        cmd_rewind()
    else:
        print(json.dumps({"error": f"unknown command: {cmd}"}))
