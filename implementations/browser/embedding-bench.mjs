/**
 * TMP Embedding Benchmark — TypeScript/Node.js
 *
 * Tests embedding models for ad-package matching using @huggingface/transformers.
 * Same models, same fixtures, same methodology as the Python benchmark.
 * This is the production-relevant benchmark since Addie runs on Node.js
 * and the browser demo uses the same library.
 */

import { pipeline } from '@huggingface/transformers';

// --- Models to test ---
const MODELS = [
  { name: 'Xenova/all-MiniLM-L6-v2', dims: 384, matryoshka: false },
  { name: 'Xenova/bge-small-en-v1.5', dims: 384, matryoshka: false },
  // nomic requires trust_remote_code which isn't supported in transformers.js
];

// --- Conversations (same as Python benchmark) ---
const CONVERSATIONS = {
  cooking_carbonara: [
    { role: 'user', content: "What's a good recipe for pasta carbonara?" },
    { role: 'assistant', content: 'Classic carbonara uses guanciale, eggs, pecorino romano, and spaghetti.' },
    { role: 'user', content: 'What kind of pan should I use?' },
  ],
  running_beginner: [
    { role: 'user', content: 'I want to start running. Any tips for a beginner?' },
    { role: 'assistant', content: 'Start with a couch to 5K program. Run 3 times a week.' },
    { role: 'user', content: 'What shoes do you recommend?' },
  ],
  investing_beginner: [
    { role: 'user', content: 'Should I invest in index funds or individual stocks?' },
    { role: 'assistant', content: 'For most people, index funds offer better diversification and lower fees.' },
    { role: 'user', content: "What's a Roth IRA?" },
  ],
  japan_trip: [
    { role: 'user', content: 'I want to travel to Japan. Where should I go?' },
    { role: 'assistant', content: 'Tokyo, Kyoto, and Osaka are the classic triangle. 14-day rail pass recommended.' },
    { role: 'user', content: 'What about food in Kyoto?' },
  ],
  electric_vehicle: [
    { role: 'user', content: "I'm thinking about buying an electric car. What should I consider?" },
    { role: 'assistant', content: 'Range, charging infrastructure, and total cost of ownership are the key factors.' },
    { role: 'user', content: 'How much does home charging cost?' },
  ],
  prebid_integration: [
    { role: 'user', content: "We're running Prebid Server and want to integrate with AdCP. Best approach?" },
    { role: 'assistant', content: 'Add the AdCP Prebid module to your Prebid Server instance.' },
    { role: 'user', content: 'How does it handle identity? We use UID2 and ID5.' },
  ],
  brand_safety: [
    { role: 'user', content: 'How do we handle brand safety in programmatic?' },
    { role: 'assistant', content: 'Pre-bid filtering with IAS or DoubleVerify catches most issues.' },
    { role: 'user', content: 'What about made-for-advertising sites?' },
  ],
  puppy_training: [
    { role: 'user', content: "We just got a golden retriever puppy. What should we know?" },
    { role: 'assistant', content: 'Crate training from day one, start socialization immediately.' },
    { role: 'user', content: 'What food do you recommend?' },
  ],
  weather_offtopic: [
    { role: 'user', content: "What's the weather like?" },
    { role: 'assistant', content: "I don't have real-time weather data." },
    { role: 'user', content: 'Tell me a joke.' },
  ],
};

// --- Packages (same as Python benchmark) ---
const PACKAGES = {
  'pkg-olive-oil': 'Premium extra virgin olive oil for Italian cooking, pasta recipes, Mediterranean cuisine',
  'pkg-cookware': 'Professional cast iron and stainless steel cookware, kitchen equipment, chef tools',
  'pkg-meal-kit': 'Weekly meal kit delivery with fresh ingredients, easy dinner recipes',
  'pkg-running-shoes': 'Lightweight running shoes, marathon training, athletic footwear',
  'pkg-fitness-app': 'Personalized workout plans, fitness tracking, exercise programming',
  'pkg-brokerage': 'Zero-fee investing, index funds, IRAs, retirement planning',
  'pkg-travel-insurance': 'Comprehensive travel insurance with medical evacuation coverage',
  'pkg-ev-dealer': 'Electric vehicle sales, EV charging solutions, test drives',
  'pkg-home-depot': 'Home improvement, renovation supplies, kitchen remodeling',
  'pkg-pet-food': 'Premium dog food, puppy nutrition, veterinary-recommended formulas',
  'pkg-sleep-consultant': 'Toddler sleep training, baby sleep schedules, family sleep solutions',
  'pkg-prebid': 'Open-source header bidding platform, publisher monetization',
  'pkg-ias': 'Brand safety verification, ad fraud detection, viewability measurement',
  'pkg-scope3': 'Carbon emissions measurement, attention metrics, sustainability',
  'pkg-uid2': 'Universal ID 2.0, deterministic identity, open-source identity solution',
  'pkg-id5': 'Probabilistic and deterministic identity resolution',
};

