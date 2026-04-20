#!/usr/bin/env npx tsx
/**
 * Outreach & Action Trigger Test Runner
 *
 * Runs all tests and generates a comprehensive report.
 * Execute with: npx tsx server/src/addie/testing/run-tests.ts
 */

import {
  runRedTeamTests,
  compareAllVariants,
  testVariantAgainstPersonas,
  CURRENT_VARIANTS,
  IMPROVED_VARIANTS,
} from './outreach-scenarios.js';

import {
  TEST_PERSONAS,
  generateJourney,
  analyzeJourney,
  JourneyScenario,
} from './user-journey-simulator.js';

import {
  runActionTriggerTests,
  generateActionTriggerReport,
  runJourneyActionTests,
} from './action-trigger-tests.js';

import {
  runSensitiveTopicTests,
  generateSensitiveTopicReport,
} from './sensitive-topic-tests.js';

import {
  runRedTeamScenarios,
  formatRedTeamReport,
} from './redteam-runner.js';

interface TestSuiteResult {
  name: string;
  passed: number;
  failed: number;
  criticalIssues: string[];
  recommendations: string[];
}

function printHeader(title: string): void {
  console.log('\n' + '='.repeat(60));
  console.log(` ${title}`);
  console.log('='.repeat(60) + '\n');
}

function printSubheader(title: string): void {
  console.log('\n' + '-'.repeat(40));
  console.log(` ${title}`);
  console.log('-'.repeat(40) + '\n');
}

