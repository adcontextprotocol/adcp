import { renderBadgeSvg } from '../../src/services/badge-svg.js';
import { writeFileSync } from 'fs';

const roles = ['sales', 'buying', 'creative', 'governance', 'signals', 'measurement'];
for (const role of roles) {
  writeFileSync(`/tmp/badge-verified-${role}.svg`, renderBadgeSvg(role, true));
}
writeFileSync('/tmp/badge-not-verified.svg', renderBadgeSvg('sales', false));
console.log('All SVGs written to /tmp/');
