# TMP Embedding Benchmark

Can a 384-byte embedding vector reliably match a user conversation to the right ad package? We tested three models against 19 realistic conversations and 21 ad packages to find out.

## Results

| Model | Accuracy | Latency (int8) | Wire size | Browser ONNX |
|-------|----------|----------------|-----------|--------------|
| **all-MiniLM-L6-v2** | **100% (19/19)** | **22ms** | 384B | 23MB |
| bge-small-en-v1.5 | 95% (18/19) | 9ms | 384B | 34MB |
| nomic-embed-v1.5 (256d) | 89% (17/19) | 15ms | 256B | No ONNX |

**all-MiniLM-L6-v2 wins** on accuracy and browser model size. Score gaps are 2x wider than competitors, making threshold tuning easier.

Int8 quantization has negligible impact on ranking quality (mean similarity difference: 0.001).

## What we test

19 conversations spanning: ad tech (Prebid, identity, CTV, brand safety, carbon), consumer (cooking, fitness, travel, investing, home reno, pets, EVs, parenting), and edge cases (casual greetings, unrelated questions).

21 ad packages from: identity providers (UID2, ID5, LiveRamp), verification (IAS, DoubleVerify), ad tech platforms (Prebid, Kevel, Scope3), consumer brands (olive oil, cookware, meal kits, running shoes, fitness apps, travel insurance, home improvement, pet food, EV dealers, brokerages, sleep consultants), and professional services (certification, CRM, cloud hosting).

For each conversation, we embed it and rank all 21 packages by cosine similarity. A match is correct if the expected top package ranks #1.

## Running it

```bash
cd implementations/python/embedding-bench
uv sync
uv run python multi_model_bench.py     # all 3 models
uv run python bench.py                  # nomic-embed deep dive
uv run python compare_methods.py        # embedding vs keywords vs LLM
```

## How it works

1. Embed each conversation (user messages only, last 3 turns weighted 3x)
2. Embed each package description
3. Compute cosine similarity between conversation and all packages
4. Check if the expected package ranks #1

The embedding model runs on CPU. No GPU required. For browser deployment, the ONNX-quantized model loads once (23-34MB) and runs locally — conversation text never leaves the browser.

## Wire format for TMP

```json
{
  "context_signals": {
    "embedding": "base64-encoded-384-bytes...",
    "embedding_model": "all-MiniLM-L6-v2",
    "embedding_dims": 384
  }
}
```

384 bytes (int8 quantized) is smaller than the rest of the TMP context match request.

## Key findings

1. **100% accuracy is achievable** with all-MiniLM-L6-v2 at 384 dims
2. **Int8 quantization is safe** — negligible quality loss, halves wire size
3. **22ms per embedding on CPU** — within TMP's 50ms latency budget
4. **Score gaps matter more than absolute scores** — MiniLM produces 2x gaps between correct and next-best, making threshold tuning easy
5. **23MB browser model** — cached after first load, runs locally, no data leaves the browser
6. **Nomic's Matryoshka truncation to 256d costs 10% accuracy** — the savings (256B vs 384B) aren't worth it for ad targeting

## Contributing

Add conversations to `CONVERSATIONS` and packages to `PACKAGES` in `multi_model_bench.py`. PRs welcome for:
- Multilingual conversations
- Larger package sets (50+)
- Additional embedding models
- Production traffic analysis
