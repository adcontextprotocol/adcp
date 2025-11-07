#!/usr/bin/env node
/**
 * Example testable snippet for documentation
 *
 * This demonstrates a working code example that:
 * 1. Can be copied directly from documentation
 * 2. Executes successfully
 * 3. Is automatically tested in CI
 */

// Simulate a basic API test
const TEST_AGENT_URL = 'https://test-agent.adcontextprotocol.org';

async function testConnection() {
  try {
    // Simple connection test
    const response = await fetch(`${TEST_AGENT_URL}/.well-known/agent-card.json`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const agentCard = await response.json();

    console.log('✓ Successfully connected to test agent');
    console.log(`  Agent name: ${agentCard.name || 'Unknown'}`);
    console.log(`  Protocols: ${agentCard.protocols?.join(', ') || 'Unknown'}`);

    return true;
  } catch (error) {
    console.error('✗ Connection failed:', error.message);
    return false;
  }
}

// Run the test
testConnection().then(success => {
  process.exit(success ? 0 : 1);
});
