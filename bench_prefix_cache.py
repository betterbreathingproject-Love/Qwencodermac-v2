"""
Prefix cache benchmark: measures the TTFT and generation TPS benefit of
caching the system prompt KV state across turns.

Simulates a realistic agentic session:
  - Large system prompt (~2k tokens) that is identical on every request
  - Growing conversation history appended each turn
  - 5 turns at increasing context sizes

Compares:
  A) No cache  — full re-prefill every turn (current behaviour)
  B) Prefix cache — system prompt KV cached once, only new tokens prefilled

Also tests whether Qwen3.5's hybrid architecture actually supports cache reuse
(known issue: mlx-lm #903).
"""

import time
import gc
import tempfile
import os

import mlx.core as mx
from mlx_lm import load, stream_generate
from mlx_lm.models.cache import (
    make_prompt_cache,
    save_prompt_cache,
    load_prompt_cache,
    can_trim_prompt_cache,
    trim_prompt_cache,
)

TARGET = "/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit"

MAX_NEW_TOKENS = 128

# ── Realistic system prompt (~2k tokens) ─────────────────────────────────────
SYSTEM_PROMPT = """\
<|im_start|>system
You are an expert software engineer working on a macOS application called QwenCoder Mac Studio.
The application is an Electron-based IDE that bundles a local MLX inference server.
You have access to the following tools: read_file, write_file, bash, search_files, list_directory.

Architecture overview:
- main.js: Electron entry point, IPC wiring, agent factory
- config.js: Token budgets, model paths, compaction thresholds
- direct-bridge.js: Qwen SDK wrapper, system prompt builder, full tool execution loop
- orchestrator.js: DAG execution engine, branch/loop logic
- agent-pool.js: Semaphore-based concurrency, keyword routing, type registry
- server.py: FastAPI + MLX inference server on port 8090
- memory-bridge.py: Memory backend (KnowledgeGraph, VectorMemory, Archive)

Code style rules (non-negotiable):
1. 'use strict' at the top of every Node.js module
2. CommonJS only — require/module.exports, never import/export
3. No TypeScript — plain JavaScript throughout
4. Renderer is vanilla JS — direct DOM manipulation, no React/Vue
5. Prefer Node.js built-ins: node:events, node:fs, node:crypto, node:test
6. File size: keep each write_file call under 300 lines
7. Token budgets: centralized in config.js, never hardcode elsewhere
8. Optional dependencies: load with try/require, degrade gracefully

When implementing features:
- Read existing code before writing new code
- Match the project's style, conventions, and libraries
- Do not introduce new dependencies without justification
- Always check for existing patterns before creating new ones
- Prefer small, focused changes over large rewrites
- Test your changes by reading the modified files back

Current task context:
You are helping implement performance optimizations for the MLX inference server.
The server uses FastAPI with async endpoints and an asyncio.Semaphore for serializing
Metal GPU inference. The model is Qwen3.6-35B-A3B-MLX-8bit running on Apple Silicon.
<|im_end|>
"""

# Conversation turns that accumulate
TURNS = [
    ("user", "Read the server.py file and tell me what the current autotune optimizations are."),
    ("assistant", "I'll read server.py to understand the current autotune optimizations.\n<tool_call><function=read_file><parameter=path>server.py</parameter><parameter=start_line>1</parameter><parameter=end_line>100</parameter></function></tool_call>"),
    ("tool", "\"\"\"MLX Vision Server — OpenAI-compatible API with vision + tool calling support.\"\"\"\nimport os, base64, tempfile, time, uuid, json, asyncio, re, sys, threading\n_model = None\n_processor = None\n_config = None\n_model_id = None\n_kv_bits = None\n_speculative_enabled = False"),
    ("assistant", "The current autotune optimizations in server.py are:\n1. Dynamic KV sizing: caps max_tokens so KV cache only covers what's needed\n2. Smart cache clearing: only clears Metal cache when memory pressure >65%\n3. Prefill batching: uses prefill_step_size=1024 for prompts >2000 chars\n4. Memory-adaptive max_tokens: scales down at high memory pressure\n5. Metal shader warm-up: pre-compiles GPU kernels after model load"),
    ("user", "Now implement prefix caching for the system prompt. The system prompt is the same on every request, so we should cache its KV state once after model load and reuse it across turns."),
]


