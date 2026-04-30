"""
Benchmark: baseline vs speculative decoding vs KV-cache quantization
Target:  unsloth/Qwen3.6-35B-A3B-MLX-8bit
Draft:   mlx-community/Qwen3.5-0.8B-MLX-8bit

Runs three configurations back-to-back and prints a comparison table.
"""

import time
import gc
import sys

import mlx.core as mx
from mlx_lm import load, stream_generate

TARGET = "/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit"
DRAFT  = "/Users/matt123/.lmstudio/models/mlx-community/Qwen3.5-0.8B-MLX-8bit"

# Two prompts: short (coding) and long (reasoning) to stress different phases
PROMPTS = {
    "coding": (
        "<|im_start|>user\n"
        "Write a complete Python implementation of a red-black tree with insert, "
        "delete, and search operations. Include all rotation helpers and the "
        "rebalancing logic. Add docstrings.\n"
        "<|im_end|>\n<|im_start|>assistant\n"
    ),
    "reasoning": (
        "<|im_start|>user\n"
        "Explain in detail how transformer attention works, why positional "
        "encodings are needed, what the difference between absolute and rotary "
        "positional embeddings is, and how grouped-query attention reduces KV "
        "cache memory. Be thorough.\n"
        "<|im_end|>\n<|im_start|>assistant\n"
    ),
}

MAX_TOKENS = 256
WARMUP_TOKENS = 32


def clear():
    gc.collect()
    mx.metal.clear_cache()


def warmup(model, tokenizer, prompt):
    """Single short pass to compile Metal shaders before timing."""
    for _ in stream_generate(model, tokenizer, prompt, max_tokens=WARMUP_TOKENS):
        pass
    clear()


def run(model, tokenizer, prompt, draft_model=None, kv_bits=None, num_draft_tokens=4):
    kwargs = dict(max_tokens=MAX_TOKENS)
    if draft_model is not None:
        kwargs["draft_model"] = draft_model
        kwargs["num_draft_tokens"] = num_draft_tokens
    if kv_bits is not None:
        kwargs["kv_bits"] = kv_bits

    last = None
    t0 = time.perf_counter()
    for chunk in stream_generate(model, tokenizer, prompt, **kwargs):
        last = chunk
    elapsed = time.perf_counter() - t0

    gen_tps   = getattr(last, "generation_tps", 0)
    prompt_tps = getattr(last, "prompt_tps", 0)
    gen_tokens = getattr(last, "generation_tokens", 0)
    peak_gb   = mx.metal.get_peak_memory() / 1e9
    clear()
    return gen_tps, prompt_tps, gen_tokens, peak_gb, elapsed


def fmt(label, results):
    rows = []
    for prompt_name, (gen_tps, prompt_tps, gen_tokens, peak_gb, elapsed) in results.items():
        rows.append(
            f"  {prompt_name:<12} {gen_tps:>7.2f} tok/s gen  "
            f"{prompt_tps:>8.1f} tok/s prefill  "
            f"{gen_tokens:>4} tokens  "
            f"{peak_gb:>5.2f} GB peak  "
            f"{elapsed:>6.2f}s"
        )
    return f"\n{'─'*80}\n{label}\n" + "\n".join(rows)


def main():
    print("=" * 80)
    print("Loading target model (35B 8-bit)...")
    target_model, target_tok = load(TARGET)
    print("Loading draft model (0.8B 8-bit)...")
    draft_model, _ = load(DRAFT)
    print("Models loaded.\n")

    configs = [
        ("Baseline (no speculative, fp16 KV)",   dict()),
        ("KV-cache 8-bit (no speculative)",       dict(kv_bits=8)),
        ("KV-cache 4-bit (no speculative)",       dict(kv_bits=4)),
        ("Speculative (draft=0.8B, n=4, fp16 KV)", dict(draft_model=draft_model, num_draft_tokens=4)),
        ("Speculative + KV-8bit",                  dict(draft_model=draft_model, num_draft_tokens=4, kv_bits=8)),
        ("Speculative + KV-4bit",                  dict(draft_model=draft_model, num_draft_tokens=4, kv_bits=4)),
    ]

    # Warm up once with baseline
    print("Warming up Metal shaders...")
    warmup(target_model, target_tok, PROMPTS["coding"])
    print("Warm-up done.\n")

    all_results = {}

    for label, kwargs in configs:
        print(f"Running: {label}")
        results = {}
        for prompt_name, prompt in PROMPTS.items():
            gen_tps, prompt_tps, gen_tokens, peak_gb, elapsed = run(
                target_model, target_tok, prompt, **kwargs
            )
            results[prompt_name] = (gen_tps, prompt_tps, gen_tokens, peak_gb, elapsed)
            print(f"  {prompt_name}: {gen_tps:.2f} tok/s  peak={peak_gb:.2f}GB")
        all_results[label] = results

    # ── Summary table ─────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("RESULTS SUMMARY")
    print("=" * 80)

    baseline_coding   = all_results["Baseline (no speculative, fp16 KV)"]["coding"][0]
    baseline_reasoning = all_results["Baseline (no speculative, fp16 KV)"]["reasoning"][0]

    header = f"{'Config':<45} {'coding tok/s':>12} {'speedup':>8} {'reasoning tok/s':>16} {'speedup':>8} {'peak GB':>8}"
    print(header)
    print("─" * len(header))

    for label, results in all_results.items():
        c_tps  = results["coding"][0]
        r_tps  = results["reasoning"][0]
        c_peak = results["coding"][3]
        r_peak = results["reasoning"][3]
        peak   = max(c_peak, r_peak)
        c_speedup = c_tps / baseline_coding   if baseline_coding   > 0 else 0
        r_speedup = r_tps / baseline_reasoning if baseline_reasoning > 0 else 0
        print(f"{label:<45} {c_tps:>12.2f} {c_speedup:>7.2f}x {r_tps:>16.2f} {r_speedup:>7.2f}x {peak:>8.2f}")

    print("=" * 80)


if __name__ == "__main__":
    main()
