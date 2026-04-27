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
        _engine_cache = FusionEngine(enable_rewind=True)
        return _engine_cache
    except (ImportError, TypeError):
        pass
    # v7.0 legacy: FusionEngine exported from top-level
    try:
        from claw_compactor import FusionEngine
        _engine_cache = FusionEngine(rewind=True)
        return _engine_cache
    except (ImportError, TypeError):
        pass
    # Dev path fallback
    try:
        from scripts.lib.fusion.engine import FusionEngine
        _engine_cache = FusionEngine(rewind=True)
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
    """Extract list of stage names that actually ran from per_stage stats."""
    per_stage = stats.get("per_stage", [])
    if per_stage:
        return [s["name"] for s in per_stage if not s.get("skipped", True)]
    # Fallback for older API
    return stats.get("stages_applied", [])


def cmd_status():
    engine = get_engine()
    if engine:
        rewind_enabled = hasattr(engine, 'rewind_store') and engine.rewind_store is not None
        print(json.dumps({
            "installed": True,
            "version": _get_version(engine),
            "rewind_enabled": bool(rewind_enabled),
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
        # Aggregate stages_applied from per-message stats
        per_msg_list = result.get("per_message", [])
        all_stages = set()
        for pm in per_msg_list:
            pm_stats = pm.get("stats", pm)  # per_message items may have stats nested or flat
            per_stage = pm_stats.get("per_stage", [])
            for s in per_stage:
                if not s.get("skipped", True):
                    all_stages.add(s["name"])

        stats = {
            "compressed": True,
            "original_tokens": raw_stats.get("original_tokens", 0),
            "compressed_tokens": raw_stats.get("compressed_tokens", 0),
            "reduction_pct": raw_stats.get("reduction_pct", 0),
            "stages_applied": _extract_stages_applied(raw_stats) or sorted(all_stages),
            "original_messages": len(messages),
            "compressed_messages": len(compressed_msgs),
            "timing_ms": raw_stats.get("total_timing_ms", 0),
        }

        # Store originals in rewind store if available and compression happened
        rewind_keys = []
        if engine.rewind_store and stats["reduction_pct"] > 0:
            for i, (orig, comp) in enumerate(zip(messages, compressed_msgs)):
                orig_content = orig.get("content", "")
                comp_content = comp.get("content", "")
                if orig_content != comp_content and len(orig_content) > 100:
                    from claw_compactor.tokens import estimate_tokens
                    key = engine.rewind_store.store(
                        orig_content, comp_content,
                        original_tokens=estimate_tokens(orig_content),
                        compressed_tokens=estimate_tokens(comp_content),
                    )
                    rewind_keys.append(key)
            if rewind_keys:
                stats["rewind_keys"] = rewind_keys

        # Include per-message stats from result
        per_message = result.get("per_message", [])
        if per_message:
            stats["per_message"] = per_message

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

        # Store in rewind if compression was meaningful
        if engine.rewind_store and stats["reduction_pct"] > 10 and len(text) > 200:
            from claw_compactor.tokens import estimate_tokens
            key = engine.rewind_store.store(
                text, compressed_text,
                original_tokens=stats["original_tokens"],
                compressed_tokens=stats["compressed_tokens"],
            )
            output["rewind_key"] = key
            stats["rewind_key"] = key

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

    if not engine.rewind_store:
        print(json.dumps({"found": False, "error": "RewindStore not enabled"}))
        return

    try:
        content = engine.rewind_store.retrieve(key)
        if content is not None:
            print(json.dumps({"content": content, "found": True}))
        else:
            print(json.dumps({"found": False, "error": "Content no longer available (expired or not found)"}))
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
