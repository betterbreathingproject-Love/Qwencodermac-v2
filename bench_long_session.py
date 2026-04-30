"""
Long-session benchmark: simulates multi-turn agentic coding sessions.

Builds a realistic growing context (system prompt + tool calls + code responses)
and measures throughput + memory at 2k / 8k / 16k / 32k token context sizes
across four configs:
  A) Baseline (fp16 KV)
  B) KV-8bit
  C) Speculative + fp16 KV
  D) Speculative + KV-8bit  ← predicted winner

Each "turn" appends ~512 tokens of realistic agent content so the context
grows naturally. We measure generation TPS and peak Metal memory at each
context checkpoint.
"""

import time
import gc
import sys
import textwrap

import mlx.core as mx
from mlx_lm import load, stream_generate

TARGET = "/Users/matt123/.lmstudio/models/unsloth/Qwen3.6-35B-A3B-MLX-8bit"
DRAFT  = "/Users/matt123/.lmstudio/models/mlx-community/Qwen3.5-0.8B-MLX-8bit"

MAX_NEW_TOKENS = 128   # tokens generated per turn (realistic agent reply slice)
CONTEXT_CHECKPOINTS = [2_000, 8_000, 16_000, 32_000]  # prompt token targets

# ── Realistic agent session content ──────────────────────────────────────────
# Each block is ~512 tokens of realistic agentic coding content.
# We repeat/cycle these to build up context to the target sizes.

SYSTEM_PROMPT = """\
<|im_start|>system
You are an expert software engineer. You have access to tools: read_file, write_file, bash, search_files.
You work methodically: explore first, then implement. Always read existing code before modifying.
Current project: PhotoRanker iOS app (Swift/SwiftUI). The codebase uses MVVM architecture,
CoreML for on-device inference, and a custom embedding pipeline for photo similarity ranking.
<|im_end|>
"""

