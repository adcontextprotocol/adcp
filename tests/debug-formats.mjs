import { testAgent } from '@adcp/client/testing';

console.log('Test 1: listCreativeFormats with format_ids...');
try {
  const result = await testAgent.listCreativeFormats({
    format_ids: [
      {
        agent_url: 'https://creative.adcontextprotocol.org',
        id: 'display_300x250'
      }
    ]
  });
  console.log('Result success:', result.success);
  if (result.success) {
    console.log('Format count:', result.data.formats?.length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

console.log('\nTest 2: listCreativeFormats with empty object...');
try {
  const result = await testAgent.listCreativeFormats({});
  console.log('Result success:', result.success);
  if (result.success) {
    console.log('Format count:', result.data.formats?.length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

console.log('\nTest 3: listCreativeFormats with type filter...');
try {
  const result = await testAgent.listCreativeFormats({ type: 'display' });
  console.log('Result success:', result.success);
  if (result.success) {
    console.log('Format count:', result.data.formats?.length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}
