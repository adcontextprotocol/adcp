"""
Multi-model embedding benchmark with realistic Addie conversations.

Tests: nomic-embed-text-v1.5, all-MiniLM-L6-v2, bge-small-en-v1.5
At: 64, 128, 256, 512 dims (where Matryoshka supported)
With: float32 and int8 quantization
Against: realistic ad tech conversations and sponsor packages
"""

import time
import json
import numpy as np
import torch
import torch.nn.functional as F
from sentence_transformers import SentenceTransformer

# --- Realistic Addie Conversations ---

CONVERSATIONS = {
    # Ad tech protocol discussions
    "prebid_integration": [
        {"role": "user", "content": "We're running Prebid Server and want to understand how to integrate with AdCP. What's the best approach?"},
        {"role": "assistant", "content": "The most common path is adding the AdCP Prebid module to your Prebid Server instance. It replaces vendor-specific RTD modules with a single standardized integration."},
        {"role": "user", "content": "How does it handle identity? We use UID2 and ID5 today."},
    ],
    "identity_resolution": [
        {"role": "user", "content": "I'm trying to understand how identity resolution works without third-party cookies. What are the options?"},
        {"role": "assistant", "content": "The main alternatives are UID2 (open-source, deterministic), ID5 (probabilistic + deterministic), LiveRamp RampID (graph-based), and publisher first-party data."},
        {"role": "user", "content": "Which one has the best match rates for CTV?"},
    ],
    "ctv_measurement": [
        {"role": "user", "content": "Our CTV campaigns are running but we can't measure incrementality. The standard metrics feel useless."},
        {"role": "assistant", "content": "CTV measurement is challenging. Most teams use a combination of brand lift studies, matched market tests, and cross-device attribution via identity graphs."},
        {"role": "user", "content": "What about attention metrics? Scope3 and Adelaide keep coming up."},
    ],
    "carbon_sustainability": [
        {"role": "user", "content": "Our agency is pushing us to reduce the carbon footprint of our media buys. Where do we start?"},
        {"role": "assistant", "content": "Start by measuring your current footprint with a tool like Scope3's emissions data. Then optimize: reduce made-for-advertising inventory, consolidate supply paths, and prioritize direct publisher relationships."},
        {"role": "user", "content": "How much can we actually save without hurting performance?"},
    ],
    "retail_media_setup": [
        {"role": "user", "content": "We're a mid-size retailer thinking about launching a retail media network. What infrastructure do we need?"},
        {"role": "assistant", "content": "You need an ad server (Kevel, CitrusAd, or build on GAM), a product catalog feed for sponsored listings, and an attribution system that ties ad exposure to purchase."},
        {"role": "user", "content": "What about onsite vs offsite? Should we start with both?"},
    ],
    "brand_safety_ivt": [
        {"role": "user", "content": "We keep getting flagged for IVT on our programmatic buys. How do we clean this up?"},
        {"role": "assistant", "content": "Start with pre-bid filtering using IAS, DoubleVerify, or Pixalate. Then implement ads.txt and sellers.json strictly. Block unknown or unauthorized sellers."},
        {"role": "user", "content": "Is there a way to automate this with AdCP?"},
    ],

    # General business conversations
    "agency_pitch": [
        {"role": "user", "content": "I'm preparing a pitch to a CPG brand about agentic advertising. What's the angle?"},
        {"role": "assistant", "content": "Lead with efficiency: agentic buying reduces manual IO processing and campaign setup time. Then show the measurement story: unified attribution across channels."},
        {"role": "user", "content": "They're currently spending $50M across 15 publishers. What's the first thing we'd change?"},
    ],
    "working_group": [
        {"role": "user", "content": "I want to join the CTV working group. What's the commitment and what are they working on?"},
        {"role": "assistant", "content": "The CTV working group meets biweekly. They're currently defining the pod composition standard and CTV-specific creative formats for AdCP."},
        {"role": "user", "content": "Can I contribute? I have experience with FreeWheel's pod logic."},
    ],
    "certification_prep": [
        {"role": "user", "content": "I'm studying for the AdCP A1 certification. Any tips?"},
        {"role": "assistant", "content": "Focus on the core lifecycle: get_products, create_media_buy, get_media_buy_delivery. Understand how property registration works and how buyer agents discover seller inventory."},
        {"role": "user", "content": "What about the media buy lifecycle? That section was confusing."},
    ],

    # --- Non-ad-tech conversations ---

    # Cooking / food
    "cooking_carbonara": [
        {"role": "user", "content": "What's a good recipe for pasta carbonara?"},
        {"role": "assistant", "content": "Classic carbonara uses guanciale, eggs, pecorino romano, black pepper, and spaghetti. The key is tempering the eggs so they don't scramble."},
        {"role": "user", "content": "What kind of pan should I use? And what olive oil?"},
    ],
    "meal_planning": [
        {"role": "user", "content": "I need to plan meals for the week. Family of four, two kids under 10."},
        {"role": "assistant", "content": "Batch cooking helps. Make a big pot of chili or soup on Sunday. Sheet pan dinners are great for weeknights."},
        {"role": "user", "content": "Any good meal kit services? I'm tired of grocery shopping."},
    ],

    # Fitness / health
    "running_beginner": [
        {"role": "user", "content": "I want to start running. I'm completely out of shape."},
        {"role": "assistant", "content": "Start with a couch to 5K program. Walk-run intervals, 3 times per week. Get fitted for proper shoes."},
        {"role": "user", "content": "What shoes for flat feet? And should I track with an app?"},
    ],
    "home_gym": [
        {"role": "user", "content": "Thinking about building a home gym. What's essential?"},
        {"role": "assistant", "content": "Start with adjustable dumbbells, a bench, and a pull-up bar. A good mat for floor work. You don't need machines."},
        {"role": "user", "content": "What about a Peloton or rowing machine?"},
    ],

    # Travel
    "japan_trip": [
        {"role": "user", "content": "Planning a two-week trip to Japan. Cherry blossom season. Budget around $5K."},
        {"role": "assistant", "content": "Late March to mid April for blossoms. Get a 14-day Japan Rail Pass. Mix Tokyo, Kyoto, and Osaka."},
        {"role": "user", "content": "Do I need travel insurance? And what about data/wifi?"},
    ],

    # Home improvement
    "kitchen_reno": [
        {"role": "user", "content": "Our kitchen is from the 80s. Want to modernize but on a budget."},
        {"role": "assistant", "content": "Paint cabinets instead of replacing. New hardware makes a huge difference. Butcher block counters are affordable."},
        {"role": "user", "content": "What about the backsplash? Peel and stick vs real tile?"},
    ],

    # Parenting
    "toddler_sleep": [
        {"role": "user", "content": "My 2 year old won't sleep through the night. We've tried everything."},
        {"role": "assistant", "content": "Consistent bedtime routine is key. Bath, book, bed. Same time every night. Dark room, white noise."},
        {"role": "user", "content": "Should we try a sleep consultant? Are those worth it?"},
    ],

    # Finance
    "investing_beginner": [
        {"role": "user", "content": "I have $10K saved and want to start investing. No idea where to begin."},
        {"role": "assistant", "content": "Open a brokerage account with Fidelity or Schwab. Start with a total market index fund like VTI or VTSAX."},
        {"role": "user", "content": "What about a Roth IRA? And should I pay off student loans first?"},
    ],

    # Cars
    "electric_vehicle": [
        {"role": "user", "content": "Thinking about getting an EV. Is it worth it yet?"},
        {"role": "assistant", "content": "Depends on your driving pattern. If you have home charging and drive under 250 miles daily, absolutely."},
        {"role": "user", "content": "Tesla vs Hyundai Ioniq 5 vs the new Chevy Equinox EV?"},
    ],

    # Pets
    "puppy_training": [
        {"role": "user", "content": "Just got a golden retriever puppy. 8 weeks old. Help!"},
        {"role": "assistant", "content": "Crate training from day one. Positive reinforcement only. Socialize early — expose to people, sounds, surfaces."},
        {"role": "user", "content": "What food should I feed? And when do we start obedience classes?"},
    ],

    # Off-topic / casual
    "casual_greeting": [
        {"role": "user", "content": "Hey! Just joined the community. What's going on?"},
        {"role": "assistant", "content": "Welcome! There's a lot happening. We just released TMP for real-time matching, and the certification program is in beta."},
        {"role": "user", "content": "Cool. I'll look around."},
    ],
    "unrelated_question": [
        {"role": "user", "content": "What's the best pizza place in New York?"},
        {"role": "assistant", "content": "I'm focused on ad tech and the AdCP community, so I'm not the best pizza guide. But I hear Di Fara is legendary."},
        {"role": "user", "content": "Ha fair enough. OK what about header bidding?"},
    ],
}