# Realistic tool call + response blocks that accumulate in a session
TURN_BLOCKS = [
    # Turn 1: explore
    """\
<|im_start|>user
Implement a new clustering algorithm that groups similar photos by visual embedding distance.
<|im_end|>
<|im_start|>assistant
Let me start by reading the existing embedding and clustering code.
<tool_call><function=read_file><parameter=path>PhotoRanker/Services/EmbeddingService.swift</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
import CoreML
import Vision
import UIKit

class EmbeddingService {
    private let model: VNCoreMLModel
    private let queue = DispatchQueue(label: "embedding", qos: .userInitiated)

    init() throws {
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndNeuralEngine
        let mlModel = try PhotoEmbedder(configuration: config).model
        self.model = try VNCoreMLModel(for: mlModel)
    }

    func embed(_ image: UIImage) async throws -> [Float] {
        return try await withCheckedThrowingContinuation { continuation in
            queue.async {
                guard let cgImage = image.cgImage else {
                    continuation.resume(throwing: EmbeddingError.invalidImage)
                    return
                }
                let request = VNCoreMLRequest(model: self.model) { request, error in
                    if let error = error {
                        continuation.resume(throwing: error)
                        return
                    }
                    guard let results = request.results as? [VNCoreMLFeatureValueObservation],
                          let embedding = results.first?.featureValue.multiArrayValue else {
                        continuation.resume(throwing: EmbeddingError.noResults)
                        return
                    }
                    let vector = (0..<embedding.count).map { Float(embedding[$0].floatValue) }
                    continuation.resume(returning: vector)
                }
                let handler = VNImageRequestHandler(cgImage: cgImage)
                try? handler.perform([request])
            }
        }
    }
}
<|im_end|>
""",
    # Turn 2: read cluster model
    """\
<|im_start|>assistant
Now let me read the existing cluster model.
<tool_call><function=read_file><parameter=path>PhotoRanker/Models/Cluster.swift</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
import Foundation

struct Cluster: Identifiable, Codable {
    let id: UUID
    var name: String
    var photoIds: [UUID]
    var centroid: [Float]
    var createdAt: Date
    var updatedAt: Date

    init(name: String, photoIds: [UUID] = [], centroid: [Float] = []) {
        self.id = UUID()
        self.name = name
        self.photoIds = photoIds
        self.centroid = centroid
        self.createdAt = Date()
        self.updatedAt = Date()
    }

    mutating func updateCentroid(embeddings: [[Float]]) {
        guard !embeddings.isEmpty else { return }
        let dim = embeddings[0].count
        var sum = [Float](repeating: 0, count: dim)
        for emb in embeddings {
            for i in 0..<dim { sum[i] += emb[i] }
        }
        centroid = sum.map { $0 / Float(embeddings.count) }
        updatedAt = Date()
    }

    func distance(to embedding: [Float]) -> Float {
        guard centroid.count == embedding.count else { return Float.infinity }
        let diff = zip(centroid, embedding).map { ($0 - $1) * ($0 - $1) }
        return sqrt(diff.reduce(0, +))
    }
}
<|im_end|>
""",
    # Turn 3: read clustering service
    """\
<|im_start|>assistant
Let me check the current clustering service implementation.
<tool_call><function=read_file><parameter=path>PhotoRanker/Services/ClusteringService.swift</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
import Foundation
import Combine

class ClusteringService: ObservableObject {
    @Published var clusters: [Cluster] = []
    private let embeddingService: EmbeddingService
    private let threshold: Float = 0.35

    init(embeddingService: EmbeddingService) {
        self.embeddingService = embeddingService
    }

    func cluster(photos: [Photo]) async throws {
        var result: [Cluster] = []
        for photo in photos {
            guard let image = photo.image else { continue }
            let embedding = try await embeddingService.embed(image)
            var assigned = false
            for i in 0..<result.count {
                if result[i].distance(to: embedding) < threshold {
                    result[i].photoIds.append(photo.id)
                    assigned = true
                    break
                }
            }
            if !assigned {
                var newCluster = Cluster(name: "Cluster \(result.count + 1)", photoIds: [photo.id])
                newCluster.updateCentroid(embeddings: [embedding])
                result.append(newCluster)
            }
        }
        await MainActor.run { self.clusters = result }
    }
}
<|im_end|>
""",
    # Turn 4: bash search
    """\
<|im_start|>assistant
Let me check what other clustering-related files exist.
<tool_call><function=bash><parameter=command>find PhotoRanker -name "*.swift" | xargs grep -l "cluster\|Cluster" | sort</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
PhotoRanker/Models/Cluster.swift
PhotoRanker/Services/ClusteringService.swift
PhotoRanker/ViewModels/ClusterViewModel.swift
PhotoRanker/Views/ClusterView.swift
PhotoRanker/Views/ClusterDetailView.swift
<|im_end|>
<|im_start|>assistant
<tool_call><function=read_file><parameter=path>PhotoRanker/ViewModels/ClusterViewModel.swift</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
import Foundation
import Combine
import SwiftUI

@MainActor
class ClusterViewModel: ObservableObject {
    @Published var clusters: [Cluster] = []
    @Published var isLoading = false
    @Published var error: Error?
    @Published var selectedCluster: Cluster?

    private let clusteringService: ClusteringService
    private var cancellables = Set<AnyCancellable>()

    init(clusteringService: ClusteringService) {
        self.clusteringService = clusteringService
        clusteringService.$clusters
            .receive(on: DispatchQueue.main)
            .assign(to: &$clusters)
    }

    func recluster(photos: [Photo]) {
        isLoading = true
        error = nil
        Task {
            do {
                try await clusteringService.cluster(photos: photos)
            } catch {
                self.error = error
            }
            isLoading = false
        }
    }
}
<|im_end|>
""",
    # Turn 5: implementation decision
    """\
<|im_start|>assistant
I have a clear picture of the architecture. The current greedy nearest-centroid approach
is O(n*k) per photo and doesn't update centroids incrementally. I'll implement a proper
k-means variant with the following improvements:

1. **Mini-batch k-means** — process photos in batches of 32 for better centroid estimates
2. **Cosine similarity** instead of Euclidean distance (better for embedding spaces)
3. **Elbow method** for automatic k selection (test k=2..12, pick inflection point)
4. **Incremental updates** — new photos update nearest centroid without full recompute

Let me write the new ClusteringService:
<tool_call><function=write_file><parameter=path>PhotoRanker/Services/ClusteringService.swift</parameter><parameter=content>
import Foundation
import Combine
import Accelerate

class ClusteringService: ObservableObject {
    @Published var clusters: [Cluster] = []
    private let embeddingService: EmbeddingService
    private let minClusters = 2
    private let maxClusters = 12
    private let maxIterations = 50
    private let batchSize = 32

    init(embeddingService: EmbeddingService) {
        self.embeddingService = embeddingService
    }

    // MARK: - Public API

    func cluster(photos: [Photo]) async throws {
        guard !photos.isEmpty else { return }
        var embeddings: [(UUID, [Float])] = []
        for photo in photos {
            guard let image = photo.image else { continue }
            let emb = try await embeddingService.embed(image)
            embeddings.append((photo.id, normalise(emb)))
        }
        let k = selectK(embeddings: embeddings.map { $0.1 })
        let result = kMeans(embeddings: embeddings, k: k)
        await MainActor.run { self.clusters = result }
    }

    func addPhoto(_ photo: Photo) async throws {
        guard let image = photo.image else { return }
        let emb = normalise(try await embeddingService.embed(image))
        await MainActor.run {
            if var nearest = clusters.enumerated().min(by: {
                cosineDist($0.element.centroid, emb) < cosineDist($1.element.centroid, emb)
            }) {
                clusters[nearest.offset].photoIds.append(photo.id)
            }
        }
    }

    // MARK: - K selection (elbow method)

    private func selectK(embeddings: [[Float]]) -> Int {
        guard embeddings.count >= maxClusters else {
            return max(minClusters, embeddings.count / 3)
        }
        var inertias: [Float] = []
        for k in minClusters...maxClusters {
            let centroids = initCentroids(embeddings: embeddings, k: k)
            let inertia = computeInertia(embeddings: embeddings, centroids: centroids)
            inertias.append(inertia)
        }
        return elbowIndex(inertias: inertias) + minClusters
    }

    private func elbowIndex(inertias: [Float]) -> Int {
        guard inertias.count > 2 else { return 0 }
        var maxCurvature: Float = 0
        var bestIdx = 0
        for i in 1..<(inertias.count - 1) {
            let curvature = inertias[i-1] + inertias[i+1] - 2 * inertias[i]
            if curvature > maxCurvature { maxCurvature = curvature; bestIdx = i }
        }
        return bestIdx
    }
</parameter></parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
{"ok": true, "bytes_written": 2847}
<|im_end|>
""",
    # Turn 6: continue implementation
    """\
<|im_start|>assistant
Now let me add the k-means core and helper functions:
<tool_call><function=write_file><parameter=path>PhotoRanker/Services/ClusteringServiceHelpers.swift</parameter><parameter=content>
import Foundation
import Accelerate

extension ClusteringService {

    // MARK: - K-Means

    func kMeans(embeddings: [(UUID, [Float])], k: Int) -> [Cluster] {
        let vecs = embeddings.map { $0.1 }
        var centroids = initCentroids(embeddings: vecs, k: k)

        for _ in 0..<maxIterations {
            let assignments = vecs.map { vec -> Int in
                centroids.enumerated().min(by: {
                    cosineDist($0.element, vec) < cosineDist($1.element, vec)
                })!.offset
            }
            var newCentroids = [[Float]](repeating: [Float](repeating: 0, count: vecs[0].count), count: k)
            var counts = [Int](repeating: 0, count: k)
            for (i, assignment) in assignments.enumerated() {
                for j in 0..<vecs[i].count { newCentroids[assignment][j] += vecs[i][j] }
                counts[assignment] += 1
            }
            for i in 0..<k where counts[i] > 0 {
                newCentroids[i] = newCentroids[i].map { $0 / Float(counts[i]) }
                newCentroids[i] = normalise(newCentroids[i])
            }
            if zip(centroids, newCentroids).allSatisfy({ cosineDist($0, $1) < 1e-4 }) { break }
            centroids = newCentroids
        }

        var clusters = (0..<k).map { i in
            Cluster(name: "Cluster \(i+1)", centroid: centroids[i])
        }
        let assignments = vecs.map { vec in
            centroids.enumerated().min(by: {
                cosineDist($0.element, vec) < cosineDist($1.element, vec)
            })!.offset
        }
        for (i, assignment) in assignments.enumerated() {
            clusters[assignment].photoIds.append(embeddings[i].0)
        }
        return clusters
    }

    // MARK: - K-Means++ initialisation

    func initCentroids(embeddings: [[Float]], k: Int) -> [[Float]] {
        var centroids: [[Float]] = [embeddings.randomElement()!]
        while centroids.count < k {
            let dists = embeddings.map { vec in
                centroids.map { cosineDist($0, vec) }.min()!
            }
            let total = dists.reduce(0, +)
            var r = Float.random(in: 0..<total)
            for (i, d) in dists.enumerated() {
                r -= d
                if r <= 0 { centroids.append(embeddings[i]); break }
            }
        }
        return centroids
    }

    // MARK: - Distance helpers

    func cosineDist(_ a: [Float], _ b: [Float]) -> Float {
        var dot: Float = 0
        vDSP_dotpr(a, 1, b, 1, &dot, vDSP_Length(a.count))
        return 1.0 - dot  // vectors are pre-normalised
    }

    func normalise(_ v: [Float]) -> [Float] {
        var norm: Float = 0
        vDSP_svesq(v, 1, &norm, vDSP_Length(v.count))
        norm = sqrt(norm)
        guard norm > 1e-8 else { return v }
        return v.map { $0 / norm }
    }

    func computeInertia(embeddings: [[Float]], centroids: [[Float]]) -> Float {
        embeddings.reduce(0) { sum, vec in
            let d = centroids.map { cosineDist($0, vec) }.min() ?? 0
            return sum + d * d
        }
    }
}
</parameter></function></tool_call>
<|im_end|>
<|im_start|>tool
{"ok": true, "bytes_written": 2341}
<|im_end|>
""",
]