// Expected top match per conversation
const EXPECTED = {
  cooking_carbonara: 'pkg-olive-oil',
  running_beginner: 'pkg-running-shoes',
  investing_beginner: 'pkg-brokerage',
  japan_trip: 'pkg-travel-insurance',
  electric_vehicle: 'pkg-ev-dealer',
  prebid_integration: 'pkg-prebid',
  brand_safety: 'pkg-ias',
  puppy_training: 'pkg-pet-food',
  weather_offtopic: null, // No expected match
};

function formatConversation(messages) {
  return messages
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .join(' | ');
}

function cosineSim(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

function quantizeInt8(embedding) {
  const maxVal = Math.max(...embedding.map(Math.abs));
  return embedding.map(v => Math.round(v / maxVal * 127));
}

async function benchmarkModel(modelName, dims) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`MODEL: ${modelName} (${dims}d)`);
  console.log('='.repeat(60));

  const loadStart = performance.now();
  const embedder = await pipeline('feature-extraction', modelName, {
    quantized: true,
  });
  const loadTime = ((performance.now() - loadStart) / 1000).toFixed(1);
  console.log(`Loaded in ${loadTime}s`);

  // Embed all packages
  const pkgIds = Object.keys(PACKAGES);
  const pkgTexts = Object.values(PACKAGES);
  const pkgEmbeddings = {};

  for (let i = 0; i < pkgIds.length; i++) {
    const result = await embedder(pkgTexts[i], { pooling: 'mean', normalize: true });
    pkgEmbeddings[pkgIds[i]] = Array.from(result.data);
  }

  // Benchmark each conversation
  let correct = 0;
  let total = 0;
  const latencies = [];

  console.log('\n  Results:');

  for (const [convName, messages] of Object.entries(CONVERSATIONS)) {
    const convText = formatConversation(messages);

    // Measure latency (average of 5 runs)
    const times = [];
    let embedding;
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      const result = await embedder(convText, { pooling: 'mean', normalize: true });
      times.push(performance.now() - start);
      embedding = Array.from(result.data);
    }
    const avgMs = times.slice(1).reduce((a, b) => a + b, 0) / (times.length - 1);
    latencies.push(avgMs);

    // Score against all packages
    const scores = {};
    for (const [pkgId, pkgEmb] of Object.entries(pkgEmbeddings)) {
      scores[pkgId] = cosineSim(embedding, pkgEmb);
    }

    // Rank
    const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const expected = EXPECTED[convName];

    if (expected) {
      total++;
      const isCorrect = top[0] === expected;
      if (isCorrect) correct++;
      const marker = isCorrect ? '✓' : '✗';
      const gap = ranked[0][1] - ranked[1][1];
      console.log(`    ${marker} ${convName.padEnd(25)} → ${top[0].padEnd(22)} ${top[1].toFixed(3)}  gap=${gap.toFixed(3)}  ${avgMs.toFixed(0)}ms`);
    } else {
      console.log(`    - ${convName.padEnd(25)} → ${top[0].padEnd(22)} ${top[1].toFixed(3)}  (no expected match)  ${avgMs.toFixed(0)}ms`);
    }
  }

  const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const accuracy = total > 0 ? (correct / total * 100).toFixed(1) : 'N/A';

  console.log(`\n  Accuracy: ${correct}/${total} (${accuracy}%)`);
  console.log(`  Avg latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Wire size: ${dims} bytes (int8)`);

  // Int8 quality check
  const convText = formatConversation(CONVERSATIONS.cooking_carbonara);
  const floatEmb = (await embedder(convText, { pooling: 'mean', normalize: true }));
  const floatArr = Array.from(floatEmb.data);
  const int8Arr = quantizeInt8(floatArr);

  // Compare float vs int8 ranking
  const floatScores = {};
  const int8Scores = {};
  for (const [pkgId, pkgEmb] of Object.entries(pkgEmbeddings)) {
    floatScores[pkgId] = cosineSim(floatArr, pkgEmb);
    int8Scores[pkgId] = cosineSim(int8Arr, quantizeInt8(pkgEmb));
  }
  const diffs = Object.keys(floatScores).map(k => Math.abs(floatScores[k] - int8Scores[k]));
  const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
  console.log(`  Int8 quality loss: ${meanDiff.toFixed(4)} mean sim diff (${meanDiff < 0.01 ? 'negligible' : 'significant'})`);

  return { modelName, dims, accuracy: `${correct}/${total}`, avgLatency: avgLatency.toFixed(0), correct, total };
}

// --- Main ---
async function main() {
  console.log('TMP Embedding Benchmark — Node.js / @huggingface/transformers');
  console.log(`Runtime: Node.js ${process.version}`);
  console.log(`Platform: ${process.platform} ${process.arch}`);
  console.log('');

  const results = [];
  for (const model of MODELS) {
    const result = await benchmarkModel(model.name, model.dims);
    results.push(result);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log('');
  console.log('Model'.padEnd(30) + 'Accuracy'.padEnd(12) + 'Latency'.padEnd(10) + 'Wire');
  console.log('-'.repeat(62));
  for (const r of results) {
    console.log(
      `${r.modelName.padEnd(30)}${r.accuracy.padEnd(12)}${r.avgLatency.padEnd(10)}${r.dims}B`
    );
  }

  console.log(`\nRecommendation: ${results.sort((a, b) => b.correct - a.correct)[0].modelName}`);
}

main().catch(console.error);
