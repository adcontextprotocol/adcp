"""
Compare three content classification methods for TMP:
1. Embedding similarity (nomic-embed-text-v1.5, 256 dims)
2. LLM topic extraction (fast model, structured output)
3. LLM ad brief (fast model, "what ads would fit?")

Uses Anthropic Claude Haiku for the LLM calls (fast, cheap).
"""

import time
import json
import os
import numpy as np
import torch
import torch.nn.functional as F
from sentence_transformers import SentenceTransformer

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False

MODEL_NAME = "nomic-ai/nomic-embed-text-v1.5"

CONVERSATIONS = {
    "cooking_carbonara": [
        {"role": "user", "content": "What's a good recipe for pasta carbonara?"},
        {"role": "assistant", "content": "Classic carbonara uses guanciale, eggs, pecorino romano, black pepper, and spaghetti."},
        {"role": "user", "content": "What kind of pan should I use?"},
    ],
    "cooking_cast_iron": [
        {"role": "user", "content": "I'm looking for a good cast iron pan. Any recommendations?"},
        {"role": "assistant", "content": "Lodge and Le Creuset are excellent choices. A 12-inch skillet is the most versatile size."},
        {"role": "user", "content": "How do I season it properly?"},
    ],
    "running_beginner": [
        {"role": "user", "content": "I want to start running. I'm completely new to it."},
        {"role": "assistant", "content": "Start with a couch to 5K program. Alternate running and walking, 3 times per week."},
        {"role": "user", "content": "What shoes should I get? I have flat feet."},
    ],
    "training_5k": [
        {"role": "user", "content": "I'm training for a 5K. How should I structure my training?"},
        {"role": "assistant", "content": "Build a base with 3 easy runs per week, then add intervals."},
        {"role": "user", "content": "What about nutrition during training?"},
    ],
    "home_renovation": [
        {"role": "user", "content": "I'm thinking about renovating my kitchen. Where do I start?"},
        {"role": "assistant", "content": "Start with a budget and priorities. Cabinets and countertops usually have the biggest impact."},
        {"role": "user", "content": "What about the backsplash? Tile or something else?"},
    ],
    "travel_japan": [
        {"role": "user", "content": "I'm planning a trip to Japan next spring. What should I know?"},
        {"role": "assistant", "content": "Cherry blossom season peaks late March to mid April. Book accommodations early."},
        {"role": "user", "content": "What about the rail pass? Is it still worth it?"},
    ],
    "weather_chitchat": [
        {"role": "user", "content": "What's the weather like?"},
        {"role": "assistant", "content": "I don't have real-time weather data, but I can help you find a forecast."},
        {"role": "user", "content": "Never mind. Tell me a joke instead."},
    ],
    "coding_python": [
        {"role": "user", "content": "How do I read a CSV file in Python?"},
        {"role": "assistant", "content": "Use pandas: pd.read_csv('file.csv'). Or the built-in csv module for simpler needs."},
        {"role": "user", "content": "What about handling missing values?"},
    ],
}

PACKAGES = {
    "pkg-olive-oil": {
        "description": "Italian cooking ingredients, olive oil, Mediterranean cuisine",
        "topics": ["cooking", "italian", "ingredients", "mediterranean"],
    },
    "pkg-cookware": {
        "description": "Kitchen equipment, cookware, pans, skillets, chef tools",
        "topics": ["cooking", "kitchen", "equipment", "cookware"],
    },
    "pkg-meal-kit": {
        "description": "Meal delivery kits, recipe boxes, easy dinner solutions",
        "topics": ["cooking", "dinner", "meal-prep", "recipes"],
    },
    "pkg-running-shoes": {
        "description": "Running shoes, athletic footwear, marathon training gear",
        "topics": ["fitness", "running", "shoes", "athletics"],
    },
    "pkg-fitness-app": {
        "description": "Fitness tracking, workout plans, exercise apps",
        "topics": ["fitness", "exercise", "health", "tracking"],
    },
    "pkg-home-depot": {
        "description": "Home improvement, renovation supplies, tools, kitchen remodel",
        "topics": ["home", "renovation", "kitchen", "improvement"],
    },
    "pkg-travel-agency": {
        "description": "Travel planning, flights, hotels, vacation packages, Japan tours",
        "topics": ["travel", "vacation", "flights", "hotels"],
    },
    "pkg-laptop": {
        "description": "Laptops, computers, programming tools, tech gadgets",
        "topics": ["technology", "computers", "programming", "gadgets"],
    },
    "pkg-investing": {
        "description": "Stock market investing, index funds, retirement planning",
        "topics": ["finance", "investing", "retirement", "stocks"],
    },
}