def build_context(target_tokens: int, tokenizer) -> str:
    """Build a realistic multi-turn session context of approximately target_tokens tokens."""
    ctx = SYSTEM_PROMPT
    block_idx = 0
    while True:
        next_block = TURN_BLOCKS[block_idx % len(TURN_BLOCKS)]
        candidate = ctx + next_block
        # Estimate token count (chars/4 heuristic — fast, good enough for sizing)
        estimated = len(candidate) // 4
        if estimated >= target_tokens:
            break
        ctx = candidate
        block_idx += 1
        if block_idx > 200:  # safety cap
            break

    # Append a fresh user turn so the model has something to generate
    ctx += (
        "<|im_start|>user\n"
        "Now write comprehensive unit tests for the new ClusteringService using XCTest. "
        "Cover: k selection, centroid initialisation, cosine distance, normalisation, "
        "incremental photo addition, and edge cases (empty input, single photo, k > n photos).\n"
        "<|im_end|>\n"
        "<|im_start|>assistant\n"
    )
    return ctx


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


def active_gb():
    try:
        return mx.metal.get_active_memory() / 1e9
    except Exception:
        return 0.0


def run_turn(model, tokenizer, prompt, draft_model=None, kv_bits=None, num_draft_tokens=4):
    kwargs = dict(max_tokens=MAX_NEW_TOKENS)
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

    gen_tps    = getattr(last, "generation_tps", 0) if last else 0
    prompt_tps = getattr(last, "prompt_tps", 0) if last else 0
    gen_tokens = getattr(last, "generation_tokens", 0) if last else 0
    p_gb       = peak_gb()
    a_gb       = active_gb()
    clear()
    return gen_tps, prompt_tps, gen_tokens, p_gb, a_gb, elapsed


