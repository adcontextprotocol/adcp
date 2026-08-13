import { testAgent } from '@adcp/sdk/testing';

const result = await testAgent.getAdcpCapabilities({});

if (!result.success) {
  console.log('Error:', result.error);
  process.exit(1);
}

const formats = result.data.creative?.supported_formats ?? [];

console.log('Looking for 300x250 display capabilities:\n');
const displayFormats = formats.filter(capability =>
  capability.capability_id?.includes('300x250') ||
  capability.format?.format_option_id?.includes('300x250') ||
  (capability.format?.format_kind === 'image' &&
    capability.format.params?.width === 300 &&
    capability.format.params?.height === 250)
);

if (displayFormats.length === 0) {
  console.log('No 300x250 display capabilities found!');
  console.log('\nAll capability IDs:');
  formats.forEach(capability => console.log('  -', capability.capability_id));
} else {
  displayFormats.forEach(capability => console.log('  -', capability.capability_id));
}

console.log('\nTotal capabilities:', formats.length);
