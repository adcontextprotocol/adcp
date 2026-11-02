// @acmetv/adcp-ext-daypart-codes: vendor extension module. No semantic checks.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageDir = path.dirname(fileURLToPath(import.meta.url));
export const check = () => ({ errors: [], warnings: [] });
