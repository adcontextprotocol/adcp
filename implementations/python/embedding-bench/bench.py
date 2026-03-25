"""
Benchmark: nomic-embed-text-v1.5 for TMP conversation embedding.

Tests:
1. Single turn embedding latency at 256, 512, 768 dims
2. Full conversation history embedding (5, 10, 20 turns)
3. Quantization to int8
4. Similarity preservation at different dim truncations
5. Practical conversation classification accuracy
"""

import time
import json
import numpy as np
import torch
import torch.nn.functional as F
from sentence_transformers import SentenceTransformer

MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5"

# Simulated OpenAI-style conversation histories
CONVERSATIONS = {
    "cooking_short": [
        {"role": "user", "content": "What's a good recipe for pasta carbonara?"},
        {"role": "assistant", "content": "Classic carbonara uses guanciale, eggs, pecorino romano, black pepper, and spaghetti."},
        {"role": "user", "content": "What kind of pan should I use?"},
    ],
    "cooking_long": [
        {"role": "user", "content": "What's a good recipe for pasta carbonara?"},
        {"role": "assistant", "content": "Classic carbonara uses guanciale, eggs, pecorino romano, black pepper, and spaghetti."},
        {"role": "user", "content": "What kind of pan should I use?"},
        {"role": "assistant", "content": "A heavy-bottomed stainless steel or carbon steel pan works best. Cast iron is also great."},
        {"role": "user", "content": "How long should I cook the guanciale?"},
        {"role": "assistant", "content": "Cook it low and slow for about 8-10 minutes until the fat renders and it's crispy."},
        {"role": "user", "content": "What about the egg mixture?"},
        {"role": "assistant", "content": "Mix 4 egg yolks with 1 whole egg, add grated pecorino, and lots of black pepper."},
        {"role": "user", "content": "Can I substitute with bacon?"},
        {"role": "assistant", "content": "You can, but it won't be authentic. Pancetta is a closer substitute than bacon."},
    ],
    "fitness": [
        {"role": "user", "content": "I want to start running. Any tips for a beginner?"},
        {"role": "assistant", "content": "Start with a couch to 5K program. Run 3 times a week with rest days between."},
        {"role": "user", "content": "What shoes do you recommend?"},
    ],
    "technology": [
        {"role": "user", "content": "Can you explain how neural networks work?"},
        {"role": "assistant", "content": "Neural networks are layers of interconnected nodes that learn patterns from data."},
        {"role": "user", "content": "What about transformers?"},
    ],
    "finance": [
        {"role": "user", "content": "Should I invest in index funds or individual stocks?"},
        {"role": "assistant", "content": "For most people, index funds offer better diversification and lower fees."},
        {"role": "user", "content": "What about bonds?"},
    ],
    "weather": [
        {"role": "user", "content": "What's the weather like today?"},
        {"role": "assistant", "content": "I don't have access to real-time weather data."},
        {"role": "user", "content": "Tell me a joke then."},
    ],
}

# Buyer targeting clusters — what each package "means"
PACKAGE_DESCRIPTIONS = {
    "pkg-olive-oil": "search_document: Italian cooking ingredients, olive oil, Mediterranean cuisine, pasta recipes",
    "pkg-cookware": "search_document: Kitchen equipment, cookware, pans, chef tools, cooking gear",
    "pkg-meal-kit": "search_document: Meal delivery kits, recipe boxes, easy dinner solutions, home cooking",
    "pkg-running-shoes": "search_document: Running shoes, athletic footwear, marathon training, jogging gear",
    "pkg-fitness-app": "search_document: Fitness tracking, workout plans, exercise apps, health monitoring",
    "pkg-laptop": "search_document: Laptops, computers, technology, programming tools, tech gadgets",
    "pkg-investing": "search_document: Stock market investing, index funds, retirement planning, financial services",
}


def format_conversation(messages: list[dict]) -> str:
    """Format OpenAI-style messages into a single string for embedding.
    Uses nomic's search_query prefix for the conversation content."""
    parts = []
    for msg in messages:
        prefix = "User" if msg["role"] == "user" else "Assistant"
        parts.append(f"{prefix}: {msg['content']}")
    return "search_query: " + " | ".join(parts)


def embed_and_truncate(model, texts: list[str], dim: int) -> np.ndarray:
    """Embed texts and truncate to specified dimension using Matryoshka."""
    embeddings = model.encode(texts, convert_to_tensor=True)
    embeddings = F.layer_norm(embeddings, normalized_shape=(embeddings.shape[1],))
    embeddings = embeddings[:, :dim]
    embeddings = F.normalize(embeddings, p=2, dim=1)
    return embeddings.cpu().numpy()


def quantize_int8(embeddings: np.ndarray) -> np.ndarray:
    """Quantize float32 embeddings to int8 (-127 to 127)."""
    max_val = np.max(np.abs(embeddings), axis=1, keepdims=True)
    max_val = np.where(max_val == 0, 1, max_val)  # avoid division by zero
    scaled = embeddings / max_val * 127
    return scaled.astype(np.int8)


def cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two vectors."""
    a = a.astype(np.float32)
    b = b.astype(np.float32)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def main():
    print("Loading model...")
    start = time.time()
    model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)
    print(f"Model loaded in {time.time() - start:.1f}s\n")

    # === Benchmark 1: Embedding latency at different dimensions ===
    print("=" * 60)
    print("BENCHMARK 1: Embedding Latency")
    print("=" * 60)

    conv_text = format_conversation(CONVERSATIONS["cooking_short"])
    for dim in [64, 128, 256, 512, 768]:
        times = []
        for _ in range(20):
            start = time.time()
            embed_and_truncate(model, [conv_text], dim)
            times.append(time.time() - start)
        avg_ms = np.mean(times[5:]) * 1000  # skip warmup
        wire_bytes = dim  # int8 = 1 byte per dim
        print(f"  {dim:4d} dims: {avg_ms:6.1f}ms  wire: {wire_bytes:4d} bytes (int8)")

    # === Benchmark 2: Conversation length impact ===
    print(f"\n{'=' * 60}")
    print("BENCHMARK 2: Conversation Length Impact")
    print("=" * 60)

    dim = 256
    for name, messages in [
        ("3 turns", CONVERSATIONS["cooking_short"]),
        ("10 turns", CONVERSATIONS["cooking_long"]),
        ("20 turns", CONVERSATIONS["cooking_long"] * 2),
    ]:
        conv_text = format_conversation(messages)
        tokens = len(conv_text.split())  # rough token estimate
        times = []
        for _ in range(10):
            start = time.time()
            embed_and_truncate(model, [conv_text], dim)
            times.append(time.time() - start)
        avg_ms = np.mean(times[3:]) * 1000
        print(f"  {name:10s}: {avg_ms:6.1f}ms  (~{tokens} tokens)")

    # === Benchmark 3: Similarity preservation across dimensions ===
    print(f"\n{'=' * 60}")
    print("BENCHMARK 3: Similarity Preservation Across Dimensions")
    print("=" * 60)

    cooking_text = format_conversation(CONVERSATIONS["cooking_short"])
    fitness_text = format_conversation(CONVERSATIONS["fitness"])
    weather_text = format_conversation(CONVERSATIONS["weather"])

    for dim in [64, 128, 256, 512, 768]:
        embs = embed_and_truncate(model, [cooking_text, fitness_text, weather_text], dim)
        cook_fit = cosine_similarity(embs[0], embs[1])
        cook_weather = cosine_similarity(embs[0], embs[2])
        print(f"  {dim:4d} dims: cooking↔fitness={cook_fit:.3f}  cooking↔weather={cook_weather:.3f}  separation={cook_fit - cook_weather:.3f}")

    # === Benchmark 4: Package matching accuracy ===
    print(f"\n{'=' * 60}")
    print("BENCHMARK 4: Package Matching (256 dims, int8)")
    print("=" * 60)

    dim = 256

    # Embed all package descriptions
    pkg_texts = list(PACKAGE_DESCRIPTIONS.values())
    pkg_ids = list(PACKAGE_DESCRIPTIONS.keys())
    pkg_embeddings = embed_and_truncate(model, pkg_texts, dim)
    pkg_int8 = quantize_int8(pkg_embeddings)

    # Test each conversation against all packages
    for conv_name, messages in CONVERSATIONS.items():
        conv_text = format_conversation(messages)
        conv_emb = embed_and_truncate(model, [conv_text], dim)
        conv_int8 = quantize_int8(conv_emb)

        # Score against all packages (using int8 for realism)
        scores = {}
        for i, pkg_id in enumerate(pkg_ids):
            scores[pkg_id] = cosine_similarity(conv_int8[0], pkg_int8[i])

        # Sort by score
        ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
        top3 = ranked[:3]

        print(f"\n  {conv_name}:")
        for pkg_id, score in top3:
            marker = " <<<" if score > 0.5 else ""
            print(f"    {score:.3f}  {pkg_id}{marker}")

    # === Benchmark 5: Float32 vs Int8 similarity preservation ===
    print(f"\n{'=' * 60}")
    print("BENCHMARK 5: Float32 vs Int8 Quality")
    print("=" * 60)

    dim = 256
    all_texts = [format_conversation(msgs) for msgs in CONVERSATIONS.values()]
    float_embs = embed_and_truncate(model, all_texts, dim)
    int8_embs = quantize_int8(float_embs)

    # Compare pairwise similarities
    diffs = []
    for i in range(len(all_texts)):
        for j in range(i + 1, len(all_texts)):
            sim_float = cosine_similarity(float_embs[i], float_embs[j])
            sim_int8 = cosine_similarity(int8_embs[i], int8_embs[j])
            diffs.append(abs(sim_float - sim_int8))

    print(f"  Mean similarity difference (float32 vs int8): {np.mean(diffs):.4f}")
    print(f"  Max similarity difference:                     {np.max(diffs):.4f}")
    print(f"  Conclusion: {'Negligible — int8 is safe' if np.mean(diffs) < 0.01 else 'Significant — use float32'}")

    # === Summary ===
    print(f"\n{'=' * 60}")
    print("SUMMARY: Recommended TMP Configuration")
    print("=" * 60)
    print(f"  Model:      {MODEL_NAME}")
    print(f"  Dimensions: 256 (Matryoshka truncation)")
    print(f"  Quantize:   int8 (256 bytes on wire)")
    print(f"  License:    Apache 2.0")
    print(f"  Context:    8192 tokens")
    print(f"  Parameters: 0.1B (runs on CPU)")


if __name__ == "__main__":
    main()
