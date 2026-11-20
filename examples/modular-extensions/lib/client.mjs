// A minimal buyer SDK client: core tasks + whatever extensions adcp.lock.json lists. It works on the
// wire form. Apps use it through their generated layer (adcp-sdk/, lib/binding.mjs), which decodes
// each response to plain attributes and adds one typed method per contributed task. Its `extensions`
// option and ext() are the runtime binding, for a runtime plug-in that enables an extension at run time.
//
// The proposal flow is request_proposals -> refine_proposals (finalize) -> accept_proposal:
// request_proposals returns canonical proposals (core/canonical-proposal.json) that carry
// commercial_terms and terms_digest. get_products is kept for discovery-time pricing options
// (the pricing_option extension point lives on the core-model option files); its `proposals` are legacy
// core/proposal.json plans with no commercial_terms, so this client does not read them.
//
// What the developer gets without writing any extension plumbing:
//  - requests carry understood_extensions (exactly the locked uri@digest set),
//    so the seller only sends must-understand data this app can handle;
//  - every response is validated against the pinned core, then each piece of
//    extension data at a hook (an entry at an extension point, or an open-union branch) against its module
//    (fail closed on must-understand, ignore optional); a product option whose
//    pricing branch the app does not understand is dropped with a warning
//    (unknown_in_list: drop_option), and the product keeps its other options;
//  - acceptProposal recomputes terms_digest before signing;
//  - readback that breaks the accepted terms is reported as violations
//    (onViolation), not silently accepted;
//  - the change feed (account.change_recorded) is validated and handed to the app;
//  - the seller's module versions (the optional `modules` map in its capabilities) are checked
//    against the module versions this app's lock pins (lib/modules.mjs): another major or another
//    digest at the same version fails, and a core task whose module the seller doesn't list is refused;
//  - a task an extension contributes is callable by its descriptor (callTask), and, in the runtime
//    binding, as client.ext(module).<task>(request). The
//    client finds the transport name the seller declared for that task id at the exact uri@digest
//    the app enabled, validates the request and the response against the extension's
//    definitions, and runs the module's check() on the response.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuyerValidator, loadModule, negotiate, pruneDropped } from './buyer-validator.mjs';
import { refKey, termsDigest } from './digest.mjs';
import { coreBundleDigest, layerDigests } from '../scripts/build-core.mjs';
import { checkModules, expectedModules, taskModules } from './modules.mjs';

export class AdcpClientError extends Error {
  constructor(code, message, report) {
    super(message);
    this.code = code;
    this.report = report;
  }
}

const SCHEMAS = {
  capabilities: '/schemas/protocol/get-adcp-capabilities-response.json',
  proposal: '/schemas/core/canonical-proposal.json',
  product: '/schemas/core/product.json',
  requestProposals: '/schemas/media-buy/request-proposals-response.json',
  mediaBuys: '/schemas/media-buy/get-media-buys-response.json',
  change: '/schemas/core/account-change.json',
};

/**
 * Two ways to enable extensions:
 *  - lockfile:   adcp.lock.json written by scripts/adcp-sdk.mjs (pins exact digests); the generated
 *                layer passes it;
 *  - extensions: the installed extension modules themselves (the runtime binding, for runtime plug-ins).
 */