def build_prompt(turns_so_far: int, new_user_msg: str) -> str:
    """Build a multi-turn prompt with the system prompt + history + new message."""
    parts = [SYSTEM_PROMPT]
    for role, content in TURNS[:turns_so_far]:
        parts.append(f"<|im_start|>{role}\n{content}<|im_end|>\n")
    parts.append(f"<|im_start|>user\n{new_user_msg}<|im_end|>\n<|im_start|>assistant\n")
    return "".join(parts)


def clear():
    gc.collect()
    try:
        mx.clear_cache()
    except AttributeError:
        mx.metal.clear_cache()


def peak_gb():
    try:
        return mx.get_peak_memory() / 1e9
    except AttributeError:
        return mx.metal.get_peak_memory() / 1e9


def run_no_cache(model, tokenizer, prompt):
    """Baseline: full re-prefill every turn."""
    last = None
    t0 = time.perf_counter()
    first_token_time = None
    for chunk in stream_generate(model, tokenizer, prompt, max_tokens=MAX_NEW_TOKENS):
        if first_token_time is None:
            first_token_time = time.perf_counter() - t0
        last = chunk
    elapsed = time.perf_counter() - t0
    clear()
    return (
        getattr(last, "generation_tps", 0),
        getattr(last, "prompt_tps", 0),
        getattr(last, "prompt_tokens", 0),
        first_token_time or elapsed,
        elapsed,
        peak_gb(),
    )


def run_with_prefix_cache(model, tokenizer, system_prompt_tokens: int,
                          full_prompt: str, cached_state, can_trim: bool):
    """
    With prefix cache: feed only the tokens AFTER the cached prefix.

    If can_trim=True (pure-attention models): trim cache back to system prompt
    boundary before each turn — true multi-turn prefix reuse.

    If can_trim=False (Qwen3.5 hybrid): build a fresh empty cache each turn
    (no reuse possible — measures overhead vs baseline).
    """
    if can_trim:
        # Find current offset and trim back to system_prompt_tokens
        current_offset = 0
        for c in cached_state:
            if hasattr(c, 'offset'):
                current_offset = c.offset
                break
        tokens_to_trim = current_offset - system_prompt_tokens
        if tokens_to_trim > 0:
            trim_prompt_cache(cached_state, tokens_to_trim)
        active_cache = cached_state
    else:
        # Hybrid model — can't rewind. Use a fresh empty cache each turn.
        # This is equivalent to baseline but with cache allocation overhead.
        active_cache = make_prompt_cache(model)

    last = None
    t0 = time.perf_counter()
    first_token_time = None
    for chunk in stream_generate(
        model, tokenizer, full_prompt,
        max_tokens=MAX_NEW_TOKENS,
        prompt_cache=active_cache,
    ):
        if first_token_time is None:
            first_token_time = time.perf_counter() - t0
        last = chunk
    elapsed = time.perf_counter() - t0
    clear()
    return (
        getattr(last, "generation_tps", 0),
        getattr(last, "prompt_tps", 0),
        getattr(last, "prompt_tokens", 0),
        first_token_time or elapsed,
        elapsed,
        peak_gb(),
    )


def estimate_tokens(text, tokenizer):
    try:
        if hasattr(tokenizer, 'encode'):
            return len(tokenizer.encode(text))
        if hasattr(tokenizer, 'tokenizer'):
            return len(tokenizer.tokenizer.encode(text))
    except Exception:
        pass
    return len(text) // 4


