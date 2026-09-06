import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fixture from '../../../../src/addie/eval/matched-pair-ni/fixtures/published-lm-2008.json' with { type: 'json' };
import { divideWithRemainder, isZero, polynomial, polynomialAdd, polynomialMultiply, polynomialPow, polynomialScale } from '../../../../src/addie/eval/matched-pair-ni/polynomial.js';
import { interval, intervalDividePositive, isolateInteriorRoots, maximizePolynomial, sturmSequence } from '../../../../src/addie/eval/matched-pair-ni/algebraic.js';
import { denyMatchedPairNiPromotion, MATCHED_PAIR_NI_ADMISSION, matchedPairNiAdmission } from '../../../../src/addie/eval/matched-pair-ni/admission.js';
import {
  conditionalMcNemarPValue,
  enumerateReducedStates,
  matchedPairNiSupport,
  nullBoundarySizeEnvelope,
  MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD,
  parseMatchedPairNiDecimal,
  reducedStateProbabilityPolynomial,
  restrictedPhiInterval,
  restrictedScoreEM,
} from '../../../../src/addie/eval/matched-pair-ni/engine.js';
import { abs, add, choose, compare, decimal, display, divide, midpoint, negate, pow, rational, subtract, ONE, TWO, ZERO } from '../../../../src/addie/eval/matched-pair-ni/rational.js';