# --- Realistic sponsor packages for Addie ---

PACKAGES = {
    # Identity / data providers
    "pkg-uid2": {
        "description": "UID2: Open-source identity framework for deterministic matching across channels. Cookie-free, privacy-preserving, interoperable.",
        "keywords": ["identity", "uid2", "cookies", "privacy", "deterministic", "matching"],
    },
    "pkg-id5": {
        "description": "ID5: Universal identity solution with probabilistic and deterministic matching. High match rates across web, mobile, and CTV.",
        "keywords": ["identity", "id5", "match-rate", "cross-device", "ctv", "probabilistic"],
    },
    "pkg-liveramp": {
        "description": "LiveRamp RampID: Identity resolution and data connectivity platform. Link consumer touchpoints across channels for people-based marketing.",
        "keywords": ["identity", "liveramp", "rampid", "data", "connectivity", "people-based"],
    },

    # Measurement / verification
    "pkg-scope3": {
        "description": "Scope3: Carbon emissions measurement and media quality analytics. Reduce waste, optimize supply paths, measure attention and sustainability.",
        "keywords": ["carbon", "sustainability", "emissions", "attention", "measurement", "quality"],
    },
    "pkg-ias": {
        "description": "IAS: Integral Ad Science for brand safety, viewability, and ad fraud detection. Pre-bid and post-bid verification across programmatic channels.",
        "keywords": ["brand-safety", "viewability", "fraud", "ivt", "verification", "programmatic"],
    },
    "pkg-doubleverify": {
        "description": "DoubleVerify: Digital media measurement and analytics. Brand safety, fraud protection, viewability, and attention metrics.",
        "keywords": ["verification", "brand-safety", "fraud", "attention", "measurement", "analytics"],
    },

    # Ad tech platforms
    "pkg-prebid": {
        "description": "Prebid: Open-source header bidding platform. Prebid.js for web, Prebid Server for server-side, Prebid Mobile for apps.",
        "keywords": ["prebid", "header-bidding", "open-source", "server-side", "programmatic", "ssp"],
    },
    "pkg-kevel": {
        "description": "Kevel: API-first ad serving for retail media, sponsored listings, and custom ad platforms. Build your own ad server.",
        "keywords": ["ad-server", "retail-media", "sponsored", "api", "custom", "listings"],
    },

    # Consulting / services
    "pkg-certification": {
        "description": "AdCP Certification: Industry certification program for ad tech professionals. Validate your knowledge of agentic advertising protocols.",
        "keywords": ["certification", "training", "education", "protocol", "adcp", "professional"],
    },

    # Consumer brands
    "pkg-olive-oil": {
        "description": "Meridian Foods: Premium extra virgin olive oil. Cold-pressed, single-origin Mediterranean. Perfect for cooking, pasta, salads.",
        "keywords": ["olive-oil", "cooking", "italian", "food", "mediterranean", "ingredients"],
    },
    "pkg-cookware": {
        "description": "Ironworks Kitchen: Professional cast iron and stainless steel cookware. Skillets, dutch ovens, sheet pans. Built to last.",
        "keywords": ["cookware", "kitchen", "cast-iron", "pans", "cooking", "equipment"],
    },
    "pkg-meal-kit": {
        "description": "FreshBox: Weekly meal kit delivery. Fresh ingredients, easy recipes, family-friendly options. Skip the grocery store.",
        "keywords": ["meal-kit", "delivery", "recipes", "dinner", "family", "groceries"],
    },
    "pkg-running-shoes": {
        "description": "StrideWell: Running shoes for every foot type. Stability, neutral, motion control. Free gait analysis. Flat feet specialists.",
        "keywords": ["running", "shoes", "fitness", "athletics", "flat-feet", "footwear"],
    },
    "pkg-fitness-app": {
        "description": "PulseFit: Personalized workout plans and fitness tracking. Home gym programs, running plans, nutrition guidance.",
        "keywords": ["fitness", "workout", "app", "training", "home-gym", "tracking"],
    },
    "pkg-travel-insurance": {
        "description": "SafeTrip: Comprehensive travel insurance. Medical coverage, trip cancellation, baggage protection. Covers Japan, Asia, worldwide.",
        "keywords": ["travel", "insurance", "medical", "cancellation", "international", "japan"],
    },
    "pkg-home-depot": {
        "description": "Home improvement supplies: Kitchen renovation, tile, countertops, cabinets, paint, hardware. DIY and professional grade.",
        "keywords": ["home", "renovation", "kitchen", "tile", "cabinets", "diy"],
    },
    "pkg-sleep-consultant": {
        "description": "Little Dreamers: Certified pediatric sleep consulting. Custom sleep plans for babies and toddlers. Virtual and in-person.",
        "keywords": ["sleep", "baby", "toddler", "consulting", "pediatric", "parenting"],
    },
    "pkg-brokerage": {
        "description": "Fidelity Investments: Zero-fee brokerage accounts. Index funds, IRAs, retirement planning. Start investing with any amount.",
        "keywords": ["investing", "brokerage", "index-funds", "ira", "retirement", "stocks"],
    },
    "pkg-ev-dealer": {
        "description": "ElectraDrive: Electric vehicle marketplace. Compare Tesla, Hyundai, Chevy EVs. Home charger installation included.",
        "keywords": ["electric", "vehicle", "ev", "tesla", "charging", "cars"],
    },
    "pkg-pet-food": {
        "description": "PawsNatural: Premium puppy and dog food. Vet-recommended, grain-free options. Golden retriever specific formulas.",
        "keywords": ["dog", "puppy", "food", "pet", "nutrition", "golden-retriever"],
    },

    # Off-topic control
    "pkg-cloud-hosting": {
        "description": "Cloud hosting provider: Scalable infrastructure for web applications, databases, and APIs. AWS alternative.",
        "keywords": ["cloud", "hosting", "infrastructure", "aws", "servers", "devops"],
    },
    "pkg-crm-software": {
        "description": "CRM software: Customer relationship management for sales teams. Pipeline tracking, email automation, deal management.",
        "keywords": ["crm", "sales", "pipeline", "email", "automation", "deals"],
    },
}

