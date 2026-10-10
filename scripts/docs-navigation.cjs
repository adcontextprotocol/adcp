/**
 * Resolve the English documentation version picker.
 *
 * Mintlify's language switcher replaces the root of `navigation`, so the
 * version list lives at `navigation.versions` or, once translations exist,
 * under the `en` language entry. Release tooling, search indexes, and link
 * checks follow that English picker only. Translations must not become
 * protocol versions.
 */
function docsNavigationVersions(config) {
  const navigation = config?.navigation;
  if (!navigation || typeof navigation !== 'object') return undefined;
  if (Array.isArray(navigation.versions)) return navigation.versions;
  const languages = navigation.languages;
  if (!Array.isArray(languages)) return undefined;
  const english =
    languages.find((entry) => entry?.language === 'en') ??
    languages.find((entry) => entry?.default) ??
    languages[0];
  return Array.isArray(english?.versions) ? english.versions : undefined;
}

function setDocsNavigationVersions(config, versions) {
  const navigation = config?.navigation;
  if (!navigation || typeof navigation !== 'object') {
    throw new Error('docs.json must contain a navigation object');
  }
  if (Array.isArray(navigation.versions) || !Array.isArray(navigation.languages)) {
    navigation.versions = versions;
    return;
  }
  const english =
    navigation.languages.find((entry) => entry?.language === 'en') ??
    navigation.languages.find((entry) => entry?.default) ??
    navigation.languages[0];
  if (!english) {
    throw new Error('docs.json must contain navigation.versions or an en language entry');
  }
  english.versions = versions;
}

module.exports = {
  docsNavigationVersions,
  setDocsNavigationVersions,
};
