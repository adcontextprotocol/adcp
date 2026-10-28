'use strict';

/**
 * Compose the protocol envelope into closed task response schemas.
 *
 * On MCP and REST, envelope fields (`status`, `task_id`, `context`,
 * `replayed`, `adcp_version`, ...) are siblings of task body fields at the
 * response root. Task response schemas declare only body fields and compose
 * `core/protocol-envelope.json` through their root `allOf`, and the envelope
 * supplies the rest.
 *
 * A draft-07 `additionalProperties: false` sees only the `properties` of its
 * own schema object, not those of `allOf` members. A closed response root or
 * a closed `oneOf`/`anyOf` branch therefore rejects every envelope field,
 * although the composed envelope declares them. This transform adds each
 * envelope property to every closed schema object in a document that
 * composes the envelope, as a `$ref` to the property's declaration in the
 * envelope (or in a schema the envelope composes, such as
 * `core/version-envelope.json`).
 *
 * Only missing keys are added. A local declaration of an envelope field is
 * kept, because it narrows the envelope field: a compact branch's
 * `status: {const: "completed"}` discriminator, a constrained `task_id` or
 * `message`, or `replayed: {const: true}`. The composed envelope still
 * validates the value through `allOf`.
 *
 * The property list comes from the envelope itself, so a field added to the
 * envelope reaches every closed response on the next build. The envelope's
 * `payload` property is the one exception: the envelope defines it as a
 * documentary grouping of the body fields that is never serialized on the
 * wire, so a closed response must not accept it.
 *
 * Source schemas stay unchanged. `scripts/build-schemas.cjs` applies this
 * transform to every source document it reads, for the flat tree, the
 * bundled tree and the MCP projection alike.
 */

const fs = require('node:fs');
const path = require('node:path');

const PROTOCOL_ENVELOPE_REF = '/schemas/core/protocol-envelope.json';

// Envelope properties that are documentary and never appear on the wire.
// See the `payload` description and `notes` in core/protocol-envelope.json.
const DOCUMENTARY_ENVELOPE_PROPERTIES = new Set(['payload']);

const COMPOSITION_KEYWORDS = ['allOf', 'anyOf', 'oneOf'];

function readSchemaRef(sourceDir, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('/schemas/') || ref.includes('#')) {
    throw new Error(`Envelope composition supports only whole-document /schemas/ refs, got ${ref}`);
  }
  return JSON.parse(fs.readFileSync(path.join(sourceDir, ref.slice('/schemas/'.length)), 'utf8'));
}

/**
 * List the wire properties of the protocol envelope, in declaration order:
 * the envelope's own properties, then those of each schema it composes
 * through its root `allOf`. Each entry names the property and the `$ref` to
 * the declaration that defines it.
 */
function envelopeWireProperties(sourceDir) {
  const properties = [];
  const seenNames = new Set();
  const seenRefs = new Set();

  function collect(ref) {
    if (seenRefs.has(ref)) return;
    seenRefs.add(ref);
    const schema = readSchemaRef(sourceDir, ref);
    for (const name of Object.keys(schema.properties || {})) {
      if (DOCUMENTARY_ENVELOPE_PROPERTIES.has(name) || seenNames.has(name)) continue;
      seenNames.add(name);
      properties.push({ name, ref: `${ref}#/properties/${name}` });
    }
    for (const member of schema.allOf || []) {
      if (member && typeof member.$ref === 'string') collect(member.$ref);
    }
  }

  collect(PROTOCOL_ENVELOPE_REF);
  return properties;
}

/** True when the schema lists the protocol envelope directly in its root `allOf`. */
function composesProtocolEnvelope(schema) {
  return Boolean(
    schema
    && typeof schema === 'object'
    && Array.isArray(schema.allOf)
    && schema.allOf.some(member => member && member.$ref === PROTOCOL_ENVELOPE_REF)
  );
}

/**
 * Add the missing envelope properties to every closed schema object in a
 * document that composes the protocol envelope: the root, and every inline
 * `allOf`/`anyOf`/`oneOf` member below it, recursively. A member that is a
 * bare `$ref` names another document, which this transform handles when that
 * document is read.
 *
 * Mutates and returns `schema`. Returns the number of closed schema objects
 * that gained at least one property.
 */
function composeEnvelopeIntoClosedSchemas(schema, envelopeProperties) {
  if (!composesProtocolEnvelope(schema)) return 0;
  let extended = 0;

  function visit(node) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.additionalProperties === false) {
      const properties = node.properties || {};
      let added = false;
      for (const { name, ref } of envelopeProperties) {
        if (Object.prototype.hasOwnProperty.call(properties, name)) continue;
        properties[name] = { $ref: ref };
        added = true;
      }
      if (added) {
        node.properties = properties;
        extended++;
      }
    }
    for (const keyword of COMPOSITION_KEYWORDS) {
      if (!Array.isArray(node[keyword])) continue;
      for (const member of node[keyword]) visit(member);
    }
  }

  visit(schema);
  return extended;
}

const envelopePropertiesBySourceDir = new Map();

/**
 * The envelope property list for a source tree, read once per tree. Returns
 * null for a tree without `core/protocol-envelope.json`, such as a test
 * fixture, so the transform is then a no-op.
 */
function envelopePropertiesFor(sourceDir) {
  const key = path.resolve(sourceDir);
  if (!envelopePropertiesBySourceDir.has(key)) {
    const envelopePath = path.join(key, PROTOCOL_ENVELOPE_REF.slice('/schemas/'.length));
    envelopePropertiesBySourceDir.set(
      key,
      fs.existsSync(envelopePath) ? envelopeWireProperties(key) : null,
    );
  }
  return envelopePropertiesBySourceDir.get(key);
}

/**
 * Read a source schema document and compose the envelope into its closed
 * schema objects. Every build stage that reads a source document goes
 * through this function, so the flat tree, the bundled tree and the MCP
 * projection publish the same composition.
 */
function readComposedSourceSchema(filePath, sourceDir) {
  const schema = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const envelopeProperties = envelopePropertiesFor(sourceDir);
  if (envelopeProperties) composeEnvelopeIntoClosedSchemas(schema, envelopeProperties);
  return schema;
}

module.exports = {
  PROTOCOL_ENVELOPE_REF,
  DOCUMENTARY_ENVELOPE_PROPERTIES,
  envelopeWireProperties,
  composesProtocolEnvelope,
  composeEnvelopeIntoClosedSchemas,
  readComposedSourceSchema,
};