# Ground truth: best package for each conversation
GROUND_TRUTH = {
    # Ad tech
    "prebid_integration": "pkg-prebid",
    "identity_resolution": "pkg-uid2",
    "ctv_measurement": "pkg-scope3",
    "carbon_sustainability": "pkg-scope3",
    "retail_media_setup": "pkg-kevel",
    "brand_safety_ivt": "pkg-ias",
    "agency_pitch": None,  # General — no single best match
    "working_group": "pkg-certification",
    "certification_prep": "pkg-certification",
    # Consumer
    "cooking_carbonara": "pkg-olive-oil",
    "meal_planning": "pkg-meal-kit",
    "running_beginner": "pkg-running-shoes",
    "home_gym": "pkg-fitness-app",
    "japan_trip": "pkg-travel-insurance",
    "kitchen_reno": "pkg-home-depot",
    "toddler_sleep": "pkg-sleep-consultant",
    "investing_beginner": "pkg-brokerage",
    "electric_vehicle": "pkg-ev-dealer",
    "puppy_training": "pkg-pet-food",
    # Casual
    "casual_greeting": None,
    "unrelated_question": "pkg-prebid",
}

# Alternative acceptable answers
ACCEPTABLE = {
    "identity_resolution": {"pkg-uid2", "pkg-id5", "pkg-liveramp"},
    "brand_safety_ivt": {"pkg-ias", "pkg-doubleverify"},
    "ctv_measurement": {"pkg-scope3", "pkg-doubleverify"},
    "cooking_carbonara": {"pkg-olive-oil", "pkg-cookware"},
    "running_beginner": {"pkg-running-shoes", "pkg-fitness-app"},
    "home_gym": {"pkg-fitness-app", "pkg-running-shoes"},
    "japan_trip": {"pkg-travel-insurance"},
}