function printStatus(passed: boolean, message: string): void {
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${message}`);
}

async function main(): Promise<void> {
  console.log('\n🧪 OUTREACH & ACTION TRIGGER TEST SUITE\n');
  console.log('Running comprehensive tests to validate outreach effectiveness');
  console.log('and action item trigger accuracy.\n');

  const results: TestSuiteResult[] = [];

  // ============================================
  // 1. RED TEAM SCENARIOS
  // ============================================
  printHeader('1. RED TEAM SCENARIOS');

  const redTeamResults = runRedTeamTests();

  console.log(`Total Scenarios: ${redTeamResults.totalScenarios}`);
  console.log(`Passed: ${redTeamResults.passed}`);
  console.log(`Failed: ${redTeamResults.failed}`);
  console.log(`Pass Rate: ${Math.round((redTeamResults.passed / redTeamResults.totalScenarios) * 100)}%`);

  if (redTeamResults.criticalIssues.length > 0) {
    printSubheader('⚠️  CRITICAL ISSUES');
    redTeamResults.criticalIssues.forEach(issue => {
      console.log(`  • ${issue}`);
    });
  }

  printSubheader('Scenario Results');
  redTeamResults.results.forEach(({ scenario, result }) => {
    printStatus(result.passed, `${scenario.name} (${scenario.actualRisk} risk)`);
    if (!result.passed) {
      result.issues.forEach(issue => {
        console.log(`     └─ ${issue}`);
      });
    }
  });

  results.push({
    name: 'Red Team Scenarios',
    passed: redTeamResults.passed,
    failed: redTeamResults.failed,
    criticalIssues: redTeamResults.criticalIssues,
    recommendations: redTeamResults.recommendations,
  });

  // ============================================
  // 2. MESSAGE VARIANT COMPARISON
  // ============================================
  printHeader('2. MESSAGE VARIANT COMPARISON');

  const variantComparison = compareAllVariants();

  printSubheader('Variant Rankings (by effectiveness)');
  variantComparison.rankings.forEach((v, idx) => {
    const label = v.variant in CURRENT_VARIANTS ? '(current)' : '(improved)';
    console.log(`${idx + 1}. ${v.variant} ${label} - ${v.effectiveness}% effectiveness`);
    if (v.strengths.length > 0) {
      console.log(`   Strengths: ${v.strengths.join(', ')}`);
    }
    if (v.weaknesses.length > 0) {
      console.log(`   Weaknesses: ${v.weaknesses.join(', ')}`);
    }
  });

  printSubheader('Recommendation');
  console.log(variantComparison.recommendation);

  // ============================================
  // 3. VARIANT vs PERSONA DEEP DIVE
  // ============================================
  printHeader('3. VARIANT vs PERSONA ANALYSIS');

  const allVariants = { ...CURRENT_VARIANTS, ...IMPROVED_VARIANTS };
  const topVariants = variantComparison.rankings.slice(0, 3);

  topVariants.forEach(v => {
    printSubheader(`"${v.variant}" detailed breakdown`);
    const details = testVariantAgainstPersonas(v.variant as keyof typeof allVariants);

    console.log('Persona responses:');
    details.results.forEach(r => {
      const responseIcon = r.responds ? '💬' : '🔇';
      const sentimentIcon = r.sentiment === 'positive' ? '😊' : r.sentiment === 'negative' ? '😠' : '😐';
      console.log(`  ${responseIcon} ${sentimentIcon} ${r.persona}: ${r.responds ? r.response || '(responded)' : 'No response'}`);
    });
  });

  // ============================================
  // 4. ACTION TRIGGER TESTS
  // ============================================
  printHeader('4. ACTION TRIGGER TESTS');

  const actionTriggerResults = runActionTriggerTests();

  console.log(`Total Tests: ${actionTriggerResults.total}`);
  console.log(`Passed: ${actionTriggerResults.passed}`);
  console.log(`Failed: ${actionTriggerResults.failed}`);
  console.log(`Pass Rate: ${Math.round((actionTriggerResults.passed / actionTriggerResults.total) * 100)}%`);

  if (actionTriggerResults.criticalFailures.length > 0) {
    printSubheader('⚠️  CRITICAL FAILURES');
    actionTriggerResults.criticalFailures.forEach(failure => {
      console.log(`  • ${failure}`);
    });
  }

  printSubheader('Test Results');
  actionTriggerResults.results.forEach(({ test, validation }) => {
    printStatus(validation.passed, test.name);
    if (!validation.passed) {
      validation.issues.forEach(issue => {
        console.log(`     └─ ${issue}`);
      });
    }
  });

  results.push({
    name: 'Action Trigger Tests',
    passed: actionTriggerResults.passed,
    failed: actionTriggerResults.failed,
    criticalIssues: actionTriggerResults.criticalFailures,
    recommendations: [],
  });

  // ============================================
  // 5. SENSITIVE TOPIC DETECTION TESTS
  // ============================================
  printHeader('5. SENSITIVE TOPIC DETECTION (JOURNALIST-PROOFING)');

  try {
    const sensitiveTopicResults = await runSensitiveTopicTests();

    console.log(`Total Scenarios: ${sensitiveTopicResults.passed + sensitiveTopicResults.failed}`);
    console.log(`Passed: ${sensitiveTopicResults.passed}`);
    console.log(`Failed: ${sensitiveTopicResults.failed}`);
    console.log(`Pass Rate: ${Math.round((sensitiveTopicResults.passed / (sensitiveTopicResults.passed + sensitiveTopicResults.failed)) * 100)}%`);

    // Group failures by category
    const failures = sensitiveTopicResults.results.filter(r => !r.passed);
    if (failures.length > 0) {
      printSubheader('⚠️  FAILED TESTS');
      failures.forEach(f => {
        console.log(`  ✗ [${f.scenario.id}] ${f.scenario.name}`);
        console.log(`    Message: "${f.scenario.message.substring(0, 50)}..."`);
        console.log(`    Expected: deflect=${f.scenario.expectDeflect}, category=${f.scenario.expectCategory || 'any'}`);
        console.log(`    Actual: sensitive=${f.actual.isSensitive}, category=${f.actual.category}`);
      });
    }

    // Critical issues
    const criticalSensitiveIssues: string[] = [];
    const highSeverityFailures = failures.filter(f =>
      f.scenario.expectSeverity === 'high' || f.scenario.category === 'named_individual'
    );
    if (highSeverityFailures.length > 0) {
      criticalSensitiveIssues.push(
        `${highSeverityFailures.length} high-severity sensitive topics not being deflected`
      );
    }

    // Check for false positives
    const falsePositives = sensitiveTopicResults.results.filter(r =>
      !r.scenario.expectDeflect && r.actual.isSensitive
    );
    if (falsePositives.length > 0) {
      printSubheader('⚠️  FALSE POSITIVES (Safe questions being flagged)');
      falsePositives.forEach(f => {
        console.log(`  • "${f.scenario.message}" flagged as ${f.actual.category}`);
      });
    }

    results.push({
      name: 'Sensitive Topic Detection',
      passed: sensitiveTopicResults.passed,
      failed: sensitiveTopicResults.failed,
      criticalIssues: criticalSensitiveIssues,
      recommendations: [],
    });
  } catch (error) {
    console.log('⚠️  Could not run sensitive topic tests (requires database)');
    console.log(`   Error: ${error instanceof Error ? error.message : 'Unknown'}`);
    console.log('   Run with database connected to test pattern matching.');
  }

  // ============================================
  // 6. RED-TEAM REGRESSION (LIVE LLM)
  // ============================================
  printHeader('6. RED-TEAM REGRESSION (live Addie endpoint)');

  if (process.env.RUN_REDTEAM === '1') {
    try {
      const redTeamSummary = await runRedTeamScenarios();
      console.log(formatRedTeamReport(redTeamSummary));

      const criticalRedTeamIssues: string[] = [];
      if (redTeamSummary.metrics.fabricationHits > 0) {
        criticalRedTeamIssues.push(
          `${redTeamSummary.metrics.fabricationHits} fabricated member-company mentions`
        );
      }
      if (redTeamSummary.failed > redTeamSummary.total * 0.2) {
        criticalRedTeamIssues.push(
          `${redTeamSummary.failed}/${redTeamSummary.total} red-team scenarios failed (>20%)`
        );
      }

      results.push({
        name: 'Red-Team Regression',
        passed: redTeamSummary.passed,
        failed: redTeamSummary.failed,
        criticalIssues: criticalRedTeamIssues,
        recommendations: [],
      });
    } catch (error) {
      console.log('⚠️  Could not run red-team regression');
      console.log(`   Error: ${error instanceof Error ? error.message : 'Unknown'}`);
      console.log('   Requires a live Addie endpoint. Set ADDIE_BASE_URL or CONDUCTOR_PORT.');
    }
  } else {
    console.log('Skipped (set RUN_REDTEAM=1 to run against a live Addie endpoint).');
    console.log('This suite sends 25 hostile questions to Addie and checks for');
    console.log('fabricated member names, banned ritual phrases, sign-in deflection,');
    console.log('length blow-out on short questions, and missing concept markers.');
  }

  // ============================================
  // 7. JOURNEY-BASED TESTS
  // ============================================
  printHeader('7. JOURNEY-BASED INTEGRATION TESTS');

  const journeyResults = runJourneyActionTests();

  printSubheader('Tested Scenarios');
  console.log('Personas:', TEST_PERSONAS.map(p => p.name).join(', '));
  console.log('Scenarios:', journeyResults.scenarios.join(', '));
  console.log(`Total Journey Tests: ${journeyResults.results.length}`);

  // Find journeys with gaps
  const journeysWithGaps = journeyResults.results.filter(r => r.gaps.length > 0);
  if (journeysWithGaps.length > 0) {
    printSubheader('Gaps Found');
    journeysWithGaps.forEach(r => {
      console.log(`\n${r.journey.persona.name} - ${r.journey.currentState.lifecycleStage}:`);
      r.gaps.forEach(gap => {
        console.log(`  • ${gap}`);
      });
    });
  }

  if (journeyResults.overallRecommendations.length > 0) {
    printSubheader('Overall Recommendations');
    journeyResults.overallRecommendations.forEach(rec => {
      console.log(`  • ${rec}`);
    });
  }

  // ============================================
  // FINAL SUMMARY
  // ============================================
  printHeader('FINAL SUMMARY');

  let totalPassed = 0;
  let totalFailed = 0;
  const allCriticalIssues: string[] = [];

  results.forEach(r => {
    totalPassed += r.passed;
    totalFailed += r.failed;
    allCriticalIssues.push(...r.criticalIssues);
  });

  console.log('Test Suite Results:');
  results.forEach(r => {
    const pct = Math.round((r.passed / (r.passed + r.failed)) * 100);
    const status = r.failed === 0 ? '✅' : r.criticalIssues.length > 0 ? '🚨' : '⚠️';
    console.log(`  ${status} ${r.name}: ${r.passed}/${r.passed + r.failed} (${pct}%)`);
  });

  console.log(`\nOverall: ${totalPassed}/${totalPassed + totalFailed} tests passed`);

  if (allCriticalIssues.length > 0) {
    console.log('\n🚨 CRITICAL ISSUES TO ADDRESS:');
    allCriticalIssues.forEach(issue => {
      console.log(`  • ${issue}`);
    });
  }

  // ============================================
  // ACTIONABLE NEXT STEPS
  // ============================================
  printHeader('ACTIONABLE NEXT STEPS');

  console.log('Based on test results, recommended priorities:\n');

  // Priority 1: Critical issues
  if (allCriticalIssues.length > 0) {
    console.log('🔴 HIGH PRIORITY (Critical Issues):');
    allCriticalIssues.slice(0, 3).forEach((issue, i) => {
      console.log(`   ${i + 1}. ${issue}`);
    });
    console.log();
  }

  // Priority 2: Message improvements
  const currentBest = variantComparison.rankings.find(v => v.variant in CURRENT_VARIANTS);
  const improvedBest = variantComparison.rankings.find(v => !(v.variant in CURRENT_VARIANTS));

  if (improvedBest && currentBest && improvedBest.effectiveness > currentBest.effectiveness) {
    console.log('🟡 MEDIUM PRIORITY (Message Optimization):');
    console.log(`   Consider A/B testing "${improvedBest.variant}" variant`);
    console.log(`   Potential improvement: ${improvedBest.effectiveness - currentBest.effectiveness}% effectiveness gain`);
    console.log();
  }

  // Priority 3: Gap fixes
  if (journeyResults.overallGaps.length > 0) {
    console.log('🟢 LOWER PRIORITY (Coverage Gaps):');
    journeyResults.overallGaps.slice(0, 2).forEach((gap, i) => {
      console.log(`   ${i + 1}. ${gap}`);
    });
    console.log();
  }

  console.log('=' .repeat(60));
  console.log(' Test run complete');
  console.log('=' .repeat(60) + '\n');
}

// Run if executed directly
main().catch(console.error);
