const assert = require('node:assert/strict');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { ensureBuiltSchemas, readBuiltSchema } = require('../scripts/built-schemas.cjs');

ensureBuiltSchemas();

const read = (name) => readBuiltSchema(`/schemas/${name}`);
const typeSchema = read('enums/distribution-identifier-type.json');
let compiled;
function compile() {
  if (!compiled) {
    const ajv = new Ajv({
      allErrors: true, strict: false,
      loadSchema: async (uri) => {
        assert.ok(uri.startsWith('/schemas/'), `unexpected schema reference: ${uri}`);
        return read(uri.slice('/schemas/'.length));
      },
    });
    addFormats(ajv);
    compiled = ajv.compileAsync(read('core/collection-distribution.json'));
  }
  return compiled;
}

const ID_TYPES = [
  ['instagram_account_id', 'instagram.com', '17841400008460056'],
  ['facebook_page_id', 'facebook.com', '100064267823693'],
  ['snapchat_profile_id', 'snapchat.com', 'a1b2c3d4-0000-4000-8000-000000000000'],
  ['x_user_id', 'x.com', '783214'],
];
const HANDLE_TYPES = [
  ['instagram_handle', 'instagram.com', '@example'],
  ['facebook_page_handle', 'facebook.com', '@example'],
  ['snapchat_handle', 'snapchat.com', '@example'],
  ['x_handle', 'x.com', '@example'],
];
const NEW_VALUES = [...ID_TYPES, ...HANDLE_TYPES];
const NEW_ORDER = [
  'instagram_account_id', 'instagram_handle', 'facebook_page_id', 'facebook_page_handle',
  'snapchat_profile_id', 'snapchat_handle', 'x_user_id', 'x_handle',
];
const EXISTING_ORDER = [
  'apple_podcast_id', 'spotify_collection_id', 'rss_url', 'podcast_guid', 'amazon_music_id', 'iheart_id',
  'podcast_index_id', 'youtube_channel_id', 'youtube_channel_handle', 'youtube_channel_url',
  'youtube_playlist_id', 'amazon_title_id', 'platform_channel_id', 'roku_channel_id', 'pluto_channel_id',
  'tubi_id', 'peacock_id', 'tiktok_id', 'twitch_channel',
];

for (const [type, publisher_domain, value] of NEW_VALUES) {
  test(`distribution accepts identifier type ${type}`, async () => {
    const validate = await compile();
    const entry = { publisher_domain, identifiers: [{ type, value }] };
    assert.equal(validate(entry), true, JSON.stringify(validate.errors, null, 2));
  });
}

test('distribution rejects an identifier type outside the enum', async () => {
  const validate = await compile();
  assert.equal(validate({ publisher_domain: 'myspace.com', identifiers: [{ type: 'myspace_id', value: '1' }] }), false);
});

test('every enum value has an enumDescriptions entry', () => {
  assert.deepEqual(Object.keys(typeSchema.enumDescriptions).sort(), [...typeSchema.enum].sort());
  for (const v of typeSchema.enum) assert.ok(typeSchema.enumDescriptions[v].length > 0, v);
});

test('ID descriptions say they are the preferred canonical identifier', () => {
  for (const [v] of ID_TYPES) {
    assert.match(typeSchema.enumDescriptions[v], /preferred/i, v);
    assert.match(typeSchema.enumDescriptions[v], /canonical/i, v);
  }
});

test('handle descriptions say the ID is preferred for canonical matching', () => {
  for (const [v] of HANDLE_TYPES) {
    assert.match(typeSchema.enumDescriptions[v], /preferred/i, v);
    assert.match(typeSchema.enumDescriptions[v], /canonical/i, v);
  }
});

test('new values sit together after twitch_channel without reordering existing ones', () => {
  const e = typeSchema.enum;
  const tail = EXISTING_ORDER.length + NEW_ORDER.length;
  assert.deepEqual(e.slice(0, EXISTING_ORDER.length), EXISTING_ORDER);
  assert.deepEqual(e.slice(EXISTING_ORDER.length, tail), NEW_ORDER);
  // Later additions may be appended; only the values that followed twitch_channel before 3.3 are pinned.
  assert.deepEqual(e.slice(tail, tail + 5), ['imdb_id', 'gracenote_id', 'eidr_id', 'domain', 'substack_id']);
});