MODELS = [
    {
        "name": "nomic-ai/nomic-embed-text-v1.5",
        "matryoshka": True,
        "prefix_query": "search_query: ",
        "prefix_doc": "search_document: ",
        "native_dim": 768,
    },
    {
        "name": "sentence-transformers/all-MiniLM-L6-v2",
        "matryoshka": False,
        "prefix_query": "",
        "prefix_doc": "",
        "native_dim": 384,
    },
    {
        "name": "BAAI/bge-small-en-v1.5",
        "matryoshka": False,
        "prefix_query": "Represent this sentence for retrieving relevant passages: ",
        "prefix_doc": "",
        "native_dim": 384,
    },
]

DIMS_TO_TEST = [64, 128, 256, 384, 512, 768]


def format_conversation(messages, prefix=""):
    parts = []
    for msg in messages:
        role = "User" if msg["role"] == "user" else "Assistant"
        parts.append(f"{role}: {msg['content']}")
    return prefix + " | ".join(parts)


def embed(model, texts, dim=None):
    embeddings = model.encode(texts, convert_to_tensor=True)
    if dim and dim < embeddings.shape[1]:
        embeddings = F.layer_norm(embeddings, normalized_shape=(embeddings.shape[1],))
        embeddings = embeddings[:, :dim]
    embeddings = F.normalize(embeddings, p=2, dim=1)
    return embeddings.cpu().numpy()


