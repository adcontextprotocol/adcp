#!/usr/bin/env node
/**
 * Bundle TipTap editor + extensions into a single IIFE for the admin pages.
 * Run: node scripts/build-tiptap.mjs
 * Output: server/public/vendor/tiptap.js
 */
import { build } from 'esbuild';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

await build({
  stdin: {
    contents: `
      import { Editor } from '@tiptap/core';
      import StarterKit from '@tiptap/starter-kit';
      import Link from '@tiptap/extension-link';
      window.TipTap = { Editor, StarterKit, Link };
    `,
    resolveDir: root,
    loader: 'js',
  },
  bundle: true,
  format: 'iife',
  outfile: resolve(root, 'server/public/vendor/tiptap.js'),
  minify: true,
  target: ['es2020'],
});

console.log('Built server/public/vendor/tiptap.js');
