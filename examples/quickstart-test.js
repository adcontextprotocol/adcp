#!/usr/bin/env node
/**
 * Quickstart Example - Test Agent Connection
 *
 * This example demonstrates connecting to the AdCP test agent
 * and verifying that the agent card is accessible.
 */

const TEST_AGENT_URL = 'https://test-agent.adcontextprotocol.org';

async function main() {
  console.log('AdCP Quickstart Example');
  console.log('======================\n');

  // Test 1: Verify agent card is accessible
  console.log('1. Fetching agent card...');
  try {
    const response = await fetch(`${TEST_AGENT_URL}/.well-known/agent-card.json`);

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const agentCard = await response.json();
    console.log('   ✓ Agent card retrieved successfully');
    console.log(`   - Agent: ${agentCard.name || 'Test Agent'}`);
    console.log(`   - Version: ${agentCard.adcp_version || 'unknown'}\n`);
  } catch (error) {
    console.error('   ✗ Failed to fetch agent card:', error.message);
    process.exit(1);
  }

  // Test 2: Verify agent is reachable
  console.log('2. Testing agent connectivity...');
  try {
    const response = await fetch(TEST_AGENT_URL);
    if (response.ok || response.status === 405) {
      // 405 Method Not Allowed is fine - means server is responding
      console.log('   ✓ Agent is reachable\n');
    } else {
      throw new Error(`Unexpected status: ${response.status}`);
    }
  } catch (error) {
    console.error('   ✗ Agent not reachable:', error.message);
    process.exit(1);
  }

  console.log('✓ All tests passed!');
  console.log('\nNext steps:');
  console.log('  - Install the client: npm install @adcp/client');
  console.log('  - Use the test token: 1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ');
  console.log('  - Follow the quickstart guide at: https://adcontextprotocol.org/docs/quickstart');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