def estimate_tokens(text, tokenizer):
    """Estimate token count — use tokenizer if available, else chars/4."""
    try:
        if hasattr(tokenizer, 'encode'):
            return len(tokenizer.encode(text))
        if hasattr(tokenizer, 'tokenizer') and hasattr(tokenizer.tokenizer, 'encode'):
            return len(tokenizer.tokenizer.encode(text))
    except Exception:
        pass
    return len(text) // 4


CONFIGS = [
    ("Baseline (fp16 KV)",       dict()),
    ("KV-8bit",                  dict(kv_bits=8)),
    ("Speculative fp16 KV",      dict(num_draft_tokens=4)),          # draft injected below
    ("Speculative + KV-8bit",    dict(num_draft_tokens=4, kv_bits=8)),
]


def main():
    print("=" * 90)
    print("LONG-SESSION BENCHMARK — growing context pressure")
    print(f"Target model: {TARGET.split('/')[-1]}")
    print(f"Draft model:  {DRAFT.split('/')[-1]}")
    print(f"Context checkpoints: {CONTEXT_CHECKPOINTS} tokens")
    print(f"Tokens generated per turn: {MAX_NEW_TOKENS}")
    print("=" * 90)

    print("\nLoading target model (35B 8-bit)...")
    target_model, target_tok = load(TARGET)
    print("Loading draft model (0.8B 8-bit)...")
    draft_model, _ = load(DRAFT)
    print("Models loaded.\n")

    # Build prompts at each context size
    print("Building context prompts...")
    prompts = {}
    for ctx_size in CONTEXT_CHECKPOINTS:
        p = build_context(ctx_size, target_tok)
        actual = estimate_tokens(p, target_tok)
        prompts[ctx_size] = p
        print(f"  {ctx_size:>6} token target → {actual:>6} actual tokens  ({len(p):>7} chars)")

    # Warmup
    print("\nWarming up Metal shaders...")
    for _ in stream_generate(target_model, target_tok, prompts[2_000], max_tokens=32):
        pass
    clear()
    print("Warm-up done.\n")

    # Results: results[config_label][ctx_size] = (gen_tps, prompt_tps, peak_gb, active_gb)
    results = {label: {} for label, _ in CONFIGS}

    for label, kwargs in CONFIGS:
        use_draft = "Speculative" in label
        kw = dict(kwargs)
        if use_draft:
            kw["draft_model"] = draft_model

        print(f"\n{'─'*90}")
        print(f"Config: {label}")
        print(f"{'Context':>10}  {'gen tok/s':>10}  {'prefill tok/s':>14}  {'peak GB':>8}  {'active GB':>10}  {'elapsed':>8}")

        for ctx_size in CONTEXT_CHECKPOINTS:
            prompt = prompts[ctx_size]
            gen_tps, prompt_tps, gen_tokens, p_gb, a_gb, elapsed = run_turn(
                target_model, target_tok, prompt, **kw
            )
            results[label][ctx_size] = (gen_tps, prompt_tps, p_gb, a_gb)
            print(f"  {ctx_size:>8}  {gen_tps:>10.2f}  {prompt_tps:>14.1f}  {p_gb:>8.2f}  {a_gb:>10.2f}  {elapsed:>7.2f}s")

    # ── Summary tables ────────────────────────────────────────────────────────
    print("\n\n" + "=" * 90)
    print("GENERATION THROUGHPUT (tok/s) — higher is better")
    print("=" * 90)

    ctx_header = "  ".join(f"{c:>8}" for c in CONTEXT_CHECKPOINTS)
    print(f"{'Config':<30}  {ctx_header}  {'avg':>8}  {'vs baseline':>12}")
    print("─" * 90)

    baseline_avgs = {}
    for label, _ in CONFIGS:
        tps_vals = [results[label][c][0] for c in CONTEXT_CHECKPOINTS]
        avg = sum(tps_vals) / len(tps_vals)
        if label == "Baseline (fp16 KV)":
            baseline_avgs = {c: results[label][c][0] for c in CONTEXT_CHECKPOINTS}
            baseline_avg = avg
        row = "  ".join(f"{v:>8.2f}" for v in tps_vals)
        speedup = avg / baseline_avg if baseline_avg > 0 else 0
        print(f"{label:<30}  {row}  {avg:>8.2f}  {speedup:>11.2f}x")

    print("\n\n" + "=" * 90)
    print("PEAK METAL MEMORY (GB) — lower is better")
    print("=" * 90)
    print(f"{'Config':<30}  {ctx_header}  {'max':>8}")
    print("─" * 90)

    for label, _ in CONFIGS:
        gb_vals = [results[label][c][2] for c in CONTEXT_CHECKPOINTS]
        row = "  ".join(f"{v:>8.2f}" for v in gb_vals)
        print(f"{label:<30}  {row}  {max(gb_vals):>8.2f}")

    print("\n\n" + "=" * 90)
    print("PREFILL THROUGHPUT (tok/s) — how fast the prompt is processed")
    print("=" * 90)
    print(f"{'Config':<30}  {ctx_header}")
    print("─" * 90)

    for label, _ in CONFIGS:
        pt_vals = [results[label][c][1] for c in CONTEXT_CHECKPOINTS]
        row = "  ".join(f"{v:>8.1f}" for v in pt_vals)
        print(f"{label:<30}  {row}")

    print("\n\n" + "=" * 90)
    print("THROUGHPUT DEGRADATION — tok/s at 32k vs 2k (how much context hurts)")
    print("=" * 90)
    for label, _ in CONFIGS:
        tps_2k  = results[label][2_000][0]
        tps_32k = results[label][32_000][0]
        drop = (tps_2k - tps_32k) / tps_2k * 100 if tps_2k > 0 else 0
        print(f"  {label:<30}  {tps_2k:.2f} → {tps_32k:.2f} tok/s  ({drop:+.1f}%)")

    print("=" * 90)


if __name__ == "__main__":
    main()
