/**
 * Asset fixtures for the run-level test kit of a hosted `comply()` run (#8882).
 *
 * The SDK loads a storyboard's declared kit (`prerequisites.test_kit`) only
 * when the run has no `test_kit` of its own. Hosted runs always have one:
 * `withHostedAuthTestKit` copies the owner's grading credential and probe task
 * into it. That kit carried nothing else, so `$build_assets_from_format` had
 * no `assets.images` to fill a required image slot, the step skipped as
 * `fixture_unavailable`, and storyboards that a seller passes with the
 * bundle's own kit graded `untested` on hosted heartbeats.
 *
 * `comply()` takes one kit for the whole run, so the hosted run carries the
 * asset fixtures of the kit the asset-building storyboards declare. Only
 * `assets` is copied: it is the one kit field the directive reads, and every
 * storyboard that uses the directive declares this kit. Other kit fields
 * (`brand`, `account`, `commercial_relationship`, `creative_build_probes`,
 * `creative_formats`, ...) would reach storyboards that declare a different
 * kit, so they stay out. The credential stays the hosted one.
 */

import type { TestOptions } from '@adcp/sdk/testing';

import type { TestKit } from '../services/storyboards.js';

/**
 * The brand kit the media-buy and creative storyboards declare
 * (`test-kits/acme-outdoor.yaml`). Every storyboard that builds a creative
 * with `$build_assets_from_format` declares it; a unit test keeps that true
 * for the source tree and every published bundle.
 */
export const HOSTED_RUN_FIXTURE_TEST_KIT_ID = 'acme_outdoor';
export const HOSTED_RUN_FIXTURE_TEST_KIT_PATH = 'test-kits/acme-outdoor.yaml';

/**
 * Add a bundle kit's `assets` to the hosted run-level test kit.
 *
 * Leaves the options alone when the run has no test kit, so the SDK still
 * loads each storyboard's declared kit itself, and when the run kit already
 * sets `assets`.
 */
export function withHostedRunFixtureTestKit<T extends Pick<TestOptions, 'test_kit'>>(
  options: T,
  resolveFixtureKit: () => TestKit | undefined,
): T {
  const runKit = options.test_kit;
  if (runKit === undefined || runKit.assets !== undefined) return options;
  const assets = resolveFixtureKit()?.assets;
  if (assets === undefined) return options;
  return { ...options, test_kit: { ...runKit, assets } };
}
