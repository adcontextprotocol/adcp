import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Route Safety Tests — Static Analysis
 *
 * Prevents self-referencing redirects: a route handler that redirects to a path
 * matching itself, causing an infinite redirect loop.
 *
 * For sub-routers, the effective path is mount prefix + route path. If a handler
 * on pageRouter.get("/accounts") mounted at "/admin" redirects to "/admin/accounts",
 * that's an infinite loop.
 *
 * Parses source files with regex — no server startup needed.
 */

const SRC_DIR = path.resolve(__dirname, '../../src');
const HTTP_FILE = path.join(SRC_DIR, 'http.ts');
const ROUTES_DIR = path.join(SRC_DIR, 'routes');

function readTsFiles(dir: string): { filePath: string; content: string }[] {
  const results: { filePath: string; content: string }[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...readTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      results.push({ filePath: full, content: fs.readFileSync(full, 'utf-8') });
    }
  }
  return results;
}

function normalizePath(p: string): string {
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

/**
 * Extract router.use() mount points from http.ts.
 */
function extractMounts(httpContent: string): { prefix: string; routerVar: string }[] {
  const mounts: { prefix: string; routerVar: string }[] = [];
  const re = /this\.app\.use\(\s*['"]([^'"]+)['"]\s*,\s*(\w+)\s*\)/g;
  let m;
  while ((m = re.exec(httpContent)) !== null) {
    mounts.push({ prefix: m[1], routerVar: m[2] });
  }
  return mounts;
}

/**
 * Find redirect handlers in sub-router files and pair each redirect
 * with its enclosing route definition.
 */
function findSubRouterRedirects(filePath: string, content: string) {
  const results: {
    file: string;
    routerVar: string;
    method: string;
    routePath: string;
    redirectTarget: string;
    line: number;
  }[] = [];

  // Find route definitions: routerVar.method("path", ...)
  const routeDefs: { routerVar: string; method: string; routePath: string; lineIdx: number }[] = [];
  const routeRe = /(\w+)\.(get|post|put|delete|patch)\(\s*["']([^"']+)["']/g;
  let m;
  while ((m = routeRe.exec(content)) !== null) {
    if (['this', 'express', 'app'].includes(m[1])) continue;
    routeDefs.push({
      routerVar: m[1],
      method: m[2],
      routePath: m[3],
      lineIdx: content.substring(0, m.index).split('\n').length - 1,
    });
  }

  // Find redirect calls with static targets
  const redirectRe = /res\.redirect\(\s*(?:\d+\s*,\s*)?['"](\/.+?)['"]\s*\)/g;
  while ((m = redirectRe.exec(content)) !== null) {
    const redirectTarget = m[1];
    const redirectLineIdx = content.substring(0, m.index).split('\n').length - 1;

    // Find enclosing route (nearest definition above)
    let enclosing = null;
    for (let i = routeDefs.length - 1; i >= 0; i--) {
      if (routeDefs[i].lineIdx <= redirectLineIdx) {
        enclosing = routeDefs[i];
        break;
      }
    }

    if (enclosing) {
      results.push({
        file: filePath,
        routerVar: enclosing.routerVar,
        method: enclosing.method,
        routePath: enclosing.routePath,
        redirectTarget,
        line: redirectLineIdx + 1,
      });
    }
  }
  return results;
}

/**
 * Find redirect handlers registered directly on this.app in http.ts.
 * Uses brace-depth tracking to scope each redirect to its enclosing route.
 */
function findMainAppRedirects(httpContent: string) {
  const results: {
    method: string;
    routePath: string;
    redirectTarget: string;
    line: number;
  }[] = [];

  // Find all this.app.METHOD('/path', ...) route registrations
  const routeRe = /this\.app\.(get|post|put|delete|patch)\(\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = routeRe.exec(httpContent)) !== null) {
    const method = m[1];
    const routePath = m[2];
    const routeStart = m.index;

    // Track brace depth from the opening paren of .get( to find the closing )
    // Look for redirect only within this route handler
    let depth = 0;
    let foundOpen = false;
    let handlerEnd = routeStart + 500; // fallback
    for (let i = routeStart; i < httpContent.length && i < routeStart + 2000; i++) {
      const ch = httpContent[i];
      if (ch === '(') { depth++; foundOpen = true; }
      if (ch === ')') { depth--; }
      if (foundOpen && depth === 0) { handlerEnd = i; break; }
    }

    const handlerBody = httpContent.substring(routeStart, handlerEnd);
    const redirectMatch = handlerBody.match(/res\.redirect\(\s*(?:\d+\s*,\s*)?['"](\/.+?)['"]\s*\)/);
    if (redirectMatch) {
      const line = httpContent.substring(0, routeStart).split('\n').length;
      results.push({ method, routePath, redirectTarget: redirectMatch[1], line });
    }
  }
  return results;
}

describe('route safety', () => {
  const httpContent = fs.readFileSync(HTTP_FILE, 'utf-8');
  const mounts = extractMounts(httpContent);
  const routeFiles = readTsFiles(ROUTES_DIR);

  it('sub-router routes must not redirect to their own effective path', () => {
    const violations: string[] = [];

    for (const routeFile of routeFiles) {
      const redirects = findSubRouterRedirects(routeFile.filePath, routeFile.content);
      for (const redirect of redirects) {
        for (const mount of mounts) {
          const effectivePath = normalizePath(mount.prefix + redirect.routePath);
          const target = normalizePath(redirect.redirectTarget);
          if (effectivePath === target) {
            const relFile = path.relative(SRC_DIR, redirect.file);
            violations.push(
              `${relFile}:${redirect.line} — ` +
              `${redirect.routerVar}.${redirect.method}("${redirect.routePath}") ` +
              `redirects to "${redirect.redirectTarget}" ` +
              `(= mount "${mount.prefix}" + route path) → infinite redirect loop`,
            );
          }
        }
      }
    }

    expect(violations, violations.join('\n')).toHaveLength(0);
  });

  it('main app routes must not redirect to themselves', () => {
    const violations: string[] = [];

    for (const redirect of findMainAppRedirects(httpContent)) {
      if (normalizePath(redirect.routePath) === normalizePath(redirect.redirectTarget)) {
        violations.push(
          `http.ts:${redirect.line} — ` +
          `this.app.${redirect.method}("${redirect.routePath}") ` +
          `redirects to "${redirect.redirectTarget}" → infinite redirect loop`,
        );
      }
    }

    expect(violations, violations.join('\n')).toHaveLength(0);
  });
});
