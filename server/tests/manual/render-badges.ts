import { renderBadgeSvg, VALID_BADGE_ROLES } from '../../src/services/badge-svg.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const outDir = mkdtempSync(join(tmpdir(), 'aao-badges-'));

for (const role of VALID_BADGE_ROLES) {
  writeFileSync(join(outDir, `badge-verified-${role}.svg`), renderBadgeSvg(role, true));
}
writeFileSync(join(outDir, 'badge-not-verified.svg'), renderBadgeSvg('media-buy', false));

console.log(`All SVGs written to ${outDir}/`);
