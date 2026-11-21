'use strict';

/**
 * Records the files a Node process tree touches, for read-set tests.
 *
 *   NODE_OPTIONS="--require <this file>" FS_TRACE_DIR=<dir> node ...
 *
 * Every process appends `<op>\t<absolute path>` lines to <dir>/<pid>.log.
 * Child Node processes inherit NODE_OPTIONS and FS_TRACE_DIR, so a build and
 * every lint or helper it spawns are traced. Ops:
 *
 *   read     file contents read (readFile*, open* without a write flag,
 *            createReadStream, copyFile source)
 *   readdir  directory listed (readdir*, opendir*)
 *   stat     metadata or existence checked (stat*, lstat*, exists*, access*)
 *   write    created, changed or removed (writeFile*, appendFile*, open* with
 *            a write flag, createWriteStream, mkdir*, rm*, rmdir*, unlink*,
 *            rename*, copyFile destination, cp*, symlink*, truncate*, utimes*)
 *   load     a module file loaded by require() or import
 *
 * The patches wrap the public node:fs, node:fs/promises and module APIs and
 * call module.syncBuiltinESMExports(), so `import { readFileSync } from
 * 'node:fs'` sees them too. Module loads come from module.registerHooks, which
 * sees both CommonJS and ES module loads in this thread.
 */

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');

const TRACE_DIR = process.env.FS_TRACE_DIR;

if (TRACE_DIR) {
  const logFile = path.join(TRACE_DIR, `${process.pid}.log`);
  const original = {
    appendFileSync: fs.appendFileSync,
    mkdirSync: fs.mkdirSync,
  };
  original.mkdirSync.call(fs, TRACE_DIR, { recursive: true });
  let recording = false;

  const toPath = (target) => {
    if (typeof target === 'number' || target === undefined || target === null) return null;
    if (target instanceof URL) return target.protocol === 'file:' ? fileURLToPath(target) : null;
    if (Buffer.isBuffer(target)) return path.resolve(target.toString());
    if (typeof target === 'string') {
      if (target.startsWith('file:')) return fileURLToPath(target);
      return path.resolve(target);
    }
    if (typeof target === 'object' && typeof target.path === 'string') return path.resolve(target.path); // FileHandle-like
    return null;
  };

  // Lines are buffered and flushed every FLUSH_AT records and at exit, so the
  // tracer costs little; a process killed by a signal loses its unflushed tail.
  const FLUSH_AT = 2000;
  let buffer = [];
  const flush = () => {
    if (buffer.length === 0) return;
    const text = buffer.join('');
    buffer = [];
    recording = true;
    try {
      original.appendFileSync.call(fs, logFile, text);
    } catch {
      // Tracing must never change the traced program's behavior.
    } finally {
      recording = false;
    }
  };
  process.on('exit', flush);

  const record = (op, target) => {
    if (recording) return;
    let file;
    try { file = toPath(target); } catch { return; }
    if (!file || file.startsWith(TRACE_DIR)) return;
    buffer.push(`${op}\t${file}\n`);
    if (buffer.length >= FLUSH_AT) flush();
  };

  const isWriteFlag = (flags) => {
    if (flags === undefined || flags === null) return false;
    if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0;
    return /[wa+]/.test(String(flags));
  };
  const flagsOf = (options, fallback) => {
    if (typeof options === 'string' || typeof options === 'number') return options;
    if (options && typeof options === 'object' && options.flags !== undefined) return options.flags;
    if (options && typeof options === 'object' && options.flag !== undefined) return options.flag;
    return fallback;
  };

  const wrap = (object, name, onCall) => {
    const fn = object[name];
    if (typeof fn !== 'function' || fn.__fsTraced) return;
    const wrapped = function traced(...args) {
      try { onCall(...args); } catch { /* never interfere */ }
      return fn.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: fn.name });
    wrapped.__fsTraced = true;
    if (fn.native) wrapped.native = fn.native;
    for (const key of Object.getOwnPropertySymbols(fn)) wrapped[key] = fn[key];
    object[name] = wrapped;
  };

  const as = (op) => (target) => record(op, target);
  const readOrWriteByFlags = (fallbackFlags) => (target, flagsOrOptions) => {
    record(isWriteFlag(flagsOf(flagsOrOptions, fallbackFlags)) ? 'write' : 'read', target);
  };
  const readFileOp = (target, options) => {
    // readFile with a write-capable flag is still a read of the contents.
    record('read', target);
    if (isWriteFlag(flagsOf(options, 'r'))) record('write', target);
  };
  const copy = (source, destination) => { record('read', source); record('write', destination); };
  const rename = (source, destination) => { record('write', source); record('write', destination); };

  const syncAndCallback = {
    readFile: readFileOp,
    open: readOrWriteByFlags('r'),
    readdir: as('readdir'),
    opendir: as('readdir'),
    stat: as('stat'),
    lstat: as('stat'),
    exists: as('stat'),
    access: as('stat'),
    realpath: as('stat'),
    readlink: as('stat'),
    writeFile: as('write'),
    appendFile: as('write'),
    mkdir: as('write'),
    mkdtemp: as('write'),
    rm: as('write'),
    rmdir: as('write'),
    unlink: as('write'),
    truncate: as('write'),
    utimes: as('write'),
    chmod: as('write'),
    symlink: (_target, linkPath) => record('write', linkPath),
    link: (_existing, newPath) => record('write', newPath),
    rename,
    copyFile: copy,
    cp: copy,
  };

  for (const [name, onCall] of Object.entries(syncAndCallback)) {
    wrap(fs, name, onCall);
    wrap(fs, `${name}Sync`, onCall);
    if (fs.promises && name !== 'exists') wrap(fs.promises, name, onCall);
  }
  wrap(fs.realpathSync, 'native', as('stat'));
  wrap(fs.realpath, 'native', as('stat'));
  wrap(fs, 'createReadStream', (target) => record('read', target));
  wrap(fs, 'createWriteStream', (target) => record('write', target));
  Module.syncBuiltinESMExports();

  if (typeof Module.registerHooks === 'function') {
    Module.registerHooks({
      load(url, context, nextLoad) {
        if (url.startsWith('file:')) record('load', url);
        return nextLoad(url, context);
      },
    });
  }
}
