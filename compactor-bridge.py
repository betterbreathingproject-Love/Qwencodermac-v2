#!/usr/bin/env python3
"""
Bridge script for claw-compactor integration with QwenCoder.
Called from Node.js via execFile, reads JSON from stdin, writes JSON to stdout.
"""
import sys
import json

def get_engine():
    """Try to import FusionEngine from claw-compactor."""
    try:
        from claw_compactor import FusionEngine
        return FusionEngine()
    except ImportError:
        pass
    try:
        from scripts.lib.fusion.engine import FusionEngine
        return FusionEngine()
    except ImportError:
        pass
    return None


def cmd_status():
    engine = get_engine()
    if engine:
        print(json.dumps({"installed": True, "version": getattr(engine, 'version', '7.0+')}))
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
        result = engine.compress_messages(messages)
        compressed_msgs = result.get("messages", messages)
        stats = result.get("stats", {})
        stats["compressed"] = True
        print(json.dumps({"messages": compressed_msgs, "stats": stats}))
    except Exception as e:
        # Fallback: basic compression — trim long messages
        trimmed = []
        for msg in messages:
            content = msg.get("content", "")
            if isinstance(content, str) and len(content) > 4000:
                try:
                    r = engine.compress(content, content_type="auto")
                    trimmed.append({**msg, "content": r.get("compressed", content)})
                except Exception:
                    trimmed.append(msg)
            else:
                trimmed.append(msg)
        print(json.dumps({
            "messages": trimmed if trimmed else messages,
            "stats": {"compressed": True, "fallback": True, "error": str(e)}
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
        print(json.dumps({
            "compressed": result.get("compressed", text),
            "stats": {
                "compressed": True,
                "original_tokens": result.get("stats", {}).get("original_tokens", 0),
                "compressed_tokens": result.get("stats", {}).get("compressed_tokens", 0),
                "reduction_pct": result.get("stats", {}).get("reduction_pct", 0),
            }
        }))
    except Exception as e:
        print(json.dumps({"compressed": text, "stats": {"compressed": False, "error": str(e)}}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    if cmd == "status":
        cmd_status()
    elif cmd == "compress-messages":
        cmd_compress_messages()
    elif cmd == "compress-text":
        cmd_compress_text()
    else:
        print(json.dumps({"error": f"unknown command: {cmd}"}))
