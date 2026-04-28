#!/usr/bin/env python3
"""
Bridge script for claw-compactor integration with QwenCoder.
Called from Node.js via execFile, reads JSON from stdin, writes JSON to stdout.
Updated for claw-compactor v7.1 API (FusionEngine moved to claw_compactor.fusion.engine).
"""
import sys
import json

_engine_cache = None

def get_engine():
    """Try to import FusionEngine from claw-compactor v7.1+. Caches the singleton instance."""
    global _engine_cache
    if _engine_cache is not None:
        return _engine_cache
    # v7.1+: FusionEngine lives in claw_compactor.fusion.engine
    try:
        from claw_compactor.fusion.engine import FusionEngine
        _engine_cache = FusionEngine(enable_rewind=False)
        return _engine_cache
    except (ImportError, TypeError):
        pass
    # v7.0 legacy: FusionEngine exported from top-level
    try:
        from claw_compactor import FusionEngine
        _engine_cache = FusionEngine(rewind=False)
        return _engine_cache
    except (ImportError, TypeError):
        pass
    # Dev path fallback
    try:
        from scripts.lib.fusion.engine import FusionEngine
        _engine_cache = FusionEngine(rewind=False)
        return _engine_cache
    except (ImportError, TypeError):
        pass
    return None


def _get_version(engine):
    """Get version string from engine or package."""
    v = getattr(engine, 'version', None)
    if v:
        return v
    try:
        import importlib.metadata
        return importlib.metadata.version('claw-compactor')
    except Exception:
        return '7.x'


def _extract_stages_applied(stats):
    """Extract stages info from stats. v7.1 uses stages_run (int count), not a list."""
    # v7.1 API: stages_run is an integer count on per-message stats
    stages_run = stats.get("stages_run")
    if isinstance(stages_run, int):
        return stages_run  # return count directly
    # Legacy list format
    per_stage = stats.get("per_stage", [])
    if per_stage:
        return [s["name"] for s in per_stage if not s.get("skipped", True)]
    return stats.get("stages_applied", [])


def cmd_status():
    engine = get_engine()
    if engine:
        print(json.dumps({
            "installed": True,
            "version": _get_version(engine),
            "rewind_enabled": True,  # rewind is handled Node-side
            "stages": getattr(engine, 'stage_names', []),
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
        # v7.1 compress_messages only takes messages list (no kwargs)
        result = engine.compress_messages(messages)
        compressed_msgs = result.get("messages", messages)
        raw_stats = result.get("stats", {})

        # Normalize stats to expected format
        # Aggregate stages_run from per-message stats (v7.1: int count per message)
        per_msg_list = result.get("per_message", [])
        total_stages_run = 0
        for pm in per_msg_list:
            sr = pm.get("stages_run", 0)
            if isinstance(sr, int):
                total_stages_run = max(total_stages_run, sr)

        stats = {
            "compressed": True,
            "original_tokens": raw_stats.get("original_tokens", 0),
            "compressed_tokens": raw_stats.get("compressed_tokens", 0),
            "reduction_pct": raw_stats.get("reduction_pct", 0),
            "stages_applied": total_stages_run,  # int count in v7.1
            "original_messages": len(messages),
            "compressed_messages": len(compressed_msgs),
            "timing_ms": raw_stats.get("total_timing_ms", 0),
        }

        # Store originals in rewind store if available and compression happened
        # NOTE: rewind is now handled Node-side; Python keys are not used
        per_msg_list = result.get("per_message", [])
        if per_msg_list:
            stats["per_message"] = per_msg_list

        print(json.dumps({"messages": compressed_msgs, "stats": stats}))
    except Exception as e:
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
        # Map 'auto' to 'text' for v7.1 API
        ct = content_type if content_type != 'auto' else 'text'
        result = engine.compress(text, content_type=ct)
        raw_stats = result.get("stats", {})

        stats = {
            "compressed": True,
            "original_tokens": raw_stats.get("original_tokens", 0),
            "compressed_tokens": raw_stats.get("compressed_tokens", 0),
            "reduction_pct": raw_stats.get("reduction_pct", 0),
            "stages_applied": _extract_stages_applied(raw_stats),
            "timing_ms": raw_stats.get("total_timing_ms", 0),
        }

        compressed_text = result.get("compressed", text)
        output = {
            "compressed": compressed_text,
            "stats": stats,
        }
        # NOTE: rewind is now handled Node-side; no Python rewind key needed

        print(json.dumps(output))
    except Exception as e:
        print(json.dumps({"compressed": text, "stats": {"compressed": False, "error": str(e)}}))


def cmd_rewind():
    """Rewind is now handled Node-side. This command is kept for backward compat."""
    print(json.dumps({"found": False, "error": "Rewind is handled Node-side. This bridge command is deprecated."}))


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
