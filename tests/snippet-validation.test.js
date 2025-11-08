#!/usr/bin/env node
/**
 * Documentation Snippet Validation Test Suite
 *
 * This test suite extracts and validates code snippets from documentation files.
 * It ensures that examples in the documentation are functional and accurate.
 *
 * Snippet Marking Convention:
 * - Add 'test=true' or 'testable' after the language identifier to mark snippets for testing
 * - Example: ```javascript test=true
 * - Example: ```bash testable
 *
 * Test Agent Configuration:
 * - Uses https://test-agent.adcontextprotocol.org for testing
 * - MCP token: 1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ
 * - A2A token: L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const glob = require('glob');

const execAsync = promisify(exec);

// Configuration
const DOCS_BASE_DIR = path.join(__dirname, '../docs');
const TEST_AGENT_URL = 'https://test-agent.adcontextprotocol.org';
const MCP_TOKEN = '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';
const A2A_TOKEN = 'L4UCklW_V_40eTdWuQYF6HD5GWeKkgV8U6xxK-jwNO8';

// Test statistics
let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
let skippedTests = 0;

// Logging utilities
function log(message, type = 'info') {
  const colors = {
    info: '\x1b[0m',
    success: '\x1b[32m',
    error: '\x1b[31m',
    warning: '\x1b[33m',
    dim: '\x1b[2m'
  };
  console.log(`${colors[type]}${message}\x1b[0m`);
}

/**
 * Extract code blocks from markdown/mdx files
 * @param {string} filePath - Path to the markdown file
 * @returns {Array} Array of code block objects
 */
function extractCodeBlocks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const blocks = [];

  // Regex to match code blocks with optional metadata
  // Matches: ```language test=true or ```language testable
  // Note: Use [^\n]* instead of .*? to avoid consuming the first line of code
  const codeBlockRegex = /```(\w+)(?:\s+(test=true|testable))?[^\n]*\n([\s\S]*?)```/g;

  let match;
  let blockIndex = 0;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    const language = match[1];
    const shouldTest = match[2] !== undefined;
    const code = match[3];

    blocks.push({
      file: filePath,
      language,
      shouldTest,
      code: code.trim(),
      index: blockIndex++,
      line: content.substring(0, match.index).split('\n').length
    });
  }

  return blocks;
}

/**
 * Find all documentation files
 */
function findDocFiles() {
  return glob.sync('**/*.{md,mdx}', {
    cwd: DOCS_BASE_DIR,
    absolute: true
  });
}

/**
 * Test a JavaScript/TypeScript snippet
 */
