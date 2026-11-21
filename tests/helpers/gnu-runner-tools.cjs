"use strict";
// Release workflow steps run on ubuntu-latest and call GNU-only tools
// (`timeout`, `stat -c`). Tests that execute those steps locally put
// node implementations of exactly those forms on PATH when the host isn't
// Linux. On Linux, PATH is unchanged and the runner's own tools are used.
const path = require("node:path");

const TOOLS_DIR = path.join(__dirname, "gnu-runner-tools");

function runnerPath(basePath = process.env.PATH) {
  if (process.platform === "linux") return basePath;
  return `${TOOLS_DIR}${path.delimiter}${basePath}`;
}

module.exports = { TOOLS_DIR, runnerPath };