def main():
    print("=" * 80)
    print("PREFIX CACHE BENCHMARK")
    print(f"Model: {TARGET.split('/')[-1]}")
    print(f"Tokens generated per turn: {MAX_NEW_TOKENS}")
    print("=" * 80)

    print("\nLoading model...")
    model, tokenizer = load(TARGET)
    print("Model loaded.\n")

    # Measure system prompt token count
    sys_tokens = estimate_tokens(SYSTEM_PROMPT, tokenizer)
    print(f"System prompt: ~{sys_tokens} tokens ({len(SYSTEM_PROMPT)} chars)")

    # Build prompts for each turn
    user_questions = [
        "What is the current memory pressure threshold for Metal cache clearing?",
        "How does the inference semaphore work and why is it needed?",
        "Explain the tool call parsing pipeline for streaming responses.",
        "What happens when the server receives a request with images?",
        "How should I implement the prefix cache feature in server.py?",
    ]

    prompts = []
    for i, q in enumerate(user_questions):
        p = build_prompt(min(i * 2, len(TURNS)), q)
        tok_count = estimate_tokens(p, tokenizer)
        prompts.append((p, tok_count))
        print(f"  Turn {i+1}: ~{tok_count} tokens ({len(p)} chars)")

    print()

    # ── Warmup ────────────────────────────────────────────────────────────────
    print("Warming up Metal shaders...")
    for _ in stream_generate(model, tokenizer, prompts[0][0], max_tokens=32):
        pass
    clear()
    print("Warm-up done.\n")

    # ── Baseline: no cache ────────────────────────────────────────────────────
    print("─" * 80)
    print("BASELINE — full re-prefill every turn")
    print(f"{'Turn':>6}  {'ctx tok':>8}  {'TTFT':>8}  {'gen tok/s':>10}  {'prefill tok/s':>14}  {'elapsed':>8}")

    baseline_results = []
    for i, (prompt, tok_count) in enumerate(prompts):
        gen_tps, prompt_tps, prompt_tokens, ttft, elapsed, pgb = run_no_cache(model, tokenizer, prompt)
        baseline_results.append((gen_tps, prompt_tps, prompt_tokens, ttft, elapsed, pgb))
        print(f"  {i+1:>4}  {tok_count:>8}  {ttft:>7.2f}s  {gen_tps:>10.2f}  {prompt_tps:>14.1f}  {elapsed:>7.2f}s")

    # ── Build prefix cache ────────────────────────────────────────────────────
    print()
    print("─" * 80)
    print("Building prefix cache from system prompt...")

    cache_state = make_prompt_cache(model)
    can_trim = can_trim_prompt_cache(cache_state)
    print(f"  Cache trimmable: {can_trim}")

    if not can_trim:
        print("\n⚠️  WARNING: This model's cache cannot be trimmed — Qwen3.5 hybrid")
        print("   architecture (recurrent + attention) does not support partial rewind.")
        print("   Prefix caching will NOT work correctly for multi-turn reuse.")
        print("   Proceeding anyway to measure the overhead...\n")

    # Pre-fill the cache with just the system prompt
    t_cache_start = time.perf_counter()
    for _ in stream_generate(
        model, tokenizer, SYSTEM_PROMPT,
        max_tokens=1,  # generate 1 token just to force full prefill
        prompt_cache=cache_state,
    ):
        pass
    cache_build_time = time.perf_counter() - t_cache_start

    # Count how many tokens are now in the cache
    cached_token_count = 0
    for c in cache_state:
        if hasattr(c, 'offset'):
            cached_token_count = c.offset
            break

    print(f"  Cache built in {cache_build_time:.2f}s")
    print(f"  Cached tokens: {cached_token_count}")

    # Save to disk (optional — shows persistence capability)
    with tempfile.NamedTemporaryFile(suffix='.safetensors', delete=False) as f:
        cache_file = f.name
    save_prompt_cache(cache_file, cache_state, metadata={"model": TARGET, "prompt": "system_prompt"})
    cache_size_mb = os.path.getsize(cache_file) / (1024 * 1024)
    print(f"  Cache file size: {cache_size_mb:.1f} MB")

    # Measure disk load time
    t_load = time.perf_counter()
    loaded_cache = load_prompt_cache(cache_file)
    load_time = time.perf_counter() - t_load
    print(f"  Cache load time: {load_time:.3f}s")
    del loaded_cache
    clear()

    # ── With prefix cache ─────────────────────────────────────────────────────
    print()
    print("─" * 80)
    if can_trim:
        print("WITH PREFIX CACHE — system prompt KV reused each turn (in-memory rewind)")
    else:
        print("WITH FRESH CACHE ALLOC — (can_trim=False: no reuse, just measures alloc overhead)")
    print(f"{'Turn':>6}  {'ctx tok':>8}  {'TTFT':>8}  {'gen tok/s':>10}  {'prefill tok/s':>14}  {'elapsed':>8}  {'TTFT speedup':>13}")

    cached_results = []
    for i, (prompt, tok_count) in enumerate(prompts):
        # For prefix cache: the prompt fed to the model is the FULL prompt
        # but the cache already has the system prompt tokens, so only the
        # delta (history + new user message) gets prefilled
        gen_tps, prompt_tps, prompt_tokens, ttft, elapsed, pgb = run_with_prefix_cache(
            model, tokenizer, cached_token_count, prompt, cache_state, can_trim
        )
        cached_results.append((gen_tps, prompt_tps, prompt_tokens, ttft, elapsed, pgb))
        baseline_ttft = baseline_results[i][3]
        ttft_speedup = baseline_ttft / ttft if ttft > 0 else 0
        print(f"  {i+1:>4}  {tok_count:>8}  {ttft:>7.2f}s  {gen_tps:>10.2f}  {prompt_tps:>14.1f}  {elapsed:>7.2f}s  {ttft_speedup:>12.2f}x")

    # ── Summary ───────────────────────────────────────────────────────────────
    print()

    # ── Disk-load test (non-trimmable models only) ────────────────────────────
    disk_results = []
    if not can_trim:
        print("─" * 80)
        print("DISK-LOAD CACHE — load saved state from disk each turn + delta prefill")
        print(f"  (load time: {load_time:.3f}s per turn, cache size: {cache_size_mb:.1f} MB)")
        print(f"{'Turn':>6}  {'ctx tok':>8}  {'TTFT':>8}  {'gen tok/s':>10}  {'prefill tok/s':>14}  {'elapsed':>8}  {'TTFT speedup':>13}")

        for i, (prompt, tok_count) in enumerate(prompts):
            # Load fresh cache from disk each turn
            t0 = time.perf_counter()
            disk_cache = load_prompt_cache(cache_file)
            first_token_time = None
            last = None
            for chunk in stream_generate(
                model, tokenizer, prompt,
                max_tokens=MAX_NEW_TOKENS,
                prompt_cache=disk_cache,
            ):
                if first_token_time is None:
                    first_token_time = time.perf_counter() - t0
                last = chunk
            elapsed = time.perf_counter() - t0
            gen_tps = getattr(last, "generation_tps", 0)
            prompt_tps = getattr(last, "prompt_tps", 0)
            pgb = peak_gb()
            clear()
            disk_results.append((gen_tps, prompt_tps, 0, first_token_time or elapsed, elapsed, pgb))
            baseline_ttft = baseline_results[i][3]
            ttft_speedup = baseline_ttft / (first_token_time or elapsed) if (first_token_time or elapsed) > 0 else 0
            print(f"  {i+1:>4}  {tok_count:>8}  {first_token_time or elapsed:>7.2f}s  {gen_tps:>10.2f}  {prompt_tps:>14.1f}  {elapsed:>7.2f}s  {ttft_speedup:>12.2f}x")
        print()

    os.unlink(cache_file)

    print("=" * 80)
    print("SUMMARY")
    print("=" * 80)

    avg_baseline_ttft = sum(r[3] for r in baseline_results) / len(baseline_results)
    avg_cached_ttft   = sum(r[3] for r in cached_results)   / len(cached_results)
    avg_baseline_gen  = sum(r[0] for r in baseline_results) / len(baseline_results)
    avg_cached_gen    = sum(r[0] for r in cached_results)   / len(cached_results)

    print(f"  Avg TTFT    — baseline: {avg_baseline_ttft:.2f}s  cached: {avg_cached_ttft:.2f}s  speedup: {avg_baseline_ttft/avg_cached_ttft:.2f}x")
    print(f"  Avg gen TPS — baseline: {avg_baseline_gen:.2f}  cached: {avg_cached_gen:.2f}")
    print(f"  Cache build cost: {cache_build_time:.2f}s (one-time, amortized over all turns)")
    print(f"  Cache disk size: {cache_size_mb:.1f} MB")
    print()

    if disk_results:
        avg_disk_ttft = sum(r[3] for r in disk_results) / len(disk_results)
        avg_disk_gen  = sum(r[0] for r in disk_results) / len(disk_results)
        print(f"  Disk-load TTFT — avg: {avg_disk_ttft:.2f}s  speedup vs baseline: {avg_baseline_ttft/avg_disk_ttft:.2f}x")
        print(f"  Disk-load gen TPS — avg: {avg_disk_gen:.2f}")
        print(f"  Disk load overhead per turn: {load_time:.3f}s")
        print()

    if not can_trim:
        print("⚠️  VERDICT: Qwen3.5 hybrid architecture (recurrent + attention layers)")
        print("   does NOT support prefix cache reuse. can_trim_prompt_cache=False.")
        print("   The disk-load approach above shows what save/load would cost.")
        print("   For real gains, wait for mlx-lm to fix Qwen3.5 cache trimming,")
        print("   or switch to a pure-attention model (Qwen3, Llama, etc.).")
    else:
        print("✅ Cache is trimmable — true prefix caching is supported for this model.")

    print("=" * 80)


if __name__ == "__main__":
    main()