async function testJavaScriptSnippet(snippet) {
  // Detect ESM syntax and use .mjs extension to avoid Node warnings
  const hasESMSyntax = snippet.code.includes('import ') || snippet.code.includes('export ');
  const extension = hasESMSyntax ? '.mjs' : '.js';
  const tempFile = path.join(__dirname, `temp-snippet-${Date.now()}${extension}`);

  try {
    // Write snippet to temporary file
    fs.writeFileSync(tempFile, snippet.code);

    // Execute with Node.js from project root to access node_modules
    const { stdout, stderr } = await execAsync(`node ${tempFile}`, {
      timeout: 60000, // 60 second timeout (API calls can take time)
      cwd: path.join(__dirname, '..') // Run from project root
    });

    // Check if stderr contains only warnings (not errors)
    const hasRealErrors = stderr && !stderr.includes('[MODULE_TYPELESS_PACKAGE_JSON]');

    return {
      success: true,
      output: stdout,
      error: hasRealErrors ? stderr : null
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr,
      code: error.code,
      signal: error.signal,
      killed: error.killed
    };
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

/**
 * Test a curl command
 */
async function testCurlCommand(snippet) {
  try {
    // Extract and execute the curl command
    const { stdout, stderr } = await execAsync(snippet.code, {
      timeout: 10000,
      shell: '/bin/bash'
    });

    // Try to parse JSON response
    try {
      const response = JSON.parse(stdout);
      return {
        success: true,
        response,
        rawOutput: stdout
      };
    } catch (e) {
      // Not JSON, but command succeeded
      return {
        success: true,
        rawOutput: stdout,
        error: stderr
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr
    };
  }
}

/**
 * Test a Python snippet
 */
async function testPythonSnippet(snippet) {
  const tempFile = path.join(__dirname, `temp-snippet-${Date.now()}.py`);

  try {
    // Write snippet to temporary file
    fs.writeFileSync(tempFile, snippet.code);

    // Execute with Python
    const { stdout, stderr } = await execAsync(`python3 ${tempFile}`, {
      timeout: 10000
    });

    return {
      success: true,
      output: stdout,
      error: stderr
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stdout: error.stdout,
      stderr: error.stderr
    };
  } finally {
    // Clean up temp file
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }
}

/**
 * Validate a snippet based on its language
 */
async function validateSnippet(snippet) {
  totalTests++;

  const relativePath = path.relative(DOCS_BASE_DIR, snippet.file);
  const testName = `${relativePath}:${snippet.line} (${snippet.language} block #${snippet.index})`;

  log(`\nTesting: ${testName}`, 'info');
  log(`  Code preview: ${snippet.code.substring(0, 60)}...`, 'dim');

  if (!snippet.shouldTest) {
    skippedTests++;
    log(`  ⊘ SKIPPED (not marked for testing)`, 'warning');
    return;
  }

  let result;

  try {
    switch (snippet.language.toLowerCase()) {
      case 'javascript':
      case 'typescript':
      case 'js':
      case 'ts':
        result = await testJavaScriptSnippet(snippet);
        break;

      case 'bash':
      case 'sh':
      case 'shell':
        // Check if it's a curl command
        if (snippet.code.trim().startsWith('curl')) {
          result = await testCurlCommand(snippet);
        } else {
          result = { success: false, error: 'Only curl commands are tested for bash snippets' };
        }
        break;

      case 'python':
      case 'py':
        result = await testPythonSnippet(snippet);
        break;

      default:
        skippedTests++;
        log(`  ⊘ SKIPPED (language '${snippet.language}' not supported for testing)`, 'warning');
        return;
    }

    if (result.success) {
      passedTests++;
      log(`  ✓ PASSED`, 'success');
      if (result.output) {
        log(`    Output: ${result.output.substring(0, 100)}...`, 'dim');
      }
    } else {
      failedTests++;
      log(`  ✗ FAILED`, 'error');
      log(`    Error: ${result.error}`, 'error');
      if (result.code) log(`    Exit code: ${result.code}`, 'error');
      if (result.signal) log(`    Signal: ${result.signal}`, 'error');
      if (result.killed) log(`    Killed: ${result.killed}`, 'error');
      if (result.stdout) {
        log(`    Stdout: ${result.stdout.substring(0, 200)}`, 'error');
      }
      if (result.stderr) {
        log(`    Stderr: ${result.stderr.substring(0, 500)}`, 'error');
      }
    }
  } catch (error) {
    failedTests++;
    log(`  ✗ FAILED (unexpected error)`, 'error');
    log(`    ${error.message}`, 'error');
  }
}

/**
 * Main test runner
 */
async function runTests() {
  log('=================================', 'info');
  log('Documentation Snippet Validation', 'info');
  log('=================================\n', 'info');

  log(`Searching for documentation files in: ${DOCS_BASE_DIR}`, 'info');

  const docFiles = findDocFiles();
  log(`Found ${docFiles.length} documentation files\n`, 'info');

  // Extract all code blocks
  const allSnippets = [];
  for (const file of docFiles) {
    const snippets = extractCodeBlocks(file);
    allSnippets.push(...snippets);
  }

  log(`Extracted ${allSnippets.length} code blocks total`, 'info');
  const testableSnippets = allSnippets.filter(s => s.shouldTest);
  log(`Found ${testableSnippets.length} snippets marked for testing\n`, 'info');

  // Run tests on all testable snippets
  for (const snippet of allSnippets) {
    await validateSnippet(snippet);
  }

  // Print summary
  log('\n=================================', 'info');
  log('Test Summary', 'info');
  log('=================================', 'info');
  log(`Total snippets found: ${allSnippets.length}`, 'info');
  log(`Tests run: ${totalTests}`, 'info');
  log(`Passed: ${passedTests}`, 'success');
  log(`Failed: ${failedTests}`, failedTests > 0 ? 'error' : 'info');
  log(`Skipped: ${skippedTests}`, 'warning');

  // Exit with error code if any tests failed
  if (failedTests > 0) {
    log('\n❌ Some snippet tests failed', 'error');
    process.exit(1);
  } else if (passedTests === 0 && testableSnippets.length === 0) {
    log('\n⚠️  No testable snippets found. Mark snippets with "test=true" to enable testing.', 'warning');
    log('   Example: ```javascript test=true', 'dim');
    process.exit(0);
  } else {
    log('\n✅ All snippet tests passed!', 'success');
    process.exit(0);
  }
}

// Run tests
runTests().catch(error => {
  log(`\nFatal error: ${error.message}`, 'error');
  console.error(error);
  process.exit(1);
});
