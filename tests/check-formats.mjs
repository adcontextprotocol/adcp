import { testAgent } from '@adcp/client/testing';
import { ListCreativeFormatsResponseSchema } from '@adcp/client';

const result = await testAgent.listCreativeFormats({});

if (!result.success) {
  console.log('Error:', result.error);
  process.exit(1);
}

const validated = ListCreativeFormatsResponseSchema.parse(result.data);

if ('errors' in validated && validated.errors) {
  console.log('API Errors:', validated.errors);
  process.exit(1);
}

console.log('Looking for display_300x250 formats:\n');
const displayFormats = validated.formats.filter(f =>
  f.format_id?.includes('300x250') ||
  f.format_id?.includes('display_300')
);

if (displayFormats.length === 0) {
  console.log('No 300x250 display formats found!');
  console.log('\nAll format IDs:');
  validated.formats.forEach(f => console.log('  -', f.format_id));
} else {
  displayFormats.forEach(f => console.log('  -', f.format_id));
}

console.log('\nTotal formats:', validated.formats.length);