def format_for_embedding(messages):
    parts = []
    for msg in messages:
        prefix = "User" if msg["role"] == "user" else "Assistant"
        parts.append(f"{prefix}: {msg['content']}")
    return "search_query: " + " | ".join(parts)


def embed_and_truncate(model, texts, dim=256):
    embeddings = model.encode(texts, convert_to_tensor=True)
    embeddings = F.layer_norm(embeddings, normalized_shape=(embeddings.shape[1],))
    embeddings = embeddings[:, :dim]
    embeddings = F.normalize(embeddings, p=2, dim=1)
    return embeddings.cpu().numpy()


def cosine_sim(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def method_embedding(model, messages, pkg_embeddings, pkg_ids):
    """Method 1: Embedding similarity."""
    conv_text = format_for_embedding(messages)
    conv_emb = embed_and_truncate(model, [conv_text], 256)[0]

    scores = {}
    for i, pkg_id in enumerate(pkg_ids):
        scores[pkg_id] = cosine_sim(conv_emb, pkg_embeddings[i])
    return scores


def method_llm_topics(client, messages):
    """Method 2: LLM extracts topic tags."""
    conv_text = "\n".join(f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in messages)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=200,
        messages=[{
            "role": "user",
            "content": f"""Extract 3-5 topic tags from this conversation. Return ONLY a JSON array of lowercase strings. No explanation.

Conversation:
{conv_text}

Tags:"""
        }]
    )

    text = response.content[0].text.strip()
    # Handle markdown code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0].strip()
    try:
        tags = json.loads(text)
        return tags
    except json.JSONDecodeError:
        # Try to extract array from text
        if "[" in text:
            try:
                return json.loads(text[text.index("["):text.rindex("]")+1])
            except (json.JSONDecodeError, ValueError):
                pass
        return text.lower().split(", ") if text else []


def method_llm_ad_brief(client, messages):
    """Method 3: LLM generates an ad brief — what products would fit?"""
    conv_text = "\n".join(f"{'User' if m['role'] == 'user' else 'Assistant'}: {m['content']}" for m in messages)

    response = client.messages.create(
        model="claude-haiku-4-5-20251001",
        max_tokens=300,
        messages=[{
            "role": "user",
            "content": f"""Given this conversation, what types of products or services would be contextually relevant to sponsor? Return a JSON object with:
- "categories": array of 2-4 product categories (e.g., "cookware", "running shoes")
- "keywords": array of 5-8 specific keywords a buyer would target
- "summary": one sentence describing the ideal sponsor

No explanation, just the JSON.

Conversation:
{conv_text}"""
        }]
    )

    text = response.content[0].text.strip()
    # Handle markdown code fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        text = text.rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        if "{" in text:
            try:
                return json.loads(text[text.index("{"):text.rindex("}")+1])
            except (json.JSONDecodeError, ValueError):
                pass
        return {"categories": [], "keywords": text.lower().split(), "summary": text}


def score_topics_against_packages(topics, packages):
    """Score topic list against each package's topic list."""
    scores = {}
    topic_set = set(t.lower() for t in topics)
    for pkg_id, pkg_info in packages.items():
        pkg_topics = set(t.lower() for t in pkg_info["topics"])
        overlap = len(topic_set & pkg_topics)
        max_possible = max(len(topic_set), len(pkg_topics), 1)
        scores[pkg_id] = overlap / max_possible
    return scores


def score_brief_against_packages(brief, packages):
    """Score ad brief against packages using keyword overlap."""
    keywords = set()
    for k in brief.get("keywords", []):
        keywords.update(k.lower().split())
    for c in brief.get("categories", []):
        keywords.update(c.lower().split())

    scores = {}
    for pkg_id, pkg_info in packages.items():
        pkg_words = set()
        for t in pkg_info["topics"]:
            pkg_words.update(t.lower().split())
        for w in pkg_info["description"].lower().split():
            pkg_words.add(w.strip(",."))

        overlap = len(keywords & pkg_words)
        max_possible = max(len(keywords), 1)
        scores[pkg_id] = overlap / max_possible
    return scores


def expected_top_packages():
    """Ground truth: what package SHOULD be #1 for each conversation."""
    return {
        "cooking_carbonara": "pkg-olive-oil",
        "cooking_cast_iron": "pkg-cookware",
        "running_beginner": "pkg-running-shoes",
        "training_5k": "pkg-running-shoes",
        "home_renovation": "pkg-home-depot",
        "travel_japan": "pkg-travel-agency",
        "weather_chitchat": None,  # No good match
        "coding_python": "pkg-laptop",
    }