def quantize_int8(emb):
    mx = np.max(np.abs(emb), axis=1, keepdims=True)
    mx = np.where(mx == 0, 1, mx)
    return (emb / mx * 127).astype(np.int8)


def cosine_sim(a, b):
    a, b = a.astype(np.float32), b.astype(np.float32)
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-10))


def evaluate(conv_emb, pkg_embeddings, pkg_ids, conv_name):
    scores = {}
    for i, pid in enumerate(pkg_ids):
        scores[pid] = cosine_sim(conv_emb, pkg_embeddings[i])
    ranked = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    top_pkg = ranked[0][0]
    top_score = ranked[0][1]

    expected = GROUND_TRUTH.get(conv_name)
    acceptable = ACCEPTABLE.get(conv_name, {expected} if expected else set())

    if expected is None:
        correct = top_score < 0.55  # Off-topic should have low scores
    else:
        correct = top_pkg in acceptable or top_pkg == expected

    return {
        "top_pkg": top_pkg,
        "top_score": top_score,
        "correct": correct,
        "ranked": ranked[:3],
    }


def main():
    pkg_ids = list(PACKAGES.keys())

    for model_config in MODELS:
        model_name = model_config["name"]
        print(f"\n{'=' * 70}")
        print(f"MODEL: {model_name}")
        print(f"{'=' * 70}")

        print(f"Loading...")
        start = time.time()
        model = SentenceTransformer(model_name, trust_remote_code=True)
        load_time = time.time() - start
        native_dim = model_config["native_dim"]
        print(f"Loaded in {load_time:.1f}s (native dim: {native_dim})")

        # Embed packages
        pkg_texts = [model_config["prefix_doc"] + p["description"] for p in PACKAGES.values()]

        # Test dimensions
        dims = [d for d in DIMS_TO_TEST if d <= native_dim]
        if native_dim not in dims:
            dims.append(native_dim)
        dims.sort()

        # Only test truncation if model supports Matryoshka
        if not model_config["matryoshka"]:
            dims = [native_dim]
            print(f"  (No Matryoshka — testing native dim only: {native_dim})")

        for dim in dims:
            pkg_embs = embed(model, pkg_texts, dim)

            for quant_name, quant_fn in [("float32", lambda x: x), ("int8", quantize_int8)]:
                pkg_q = quant_fn(pkg_embs)

                correct = 0
                total = 0
                times = []

                for conv_name, messages in CONVERSATIONS.items():
                    conv_text = format_conversation(messages, model_config["prefix_query"])

                    start = time.time()
                    conv_emb = embed(model, [conv_text], dim)[0]
                    elapsed = time.time() - start
                    times.append(elapsed * 1000)

                    conv_q = quant_fn(conv_emb.reshape(1, -1))[0]
                    result = evaluate(conv_q, pkg_q, pkg_ids, conv_name)

                    expected = GROUND_TRUTH.get(conv_name)
                    if expected is not None:
                        total += 1
                        if result["correct"]:
                            correct += 1

                accuracy = correct / total * 100 if total else 0
                avg_ms = np.mean(times)
                wire_bytes = dim if quant_name == "int8" else dim * 4

                print(f"  {dim:4d}d {quant_name:7s}: {correct}/{total} ({accuracy:5.1f}%)  avg {avg_ms:5.1f}ms  wire: {wire_bytes:5d}B")

        # Detailed results at best config
        best_dim = native_dim if not model_config["matryoshka"] else 256
        if best_dim > native_dim:
            best_dim = native_dim
        pkg_embs = embed(model, pkg_texts, best_dim)

        print(f"\n  Detailed results ({best_dim}d float32):")
        for conv_name, messages in CONVERSATIONS.items():
            conv_text = format_conversation(messages, model_config["prefix_query"])
            conv_emb = embed(model, [conv_text], best_dim)[0]
            result = evaluate(conv_emb, pkg_embs, pkg_ids, conv_name)
            expected = GROUND_TRUTH.get(conv_name, "none")
            mark = "✓" if result["correct"] else "✗"
            top3 = "  ".join(f"{p}={s:.3f}" for p, s in result["ranked"])
            print(f"    {mark} {conv_name:25s} → {top3}")

        del model
        torch.cuda.empty_cache() if torch.cuda.is_available() else None


if __name__ == "__main__":
    main()