describe('Lloyd--Moldovan restricted-score E+M diagnostic', () => {
  const margin = parseMatchedPairNiDecimal('0.10');
  const alpha = parseMatchedPairNiDecimal('0.05');

  function expectsHostileConstructorToTerminate(expression: string): void {
    const moduleUrl = new URL('../../../../src/addie/eval/matched-pair-ni/rational.ts', import.meta.url).href;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval',
      `import { canonicalRational, decimal, rational } from ${JSON.stringify(moduleUrl)}; try { ${expression}; process.exit(2); } catch { process.exit(0); }`,
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 2_000 });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  function expectsPoisonedPrototypeToTerminate(source: string): void {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 3_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  function expectsAlgebraicPoisonMatrixToTerminate(algebraicUrl: string, rationalUrl: string, loader: readonly string[]): void {
    const calls = [
      'sturmSequence([ONE, ONE])',
      'isolateInteriorRoots([ZERO, ONE], ZERO, ONE, 24)',
      'maximizePolynomial([negate(rational(1, 4)), ONE, negate(ONE)], ZERO, ONE, 24)',
    ];
    const poisons = [
      "Object.defineProperty(Array.prototype, 'map', { value() { for (;;) {} }, configurable: true })",
      "Object.defineProperty(Array.prototype, Symbol.iterator, { value() { for (;;) {} }, configurable: true })",
    ];
    for (let poisonIndex = 0; poisonIndex < poisons.length; poisonIndex++) for (let callIndex = 0; callIndex < calls.length; callIndex++) {
      const source = `import { sturmSequence, isolateInteriorRoots, maximizePolynomial } from ${JSON.stringify(algebraicUrl)};
        import { ONE, ZERO, negate, rational } from ${JSON.stringify(rationalUrl)};
        ${poisons[poisonIndex]!}; ${calls[callIndex]!}; process.exit(0);`;
      const result = spawnSync(process.execPath, [...loader, '--input-type=module', '--eval', source], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 2_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    }
  }

  function expectsWorkerInternalsToBeUnimportable(): void {
    const algebraicUrl = new URL('../../../../src/addie/eval/matched-pair-ni/algebraic.ts', import.meta.url).href;
    const engineUrl = new URL('../../../../src/addie/eval/matched-pair-ni/engine.ts', import.meta.url).href;
    const moduleProbe = `import * as algebraic from ${JSON.stringify(algebraicUrl)}; import * as engine from ${JSON.stringify(engineUrl)};
      const forbidden = ['isolateEngineInteriorRoots', 'restrictedScoreEMWorker', 'nullBoundarySizeEnvelopeWorker'];
      if (forbidden.some((name) => name in algebraic || name in engine)) process.exit(2);`;
    const workerProbe = `import { parentPort } from 'node:worker_threads'; import * as algebraic from ${JSON.stringify(algebraicUrl)}; import * as engine from ${JSON.stringify(engineUrl)};
      const forbidden = ['isolateEngineInteriorRoots', 'restrictedScoreEMWorker', 'nullBoundarySizeEnvelopeWorker'];
      parentPort.postMessage(forbidden.some((name) => name in algebraic || name in engine));`;
    const source = `${moduleProbe}
      import { Worker } from 'node:worker_threads';
      const worker = new Worker(${JSON.stringify(workerProbe)}, { eval: true, type: 'module', execArgv: ['--import', 'tsx'] });
      const timer = setTimeout(() => process.exit(3), 2_000);
      worker.once('message', (forbidden) => { clearTimeout(timer); process.exit(forbidden ? 2 : 0); });
      worker.once('error', () => { clearTimeout(timer); process.exit(3); });`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 3_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  function expectsMarkerOnlyWorkerToBeDenied(): void {
    const engineUrl = new URL('../../../../src/addie/eval/matched-pair-ni/engine.ts', import.meta.url).href;
    const source = `import { Worker } from 'node:worker_threads';
      const worker = new Worker(new URL(${JSON.stringify(engineUrl)}), { workerData: { exactMatchedPairNiWorker: true, task: 'restricted_score', payload: { counts: { n11: 1, n10: 0, n01: 0, n00: 0 }, margin: { numerator: 0n, denominator: 1n }, alpha: { numerator: 1n, denominator: 20n } } }, execArgv: ['--import', 'tsx'] });
      const timer = setTimeout(() => process.exit(3), 2_000);
      worker.once('message', () => { clearTimeout(timer); process.exit(2); });
      worker.once('exit', () => { clearTimeout(timer); process.exit(0); });`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 3_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  /** A caller can create its own port/marker; the intrinsic preflight, not
   * that marker, must make recreated expensive activation conservative. */
  function expectsRecreatedWorkerToPreflightCostlyTasks(): void {
    const engineUrl = new URL('../../../../src/addie/eval/matched-pair-ni/engine.ts', import.meta.url).href;
    const source = `import { MessageChannel, Worker } from 'node:worker_threads';
      const run = (margin) => new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const worker = new Worker(new URL(${JSON.stringify(engineUrl)}), {
          workerData: { exactMatchedPairNiWorker: true, task: 'restricted_score', authorizationPort: channel.port2,
            payload: { counts: { n11: 22, n10: 3, n01: 0, n00: 0 }, margin, alpha: { numerator: 1n, denominator: 20n } } },
          transferList: [channel.port2], execArgv: ['--import', 'tsx'],
        });
        const timer = setTimeout(() => reject(new Error('worker timed out')), 1_500);
        channel.port1.once('message', () => channel.port1.postMessage('exact_matched_pair_ni_authorized'));
        worker.once('message', (message) => { clearTimeout(timer); worker.terminate(); resolve(message?.ok === true && message.value?.diagnostic?.indeterminate?.reason === 'complexity_ceiling'); });
        worker.once('error', reject);
      });
      if (!await run({ numerator: 32767n, denominator: 32768n })) process.exit(2);
      if (!await run({ numerator: 1n, denominator: 1n << 255n })) process.exit(2);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 3_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  function expectsBuiltPathToRetainRootAndWorkerBounds(): void {
    const output = mkdtempSync(join(tmpdir(), 'matched-ni-built-'));
    try {
      const compilation = spawnSync('npx', ['tsc', '--project', 'server/tsconfig.json', '--outDir', output, '--noEmit', 'false'], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 20_000,
      });
      expect(compilation.error).toBeUndefined();
      expect(compilation.status).toBe(0);
      const probe = `import { MessageChannel, Worker } from 'node:worker_threads';
        const base = \`file://\${process.env.MATCHED_NI_BUILD_DIR}/addie/eval/matched-pair-ni/\`;
        const { isolateInteriorRoots } = await import(\`\${base}algebraic.js\`);
        const { polynomial, polynomialMultiply } = await import(\`\${base}polynomial.js\`);
        const { ONE, ZERO, negate, rational } = await import(\`\${base}rational.js\`);
        let value = polynomial([ONE]);
        for (let index = 1; index <= 25; index++) value = polynomialMultiply(value, [negate(rational(index, 26)), ONE]);
        if (!isolateInteriorRoots(value, ZERO, ONE, 24).unresolved || !isolateInteriorRoots(polynomial([rational(1n << 513n), ONE]), ZERO, ONE, 24).unresolved) process.exit(2);
        const channel = new MessageChannel();
        const worker = new Worker(new URL(\`\${base}engine.js\`), { workerData: { exactMatchedPairNiWorker: true, task: 'restricted_score', authorizationPort: channel.port2, payload: { counts: { n11: 22, n10: 3, n01: 0, n00: 0 }, margin: { numerator: 32767n, denominator: 32768n }, alpha: { numerator: 1n, denominator: 20n } } }, transferList: [channel.port2], execArgv: [] });
        const reply = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('timeout')), 1_500); channel.port1.once('message', () => channel.port1.postMessage('exact_matched_pair_ni_authorized')); worker.once('message', (message) => { clearTimeout(timer); resolve(message); }); worker.once('error', reject); });
        await worker.terminate();
        process.exit(reply?.ok === true && reply.value?.diagnostic?.indeterminate?.reason === 'complexity_ceiling' ? 0 : 2);`;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 3_000,
        env: { ...process.env, MATCHED_NI_BUILD_DIR: output },
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
      expectsAlgebraicPoisonMatrixToTerminate(
        `file://${output}/addie/eval/matched-pair-ni/algebraic.js`,
        `file://${output}/addie/eval/matched-pair-ni/rational.js`, [],
      );
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }

  function expectsRootIsolationToTerminate(): void {
    const algebraicUrl = new URL('../../../../src/addie/eval/matched-pair-ni/algebraic.ts', import.meta.url).href;
    const polynomialUrl = new URL('../../../../src/addie/eval/matched-pair-ni/polynomial.ts', import.meta.url).href;
    const rationalUrl = new URL('../../../../src/addie/eval/matched-pair-ni/rational.ts', import.meta.url).href;
    const source = `import { isolateInteriorRoots } from ${JSON.stringify(algebraicUrl)};
      import { polynomial, polynomialMultiply } from ${JSON.stringify(polynomialUrl)};
      import { ONE, ZERO, negate, rational } from ${JSON.stringify(rationalUrl)};
      let value = polynomial([ONE]);
      for (let index = 1; index <= 25; index++) value = polynomialMultiply(value, [negate(rational(index, 26)), ONE]);
      if (!isolateInteriorRoots(value, ZERO, ONE, 24).unresolved) process.exit(2);
      process.exit(isolateInteriorRoots(polynomial([rational(1n << 513n), ONE]), ZERO, ONE, 24).unresolved ? 0 : 2);`;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
      cwd: process.cwd(), encoding: 'utf8', timeout: 5_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(0);
  }

  function expectsColdWorkerFixtureToBeDeterminate(): void {
    const engineUrl = new URL('../../../../src/addie/eval/matched-pair-ni/engine.ts', import.meta.url).href;
    for (let attempt = 0; attempt < 3; attempt++) {
      const source = `import { restrictedScoreEM, parseMatchedPairNiDecimal as d } from ${JSON.stringify(engineUrl)};
        const outcome = await restrictedScoreEM({ counts: { n11: 23, n10: 2, n01: 0, n00: 0 }, margin: d("0.10"), alpha: d("0.05") });
        process.exit(outcome.diagnostic.indeterminate ? 2 : 0);`;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
        cwd: process.cwd(), encoding: 'utf8', timeout: 25_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status).toBe(0);
    }
  }

  it('reproduces the published n=25, x=2, t=2 score E+M fixture to four decimals', async () => {
    expect(fixture.schema_version).toBe(1);
    expect(fixture.provenance.kind).toBe('published_claim_pending_independent_reference_match');
    expect(fixture.margin).toMatch(/^0\.[0-9]+$/);
    expect(fixture.reported_p_value).toMatch(/^0\.[0-9]+$/);
    expect(fixture.counts.x + (fixture.counts.t - fixture.counts.x)).toBe(fixture.counts.t);
    const fixtureMargin = parseMatchedPairNiDecimal(fixture.margin);
    const reported = decimal(fixture.reported_p_value);
    const fourDecimalHalfUnit = decimal('0.00005');
    const outcome = await restrictedScoreEM({
      counts: {
        n11: fixture.counts.n - fixture.counts.t, n10: fixture.counts.x,
        n01: fixture.counts.t - fixture.counts.x, n00: 0,
      }, margin: fixtureMargin, alpha,
    });
    expect(outcome.diagnostic.indeterminate).toBeUndefined();
    expect(outcome.diagnostic.statisticalRejectNull).toBe(true);
    expect(outcome.admission.admitted).toBe(false);
    expect(compare(outcome.diagnostic.pValue.lower, subtract(reported, fourDecimalHalfUnit))).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.upper, add(reported, fourDecimalHalfUnit))).toBeLessThan(0);
    expect(outcome.diagnostic.certificate?.evaluatedEndpoints).toBe(true);
    expect(outcome.diagnostic.certificate?.maximization).toBe('rational_sturm_and_interval_bisection');
  }, 30_000);

  it('repeats the published fixture in killable cold worker processes', () => {
    expectsColdWorkerFixtureToBeDeterminate();
  }, 80_000);

  it('routes an exactly zero margin only to exact conditional McNemar', async () => {
    const outcome = await restrictedScoreEM({
      counts: { n11: 2, n10: 2, n01: 1, n00: 3 }, margin: ZERO, alpha,
    });
    expect(outcome.mode).toBe('conditional_mcnemar_zero_margin');
    expect(outcome.diagnostic.pValue.lower).toEqual(conditionalMcNemarPValue({ n: 8, x: 2, t: 3 }));
    expect(() => nullBoundarySizeEnvelope(2, ZERO, alpha)).toThrow(/Zero margin/);
  });

  it('handles zero discordance and rejects malformed/infeasible inputs', async () => {
    expect((await restrictedScoreEM({ counts: { n11: 3, n10: 0, n01: 0, n00: 2 }, margin, alpha })).diagnostic.pValue.upper).toBeDefined();
    expect(() => restrictedScoreEM({ counts: { n11: 0, n10: -1, n01: 1, n00: 1 }, margin, alpha })).toThrow(/nonnegative/);
    expect(() => restrictedScoreEM({ counts: { n11: 0, n10: 26, n01: 0, n00: 0 }, margin, alpha })).toThrow(/\[1, 25\]/);
    expect(() => restrictedScoreEM({
      counts: { n11: 1, n10: 0, n01: 0, n00: 0 }, alpha,
      margin: { numerator: 1n << 257n, denominator: 1n },
    })).toThrow(/256-bit/);
    expect(() => enumerateReducedStates(100_000)).toThrow(/n in \[1, 25\]/);
    expect(() => restrictedPhiInterval({ n: 5, x: 6, t: 5 }, margin)).toThrow(/0 <= x <= t <= n/);
    expect(() => isolateInteriorRoots([ONE, ONE], ZERO, ONE, -1)).toThrow(/\[1, 24\]/);
    expect(() => interval({ numerator: 2n, denominator: 2n }, ONE)).toThrow(/normalized/);
    expect(() => polynomial([{ numerator: 2n, denominator: 2n }])).toThrow(/normalized/);
    expect(() => abs({ numerator: 2n, denominator: 2n })).toThrow(/normalized/);
    expect(() => display({ numerator: 2n, denominator: 2n })).toThrow(/normalized/);
    expect(() => abs({ numerator: 1n, denominator: -1n })).toThrow(/ceiling/);
    expect(() => display({ numerator: 1n << 8_193n, denominator: 1n })).toThrow(/ceiling/);
    expect(() => isZero([ZERO, ZERO])).toThrow(/canonical/);
    expect(() => sturmSequence([ZERO, ZERO])).toThrow(/canonical/);
    expect(() => divideWithRemainder([ONE], [ZERO, ZERO])).toThrow(/canonical/);
    expect(() => isolateInteriorRoots([ZERO], ZERO, ONE, -1)).toThrow(/\[1, 24\]/);
    expect(() => isolateInteriorRoots(Array.from({ length: 27 }, () => ONE), ZERO, ONE)).toThrow(/degree/);
    expect(() => isolateInteriorRoots([{ numerator: 2n, denominator: 2n }], ZERO, ONE)).toThrow(/normalized/);
    expect(() => isolateInteriorRoots([ONE, ONE], ZERO, ONE, 25)).toThrow(/\[1, 24\]/);
    expect(isolateInteriorRoots([ZERO], ZERO, ONE).unresolved).toBe(false);
  });

  it('rejects accessors and Proxies before snapshotting an exact certificate input', () => {
    const getterInput = {
      counts: { n11: 3, n10: 1, n01: 0, n00: 1 },
      get margin(): never { throw new Error('getter must not execute'); }, alpha,
    };
    expect(() => restrictedScoreEM(getterInput)).toThrow(/accessors/);
    expect(() => restrictedScoreEM(new Proxy({
      counts: { n11: 3, n10: 1, n01: 0, n00: 1 }, margin, alpha,
    }, {}))).toThrow(/Proxy/);
    expect(() => maximizePolynomial(new Proxy([ZERO, ONE], {}), ZERO, ONE)).toThrow(/Proxy/);
    expect(() => interval(new Proxy({ numerator: 1n, denominator: 2n }, {}), ONE)).toThrow(/Proxy/);
  });

  it('does not export worker-only expensive cores to direct imports', () => {
    expectsWorkerInternalsToBeUnimportable();
    expectsMarkerOnlyWorkerToBeDenied();
    expectsRecreatedWorkerToPreflightCostlyTasks();
    expectsBuiltPathToRetainRootAndWorkerBounds();
  });

  it('terminates hostile scalar constructors without property access or coercion', () => {
    expectsHostileConstructorToTerminate('decimal({ get length() { for (;;) {} } })');
    expectsHostileConstructorToTerminate('rational({ [Symbol.toPrimitive]() { for (;;) {} } })');
    expectsHostileConstructorToTerminate('canonicalRational({ numerator: 1n, denominator: 2n }, { [Symbol.toPrimitive]() { for (;;) {} } })');
  }, 5_000);

  it('never dispatches descriptor snapshots through poisoned prototype setters', () => {
    const rationalUrl = new URL('../../../../src/addie/eval/matched-pair-ni/rational.ts', import.meta.url).href;
    expectsPoisonedPrototypeToTerminate(`import { canonicalRational } from ${JSON.stringify(rationalUrl)};
      Object.defineProperty(Object.prototype, 'numerator', { set() { for (;;) {} }, configurable: true });
      process.exit(canonicalRational({ numerator: 1n, denominator: 2n }).numerator === 1n ? 0 : 2);`);
    const engineUrl = new URL('../../../../src/addie/eval/matched-pair-ni/engine.ts', import.meta.url).href;
    expectsPoisonedPrototypeToTerminate(`import { restrictedScoreEM, parseMatchedPairNiDecimal as d } from ${JSON.stringify(engineUrl)};
      Object.defineProperty(Object.prototype, 'counts', { set() { for (;;) {} }, configurable: true });
      const outcome = await restrictedScoreEM({ counts: { n11: 1, n10: 1, n01: 0, n00: 0 }, margin: d('0.10'), alpha: d('0.05') });
      process.exit(outcome.admission.admitted ? 2 : 0);`);
  }, 7_000);

  it('does not invoke poisoned Array prototype map or iterator after snapshotting', () => {
    const polynomialUrl = new URL('../../../../src/addie/eval/matched-pair-ni/polynomial.ts', import.meta.url).href;
    const rationalUrl = new URL('../../../../src/addie/eval/matched-pair-ni/rational.ts', import.meta.url).href;
    expectsPoisonedPrototypeToTerminate(`import { polynomial, degree } from ${JSON.stringify(polynomialUrl)}; import { ONE, ZERO } from ${JSON.stringify(rationalUrl)};
      Object.defineProperty(Array.prototype, 'map', { value() { for (;;) {} }, configurable: true });
      process.exit(degree(polynomial([ONE, ZERO])) === 0 ? 0 : 2);`);
    expectsPoisonedPrototypeToTerminate(`import { polynomial, degree } from ${JSON.stringify(polynomialUrl)}; import { ONE, ZERO } from ${JSON.stringify(rationalUrl)};
      Object.defineProperty(Array.prototype, Symbol.iterator, { value() { for (;;) {} }, configurable: true });
      process.exit(degree(polynomial([ONE, ZERO])) === 0 ? 0 : 2);`);
    expectsPoisonedPrototypeToTerminate(`import { canonicalRational } from ${JSON.stringify(rationalUrl)};
      Object.defineProperty(Array.prototype, Symbol.iterator, { value() { for (;;) {} }, configurable: true });
      process.exit(canonicalRational({ numerator: 1n, denominator: 2n }).numerator === 1n ? 0 : 2);`);
  }, 7_000);

  it('keeps all exported algebraic root helpers off poisoned Array prototypes in source and emitted builds', () => {
    expectsAlgebraicPoisonMatrixToTerminate(
      new URL('../../../../src/addie/eval/matched-pair-ni/algebraic.ts', import.meta.url).href,
      new URL('../../../../src/addie/eval/matched-pair-ni/rational.ts', import.meta.url).href,
      ['--import', 'tsx'],
    );
  }, 20_000);

  it('divides signed intervals outward over a strictly positive divisor', () => {
    expect(intervalDividePositive(interval(rational(-2), rational(-1)), interval(ONE, rational(2)))).toEqual(interval(rational(-2), rational(-1, 2)));
    expect(intervalDividePositive(interval(rational(-2), rational(1)), interval(ONE, rational(2)))).toEqual(interval(rational(-2), ONE));
    expect(intervalDividePositive(interval(ONE, rational(2)), interval(ONE, rational(2)))).toEqual(interval(rational(1, 2), rational(2)));
    expect(intervalDividePositive(interval(rational(-2), rational(-1)), interval(rational(2), rational(2)))).toEqual(interval(rational(-1), rational(-1, 2)));
    expect(() => intervalDividePositive(interval(ONE, ONE), interval(ZERO, ONE))).toThrow(/positive/);
    expect(() => intervalDividePositive(interval(ONE, ONE), interval(rational(-1), ONE))).toThrow(/positive/);
  });

  it('returns unresolved before the killable root-isolation process deadline', () => {
    expectsRootIsolationToTerminate();
  }, 6_000);

  it('snapshots aliases into immutable values before certification', () => {
    const shared = { numerator: 1n, denominator: 2n };
    const snapped = interval(shared, shared);
    shared.numerator = 0n;
    expect(snapped.lower).toEqual(rational(1, 2));
    expect(snapped.upper).toEqual(rational(1, 2));
  });

  it('exhaustively reduces four-cell null probabilities for every small table', () => {
    const n = 4;
    for (const state of enumerateReducedStates(n)) {
      let fourCell = [ZERO];
      for (let n11 = 0; n11 <= n - state.t; n11++) {
        const n00 = n - state.t - n11;
        const coefficient = rational(choose(n, n11) * choose(n - n11, state.x) * choose(n - n11 - state.x, state.t - state.x));
        const term = polynomialScale(polynomialMultiply(
          polynomialMultiply(polynomialPow([negate(margin), ONE], state.x), polynomialPow([margin, ONE], state.t - state.x)),
          polynomialPow([ONE, negate(ONE)], n11 + n00),
        ), divide(coefficient, pow(TWO, n)));
        fourCell = polynomialAdd(fourCell, term);
      }
      // Compare every normalized coefficient, not samples, so this asserts
      // polynomial equality for the entire nuisance interval.
      expect(fourCell).toEqual(reducedStateProbabilityPolynomial(state, margin));
    }
  });

  it('certifies a practical small-n/margin/alpha null-boundary matrix continuously', async () => {
    for (const [n, candidateMargin, candidateAlpha] of [[3, '0.10', '0.05'], [4, '0.10', '0.05'], [3, '0.20', '0.10']] as const) {
      const parsedMargin = decimal(candidateMargin);
      const parsedAlpha = decimal(candidateAlpha);
      const size = await nullBoundarySizeEnvelope(n, parsedMargin, parsedAlpha);
      expect(size.status).toBe('certified');
      const certificate = maximizePolynomial(size.upper, parsedMargin, ONE);
      expect(certificate.indeterminate).toBe(false);
      expect(compare(certificate.upper, parsedAlpha)).toBeLessThanOrEqual(0);
    }
  });

  it('sentinels require both endpoints and stationary points in maximization', () => {
    const endpointOnly = maximizePolynomial([ZERO, ONE], margin, ONE);
    expect(compare(endpointOnly.lower, rational(1))).toBe(0);
    // -(x - 1/2)^2 is zero only at its interior stationary maximum.
    const interiorOnly = maximizePolynomial([negate(rational(1, 4)), ONE, negate(ONE)], ZERO, ONE);
    expect(compare(interiorOnly.lower, ZERO)).toBe(0);
    expect(interiorOnly.stationaryPointCount).toBeGreaterThan(0);
  });

  it('finds the published-review repeated-endpoint Sturm counterexample interior maximum', async () => {
    const outcome = await restrictedScoreEM({
      counts: { n11: 1, n10: 3, n01: 0, n00: 0 }, margin: decimal('0.07'), alpha,
    });
    expect(outcome.diagnostic.statisticalRejectNull).toBe(false);
    expect(outcome.diagnostic.certificate?.stationaryPointCount).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.lower, decimal('0.05888'))).toBeGreaterThan(0);
    expect(compare(outcome.diagnostic.pValue.upper, decimal('0.05889'))).toBeLessThan(0);
  });

  it('matches the independent n=5,m=.20 tie and size-oracle regression', async () => {
    const tieCases = [[2, 2], [3, 3], [4, 4], [5, 5]] as const;
    for (const [x, t] of tieCases) {
      const outcome = await restrictedScoreEM({
        counts: { n11: 5 - t, n10: x, n01: t - x, n00: 0 }, margin: decimal('0.20'), alpha,
      });
      expect(outcome.diagnostic.indeterminate).toBeUndefined();
      expect(outcome.diagnostic.statisticalRejectNull).toBe(true);
    }
    const size = await nullBoundarySizeEnvelope(5, decimal('0.20'), alpha);
    expect(size.status).toBe('certified');
    expect(size.indeterminateStates).toEqual([]);
    const maximum = maximizePolynomial(size.upper, decimal('0.20'), ONE);
    expect(compare(maximum.lower, decimal('0.04192'))).toBeGreaterThan(0);
    expect(compare(maximum.upper, decimal('0.0420'))).toBeLessThan(0);
  });

  it('returns an explicitly indeterminate envelope at the size-work ceiling', async () => {
    const size = await nullBoundarySizeEnvelope(9, margin, alpha);
    expect(size.status).toBe('indeterminate');
    expect(size.reason).toBe('size_complexity_ceiling');
    expect(size.indeterminateStates).toHaveLength(55);
  });

  it('converts an accepted precision that exceeds algebraic work bounds into indeterminacy', async () => {
    const tinyMargin = decimal(`0.${'0'.repeat(74)}1`);
    const envelope = await nullBoundarySizeEnvelope(8, tinyMargin, alpha);
    expect(envelope.status).toBe('indeterminate');
    expect(envelope.reason).toBe('size_complexity_ceiling');
  });

  it('preflights a legal 256-bit margin before n=25 algebraic work', async () => {
    const outcome = await restrictedScoreEM({
      counts: { n11: 23, n10: 2, n01: 0, n00: 0 }, margin: rational(1n, 1n << 255n), alpha,
    });
    expect(outcome.diagnostic.indeterminate?.reason).toBe('complexity_ceiling');
    expect(outcome.diagnostic.alphaDecision).toBe('indeterminate_alpha_overlap');
  });

  it('preflights high-precision n=8 size inputs before exhaustive work', async () => {
    for (const bits of [17, 128, 129]) {
      const denominator = 1n << BigInt(bits - 1);
      const outcome = await nullBoundarySizeEnvelope(8, rational(denominator - 1n, denominator), alpha);
      expect(outcome.status).toBe('indeterminate');
      expect(outcome.reason).toBe('size_complexity_ceiling');
    }
    const boundaryDenominator = 1n << 15n;
    const withinBoundary = await nullBoundarySizeEnvelope(8, rational(boundaryDenominator - 1n, boundaryDenominator), alpha);
    expect(withinBoundary.reason).not.toBe('size_complexity_ceiling');
  });

  it('uses the aggregate work estimate to fail closed before a costly n=25 call', async () => {
    const denominator = 1n << 15n;
    const outcome = await restrictedScoreEM({
      counts: { n11: 22, n10: 3, n01: 0, n00: 0 }, margin: rational(denominator - 1n, denominator), alpha,
    });
    expect(outcome.diagnostic.indeterminate?.reason).toBe('complexity_ceiling');
  });

  it('exposes one joint support predicate instead of a Cartesian ceiling claim', () => {
    expect(matchedPairNiSupport('inference', 25, margin)).toMatchObject({ supported: true, reason: 'supported', estimatedWorkUnits: 492_804 });
    expect(matchedPairNiSupport('inference', 25, rational(32767, 32768))).toMatchObject({ supported: false, reason: 'aggregate_work_ceiling' });
    expect(matchedPairNiSupport('null_boundary_size', 9, margin)).toMatchObject({ supported: false, reason: 'size_n_ceiling' });
    expect(matchedPairNiSupport('null_boundary_size', 8, rational(32767, 32768))).toMatchObject({ supported: true, reason: 'supported' });
  });

  it('does not accept a caller-provided maximum enclosure callback', () => {
    const cubic = [ZERO, rational(2), ZERO, negate(ONE)] as const;
    const honest = maximizePolynomial(cubic, ZERO, ONE);
    const withForgedExtraArgument = (maximizePolynomial as unknown as (...args: unknown[]) => typeof honest)(
      cubic, ZERO, ONE, 24, () => interval(rational(100), rational(100)),
    );
    expect(compare(honest.upper, rational(11, 10))).toBeLessThan(0);
    expect(withForgedExtraArgument).toEqual(honest);
  });

  it('keeps engine ambiguity distinct from a determinate alpha overlap in size envelopes', async () => {
    const ambiguous = await nullBoundarySizeEnvelope(2, decimal('0.20'), alpha);
    expect(ambiguous.status).toBe('indeterminate');
    expect(ambiguous.reason).toBe('ambiguous_e_ordering');
    expect(ambiguous.alphaOverlapStates).toEqual([]);
    expect(ambiguous.engineIndeterminacy).toEqual(expect.arrayContaining([
      expect.objectContaining({ reason: 'ambiguous_e_ordering' }),
    ]));
  });

  it('conservatively propagates a real overlapping p-value matrix into upper envelopes', async () => {
    for (const fixtureCase of [
      { counts: { n11: 1, n10: 3, n01: 0, n00: 0 }, n: 4, x: 3, t: 3, margin: decimal('0.07') },
      { counts: { n11: 3, n10: 2, n01: 0, n00: 0 }, n: 5, x: 2, t: 2, margin: decimal('0.20') },
    ]) {
      const p = (await restrictedScoreEM({ counts: fixtureCase.counts, margin: fixtureCase.margin, alpha })).diagnostic.pValue;
      const uncertain = await nullBoundarySizeEnvelope(fixtureCase.n, fixtureCase.margin, midpoint(p.lower, p.upper));
      expect(uncertain.status).toBe('indeterminate');
      expect(uncertain.reason).toBe('overlapping_p_value');
      expect(uncertain.engineIndeterminacy).toEqual([]);
      expect(uncertain.alphaOverlapStates).toContainEqual({ n: fixtureCase.n, x: fixtureCase.x, t: fixtureCase.t });
      expect(uncertain.indeterminateStates).toContainEqual({ n: fixtureCase.n, x: fixtureCase.x, t: fixtureCase.t });
      expect((await restrictedScoreEM({ counts: fixtureCase.counts, margin: fixtureCase.margin, alpha: midpoint(p.lower, p.upper) })).diagnostic.alphaDecision).toBe('indeterminate_alpha_overlap');
    }
  });

  it('has a hard-coded, non-overridable non-admission declaration', () => {
    expect(matchedPairNiAdmission()).toBe(MATCHED_PAIR_NI_ADMISSION);
    expect(MATCHED_PAIR_NI_ADMISSION.admitted).toBe(false);
    expect(MATCHED_PAIR_NI_ADMISSION.reasons).toEqual(expect.arrayContaining([
      'missing_independent_reference_match', 'continuous_type_i_certificate_review_required',
      'supported_n_has_no_confirmatory_sample_size_validation', 'unvalidated_adaptive_reestimation',
    ]));
  });

  it('has no promotion-shaped result field and always denies a promotion consumer', async () => {
    const diagnostic = await restrictedScoreEM({ counts: { n11: 3, n10: 1, n01: 0, n00: 1 }, margin, alpha });
    expect(Object.hasOwn(diagnostic, 'reject')).toBe(false);
    expect(Object.hasOwn(diagnostic, 'decision')).toBe(false);
    expect(MATCHED_PAIR_NI_NO_ROOT_PROMOTION_FIELD).toBe(true);
    expect(denyMatchedPairNiPromotion(diagnostic)).toBe(MATCHED_PAIR_NI_ADMISSION);
    expect(denyMatchedPairNiPromotion(diagnostic).admitted).toBe(false);
  });

  it('rehydrates worker evidence into immutable canonical diagnostic values', async () => {
    const diagnostic = await restrictedScoreEM({ counts: { n11: 23, n10: 2, n01: 0, n00: 0 }, margin, alpha });
    expect(Object.isFrozen(diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.admission)).toBe(true);
    expect(Object.isFrozen(diagnostic.diagnostic)).toBe(true);
    expect(Object.isFrozen(diagnostic.diagnostic.pValue)).toBe(true);
    expect(Object.isFrozen(diagnostic.diagnostic.certificate)).toBe(true);
    expect(Object.isFrozen(diagnostic.diagnostic.certificate?.safeCeiling)).toBe(true);
    expect(diagnostic.admission).toBe(MATCHED_PAIR_NI_ADMISSION);
    expect(() => { (diagnostic.admission as { admitted: boolean }).admitted = true; }).toThrow();
    expect(() => { (diagnostic.diagnostic as { statisticalRejectNull: boolean }).statisticalRejectNull = false; }).toThrow();
    expect(() => { (diagnostic.diagnostic.pValue as { lower: typeof ZERO }).lower = ZERO; }).toThrow();
    expect(() => { (diagnostic.diagnostic.certificate as { stationaryPointCount: number }).stationaryPointCount = 0; }).toThrow();
    const size = await nullBoundarySizeEnvelope(2, margin, alpha);
    expect(Object.isFrozen(size)).toBe(true);
    expect(Object.isFrozen(size.lower)).toBe(true);
    expect(Object.isFrozen(size.upper)).toBe(true);
    expect(Object.isFrozen(size.indeterminateStates)).toBe(true);
  });

  it('fails closed rather than creating an unbounded worker queue under contention', async () => {
    const input = { counts: { n11: 23, n10: 2, n01: 0, n00: 0 }, margin, alpha };
    const started = Date.now();
    const outcomes = await Promise.all([restrictedScoreEM(input), restrictedScoreEM(input), restrictedScoreEM(input)]);
    expect(Date.now() - started).toBeLessThan(25_000);
    expect(outcomes.every((outcome) => outcome.admission.admitted === false)).toBe(true);
    expect(outcomes.some((outcome) => outcome.diagnostic.indeterminate?.reason === 'complexity_ceiling')).toBe(true);
  }, 30_000);
});