def main():
    print("Loading embedding model...")
    emb_model = SentenceTransformer(MODEL_NAME, trust_remote_code=True)

    # Pre-embed all packages
    pkg_ids = list(PACKAGES.keys())
    pkg_texts = [f"search_document: {p['description']}" for p in PACKAGES.values()]
    pkg_embeddings = embed_and_truncate(emb_model, pkg_texts, 256)

    client = None
    if HAS_ANTHROPIC and os.environ.get("ANTHROPIC_API_KEY"):
        client = anthropic.Anthropic()
        print("Anthropic client ready")
    else:
        print("No Anthropic API key — skipping LLM methods")

    ground_truth = expected_top_packages()

    results = {
        "embedding": {"correct": 0, "total": 0, "times": []},
        "llm_topics": {"correct": 0, "total": 0, "times": []},
        "llm_brief": {"correct": 0, "total": 0, "times": []},
    }

    print(f"\n{'=' * 70}")
    print("COMPARISON: Embedding vs LLM Topics vs LLM Ad Brief")
    print(f"{'=' * 70}")

    for conv_name, messages in CONVERSATIONS.items():
        expected = ground_truth[conv_name]
        print(f"\n--- {conv_name} (expected: {expected}) ---")

        # Method 1: Embedding
        start = time.time()
        emb_scores = method_embedding(emb_model, messages, pkg_embeddings, pkg_ids)
        emb_time = (time.time() - start) * 1000
        emb_ranked = sorted(emb_scores.items(), key=lambda x: x[1], reverse=True)
        emb_top = emb_ranked[0][0]
        emb_correct = (expected is None and emb_ranked[0][1] < 0.55) or emb_top == expected
        results["embedding"]["times"].append(emb_time)
        if expected:
            results["embedding"]["total"] += 1
            if emb_top == expected:
                results["embedding"]["correct"] += 1

        print(f"  Embedding ({emb_time:.0f}ms): {emb_ranked[0][0]}={emb_ranked[0][1]:.3f}  {emb_ranked[1][0]}={emb_ranked[1][1]:.3f}  {'✓' if emb_correct else '✗'}")

        if client:
            # Method 2: LLM Topics
            start = time.time()
            topics = method_llm_topics(client, messages)
            topic_time = (time.time() - start) * 1000
            topic_scores = score_topics_against_packages(topics, PACKAGES)
            topic_ranked = sorted(topic_scores.items(), key=lambda x: x[1], reverse=True)
            topic_top = topic_ranked[0][0]
            topic_correct = (expected is None and topic_ranked[0][1] == 0) or topic_top == expected
            results["llm_topics"]["times"].append(topic_time)
            if expected:
                results["llm_topics"]["total"] += 1
                if topic_top == expected:
                    results["llm_topics"]["correct"] += 1

            print(f"  LLM Topics ({topic_time:.0f}ms): {topics}")
            print(f"    Top: {topic_ranked[0][0]}={topic_ranked[0][1]:.3f}  {topic_ranked[1][0]}={topic_ranked[1][1]:.3f}  {'✓' if topic_correct else '✗'}")

            # Method 3: LLM Ad Brief
            start = time.time()
            brief = method_llm_ad_brief(client, messages)
            brief_time = (time.time() - start) * 1000
            brief_scores = score_brief_against_packages(brief, PACKAGES)
            brief_ranked = sorted(brief_scores.items(), key=lambda x: x[1], reverse=True)
            brief_top = brief_ranked[0][0]
            brief_correct = (expected is None and brief_ranked[0][1] < 0.1) or brief_top == expected
            results["llm_brief"]["times"].append(brief_time)
            if expected:
                results["llm_brief"]["total"] += 1
                if brief_top == expected:
                    results["llm_brief"]["correct"] += 1

            print(f"  LLM Brief ({brief_time:.0f}ms): {json.dumps(brief, indent=None)[:120]}...")
            print(f"    Top: {brief_ranked[0][0]}={brief_ranked[0][1]:.3f}  {brief_ranked[1][0]}={brief_ranked[1][1]:.3f}  {'✓' if brief_correct else '✗'}")

    # Summary
    print(f"\n{'=' * 70}")
    print("SUMMARY")
    print(f"{'=' * 70}")

    for method_name, r in results.items():
        if r["total"] == 0:
            continue
        accuracy = r["correct"] / r["total"] * 100
        avg_ms = np.mean(r["times"]) if r["times"] else 0
        print(f"  {method_name:15s}: {r['correct']}/{r['total']} correct ({accuracy:.0f}%)  avg {avg_ms:.0f}ms")


if __name__ == "__main__":
    main()
