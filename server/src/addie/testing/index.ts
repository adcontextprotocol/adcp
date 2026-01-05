/**
 * Outreach & Action Trigger Testing Framework
 *
 * Comprehensive testing tools for:
 * 1. Red team scenarios - finding failure modes
 * 2. Message variant comparison - optimizing copy
 * 3. User journey simulation - realistic testing
 * 4. Action trigger validation - ensuring proper timing
 */

// User Journey Simulation
export {
  UserPersona,
  ActivityEvent,
  UserJourney,
  JourneyScenario,
  JourneyAnalysis,
  TEST_PERSONAS,
  generateJourney,
  analyzeJourney,
  simulateResponse,
  RED_TEAM_SCENARIOS as JOURNEY_RED_TEAM_SCENARIOS,
} from './user-journey-simulator.js';

// Outreach Scenarios & Red Team
export {
  CURRENT_VARIANTS,
  IMPROVED_VARIANTS,
  RED_TEAM_SCENARIOS,
  RedTeamScenario,
  ScenarioTestResult,
  runRedTeamTests,
  testVariantAgainstPersonas,
  compareAllVariants,
} from './outreach-scenarios.js';

// Action Trigger Testing
export {
  ACTION_TRIGGER_TESTS,
  runActionTriggerTests,
  generateActionTriggerReport,
  testActionTriggersForJourney,
  runJourneyActionTests,
} from './action-trigger-tests.js';

// Sensitive Topic Detection Testing
export {
  SENSITIVE_TOPIC_SCENARIOS,
  SensitiveTopicScenario,
  runSensitiveTopicTests,
  generateSensitiveTopicReport,
} from './sensitive-topic-tests.js';
