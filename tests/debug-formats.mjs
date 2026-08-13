import { testAgent } from '@adcp/sdk/testing';

console.log('Test 1: canonical creative capabilities...');
try {
  const result = await testAgent.getAdcpCapabilities({});
  console.log('Result success:', result.success);
  if (result.success) {
    const formats = result.data.creative?.supported_formats ?? [];
    console.log('Capability count:', formats.length);
    console.log('300x250 matches:', formats.filter(capability =>
      capability.capability_id?.includes('300x250') ||
      capability.format?.format_option_id?.includes('300x250')
    ).length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

console.log('\nTest 2: image capabilities...');
try {
  const result = await testAgent.getAdcpCapabilities({});
  console.log('Result success:', result.success);
  if (result.success) {
    const formats = result.data.creative?.supported_formats ?? [];
    console.log('Image capability count:', formats.filter(capability => capability.format?.format_kind === 'image').length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}

console.log('\nTest 3: preview capabilities...');
try {
  const result = await testAgent.getAdcpCapabilities({});
  console.log('Result success:', result.success);
  if (result.success) {
    const formats = result.data.creative?.supported_formats ?? [];
    console.log('Preview capability count:', formats.filter(capability => capability.operations?.includes('preview')).length);
  } else {
    console.log('Error:', result.error);
  }
} catch (e) {
  console.log('Exception:', e.message);
}
