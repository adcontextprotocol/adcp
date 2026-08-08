const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const schemaRoot = path.resolve(__dirname, '../static/schemas/source');

async function compileBrandSchema() {
  const ajv = new Ajv({ strict: false, allErrors: true, loadSchema: async uri => {
    if (!uri.startsWith('/schemas/')) throw new Error(`Unsupported schema URI: ${uri}`);
    return JSON.parse(fs.readFileSync(path.join(schemaRoot, uri.slice('/schemas/'.length)), 'utf8'));
  }});
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(path.join(schemaRoot, 'brand.json'), 'utf8'));
  return ajv.compileAsync(schema);
}

function canonicalLocale(locale) {
  return locale.replaceAll('_', '-').toLowerCase();
}

function localeCandidates(requested, defaultLanguage = 'en') {
  const requestedTag = canonicalLocale(requested);
  const defaultTag = canonicalLocale(defaultLanguage);
  return [...new Set([
    requestedTag,
    requestedTag.split('-')[0],
    defaultTag,
    defaultTag.split('-')[0],
  ])];
}

function hasUniqueCanonicalLocales(value) {
  const locales = value.map(entry => canonicalLocale(Object.keys(entry)[0]));
  return new Set(locales).size === locales.length;
}

function resolveLocalized(value, requested, defaultLanguage = 'en') {
  const localized = Array.isArray(value)
    && value.length > 0
    && value.every(entry => entry && typeof entry === 'object' && !Array.isArray(entry));
  if (!localized) return value;

  const translations = new Map();
  for (const entry of value) {
    const [locale, translation] = Object.entries(entry)[0];
    translations.set(canonicalLocale(locale), translation);
  }
  for (const candidate of localeCandidates(requested, defaultLanguage)) {
    if (translations.has(candidate)) return translations.get(candidate);
  }
  return undefined;
}

test('brand.json accepts localized scalar fields and whole tone arrays', async () => {
  const validate = await compileBrandSchema();
  const document = {
    $schema: '/schemas/brand.json',
    version: '1.0',
    default_language: 'en-GB',
    id: 'acme',
    names: [{ en: 'Acme' }],
    tone: {
      voice: [{ 'en-GB': 'Warm and direct' }, { fr: 'Chaleureux et direct' }],
      attributes: [
        { 'en-GB': ['plain-spoken', 'optimistic'] },
        { fr: ['accessible', 'optimiste'] },
      ],
      dos: ['Use active voice'],
      donts: [{ en: ['Use jargon'] }, { fr: ['Employer du jargon'] }],
    },
    assets: [{
      asset_id: 'hero',
      asset_type: 'image',
      url: 'https://assets.example/hero.jpg',
      name: [{ en: 'Summer hero' }, { fr: 'Visuel principal été' }],
      description: 'Campaign hero image',
    }],
  };

  assert.equal(validate(document), true, JSON.stringify(validate.errors));
});

test('tone list localization rejects independently localized elements', async () => {
  const validate = await compileBrandSchema();
  const document = {
    $schema: '/schemas/brand.json',
    id: 'acme',
    names: [{ en: 'Acme' }],
    tone: {
      attributes: [{ en: 'plain-spoken' }, { fr: 'accessible' }],
    },
  };

  assert.equal(validate(document), false);
});

test('locale resolution follows exact, base, default, legacy, unavailable order', () => {
  const localized = [{ 'fr-CA': 'Allô' }, { fr: 'Bonjour' }, { 'en-GB': 'Hello' }, { es: 'Hola' }];
  assert.equal(resolveLocalized(localized, 'fr-CA', 'en-GB'), 'Allô');
  assert.equal(resolveLocalized(localized, 'fr-BE', 'en-GB'), 'Bonjour');
  assert.equal(resolveLocalized(localized, 'de-DE', 'en-GB'), 'Hello');
  assert.equal(resolveLocalized('Legacy copy', 'de-DE', 'en-GB'), 'Legacy copy');
  assert.equal(resolveLocalized([{ es: 'Hola' }], 'de-DE', 'en-GB'), undefined);
});

test('locale resolution returns a complete tone list without mixing languages', () => {
  const attributes = [
    { en: ['plain-spoken', 'optimistic'] },
    { fr: ['accessible', 'optimiste'] },
  ];
  assert.deepEqual(resolveLocalized(attributes, 'fr-CA'), ['accessible', 'optimiste']);
});

test('localized 3.2 fields prohibit duplicate canonicalized locale tags', () => {
  assert.equal(hasUniqueCanonicalLocales([{ 'en-US': 'Color' }, { fr: 'Couleur' }]), true);
  assert.equal(hasUniqueCanonicalLocales([{ 'en-US': 'Color' }, { en_US: 'Colour' }]), false);
  assert.equal(hasUniqueCanonicalLocales([{ 'pt-BR': ['claro'] }, { pt_BR: ['direto'] }]), false);
});