export async function createAdcpClient({ transport, extensions = [], lockfile, onViolation = () => {} }) {
  const modules = [];
  let lock = null;
  for (const ns of extensions) {
    const m = await loadModule(fileURLToPath(ns.EXTENSION_MODULE_DIR)); // re-verifies the digest from bytes
    if (m.uri !== ns.EXTENSION_URI || m.digest !== ns.EXTENSION_DIGEST) {
      throw new AdcpClientError('MODULE_MISMATCH', `${ns.EXTENSION_URI}: types were generated for ${ns.EXTENSION_DIGEST}, runtime bundle is ${m.digest}`);
    }
    modules.push(m);
  }
  if (lockfile) {
    const lockPath = lockfile instanceof URL ? fileURLToPath(lockfile) : lockfile;
    lock = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (lock.core.modules) {
      // The app pins the kernel layer and the modules it names, not the whole bundle: a release of
      // another module doesn't touch it.
      const installed = layerDigests();
      for (const [layer, pin] of Object.entries(lock.core.modules)) {
        if (installed[layer] !== pin.digest) {
          throw new AdcpClientError('CORE_MISMATCH', `adcp.lock.json pins ${layer} ${pin.version} at ${pin.digest}; the installed core has ${installed[layer] ?? 'no such layer'}. Re-run adcp-sdk.`);
        }
      }
    } else if (lock.core.bundle_digest !== coreBundleDigest()) {
      throw new AdcpClientError('CORE_MISMATCH', `adcp.lock.json was built for core ${lock.core.bundle_digest}; the installed core differs. Re-run adcp-sdk.`);
    }
    const appDir = path.dirname(lockPath);
    for (const [alias, e] of Object.entries(lock.extensions)) {
      if (modules.some((m) => m.uri === e.uri && m.digest === e.digest)) continue;
      const m = await loadModule(path.resolve(appDir, e.module));
      if (m.uri !== e.uri || m.digest !== e.digest) throw new AdcpClientError('LOCK_MISMATCH', `${alias}: module is ${m.uri}@${m.digest}`);
      modules.push(m);
    }
  }
  const validator = createBuyerValidator({ modules });
  const understood = modules.map(({ uri, digest }) => ({ uri, digest }));

  const record = (report, what, payload) => {
    client.lastReport = report;
    client.lastReports.push(report);
    if (!report.ok) {
      throw new AdcpClientError(report.errors[0].code, `${what}: ${report.errors.map((e) => `${e.code} ${e.message}`).join('; ')}`, report);
    }
    for (const v of report.violations) onViolation(v, payload);
    return report;
  };

  const client = {
    modules,
    lastReport: null,
    /** Every validation report of the last task call, in order (lastReport is the final one). */
    lastReports: [],
    /** The seller's last validated capabilities, with the negotiation result. */
    sellerCapabilities: null,
    /** The last contributed-task call: { name, task } (transport name and task id). */
    lastTaskCall: null,

    check(schemaId, payload, what) {
      return record(validator.validate(schemaId, payload), what, payload);
    },

    async capabilities() {
      const caps = await transport.call('get_adcp_capabilities', {});
      client.lastReports = [];
      client.check(SCHEMAS.capabilities, caps, 'get_adcp_capabilities');
      client.sellerCapabilities = {
        ...caps,
        negotiation: negotiate(caps.declared_extensions ?? [], modules),
        // The seller's module versions against this app's: null when the seller lists none (a 3.3 seller).
        moduleCheck: caps.modules ? checkModules(caps.modules, expectedModules(lock)) : null,
      };
      return structuredClone(client.sellerCapabilities);
    },

    /**
     * Refuse a core task when the seller's `modules` map (read by capabilities()) shows it can't serve it
     * for this app: a module the task needs is absent (MODULE_NOT_OFFERED), on another major
     * (MODULE_MAJOR_MISMATCH), or at this app's version with another digest (MODULE_DIGEST_MISMATCH).
     * Nothing is checked before capabilities() ran, or when the seller lists no modules.
     */
    requireModules(task) {
      const check = client.sellerCapabilities?.moduleCheck;
      if (!check) return;
      for (const name of taskModules()[task] ?? []) {
        const e = check.entries.find((x) => x.name === name);
        if (!e || e.status === 'not-offered') throw new AdcpClientError('MODULE_NOT_OFFERED', `${task}: the seller lists no ${name} in its modules`);
        if (e.status.startsWith('MODULE_')) throw new AdcpClientError(e.status, `${task}: ${check.errors.find((x) => x.name === name).message}`);
      }
    },

    /**
     * Call a task an extension contributes (a generated descriptor, such as
     * makegoodUnits.tasks.requestMakegood). Fails with EXTENSION_NOT_ENABLED when the app did not
     * enable that exact uri@digest, and TASK_NOT_DECLARED when the seller declares no transport
     * name for the task at that digest.
     */
    async callTask(task, request) {
      if (!validator.installed.has(refKey(task.uri, task.digest))) {
        throw new AdcpClientError('EXTENSION_NOT_ENABLED', `${task.id}: enable ${task.uri}@${task.digest} to call this task`);
      }
      const caps = client.sellerCapabilities ?? (await client.capabilities());
      const binding = caps.negotiation.tasks[task.id];
      if (!binding || binding.digest !== task.digest) {
        throw new AdcpClientError('TASK_NOT_DECLARED', `${task.id}: the seller declares no transport name for this task at ${task.digest}`);
      }
      client.lastReports = [];
      record(validator.validateTask(task, 'request', request), `${task.id} request`, request);
      client.lastTaskCall = { name: binding.name, task: task.id };
      const res = await transport.call(binding.name, request);
      record(validator.validateTask(task, 'response', res, { request }), `${task.id} response`, res);
      return res;
    },

    /**
     * Runtime binding: one method per task the module contributes, client.ext(module).<task>(request).
     * The module must be enabled on this client. A generated layer has client.<task>(request) instead.
     */
    ext(module) {
      if (!validator.installed.has(refKey(module.EXTENSION_URI, module.EXTENSION_DIGEST))) {
        throw new AdcpClientError('EXTENSION_NOT_ENABLED', `${module.EXTENSION_URI}@${module.EXTENSION_DIGEST} is not enabled on this client`);
      }
      return Object.fromEntries(Object.entries(module.tasks ?? {}).map(([name, task]) => [name, (request) => client.callTask(task, request)]));
    },

    /** Discovery: products and their pricing options (legacy proposals in the response are not read). */
    async getProducts(request) {
      client.requireModules('get_products');
      const res = await transport.call('get_products', { ...request, understood_extensions: understood });
      client.lastReports = [];
      if (res.products) {
        res.products = res.products.map((p) => {
          const { dropped } = client.check(SCHEMAS.product, p, `product ${p.product_id}`);
          return dropped.length ? pruneDropped(p, dropped) : p;
        });
      }
      return res;
    },

    /** Proposals: draft canonical proposals (commercial_terms + terms_digest) and the compact products they buy. */
    async requestProposals(request) {
      client.requireModules('request_proposals');
      const res = await transport.call('request_proposals', { ...request, understood_extensions: understood });
      client.lastReports = [];
      const { dropped } = client.check(SCHEMAS.requestProposals, res, 'request_proposals');
      return dropped.length ? pruneDropped(res, dropped) : res;
    },

    async refineProposals(request) {
      client.requireModules('refine_proposals');
      const res = await transport.call('refine_proposals', { ...request, understood_extensions: understood });
      client.lastReports = [];
      for (const p of res.proposals ?? []) client.check(SCHEMAS.proposal, p, `proposal ${p.proposal_id}`);
      return res;
    },

    async acceptProposal({ proposal, ...request }) {
      client.requireModules('accept_proposal');
      client.lastReports = [];
      client.check(SCHEMAS.proposal, proposal, `proposal ${proposal.proposal_id}`);
      if (termsDigest(proposal.commercial_terms) !== proposal.terms_digest) {
        throw new AdcpClientError('TERMS_DIGEST_MISMATCH', `proposal ${proposal.proposal_id}: terms_digest does not match its commercial_terms`);
      }
      return transport.call('accept_proposal', { ...request, proposal_id: proposal.proposal_id, proposal_terms_digest: proposal.terms_digest });
    },

    async getMediaBuys(request) {
      client.requireModules('get_media_buys');
      const res = await transport.call('get_media_buys', request);
      client.lastReports = [];
      client.check(SCHEMAS.mediaBuys, res, 'get_media_buys');
      return res;
    },

    onChange(handler) {
      return transport.subscribe((record) => {
        client.check(SCHEMAS.change, record, `change ${record.change_id}`);
        return handler(record);
      });
    },
  };
  return client;
}
