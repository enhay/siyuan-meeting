"use strict";

/**
 * SiYuan evaluates a plugin's index.js with a plugin-scoped require that only
 * resolves "siyuan" specially; relative CommonJS requires are not reliable from
 * the evaluated entry. This tiny bundler keeps the readable modules under src/
 * and emits a single index.js with a local module table.
 *
 * Run: node tools/build.cjs
 */

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const entry = "src/main.js";
const files = [];

function collect(dir) {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) collect(relative);
    else if (entry.isFile() && /\.(?:js|cjs)$/.test(entry.name)) files.push(relative);
  }
}

collect("src");
files.push("capture/storage.cjs", "capture/realtime.cjs");
files.sort();

const moduleTable = files
  .map((id) => {
    const source = fs.readFileSync(path.join(root, id), "utf8");
    return `  ${JSON.stringify(id)}: function (module, exports, require) {\n${source}\n  }`;
  })
  .join(",\n");

const bundle = `/*
 * Generated file — do not edit directly.
 * Source: src/main.js and the modules under src/; run "node tools/build.cjs".
 * This plugin's summary prompt adaptation retains the Fastrepl MIT notice in
 * src/prompts.js.
 */
(function (hostRequire) {
  "use strict";

  var modules = {
${moduleTable}
  };
  var cache = {};

  function normalize(parts) {
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === ".") continue;
      if (part === "..") out.pop();
      else out.push(part);
    }
    return out.join("/");
  }

  function resolve(from, request) {
    if (request.charAt(0) !== ".") return null;
    var base = from.split("/").slice(0, -1);
    var parts = request.split("/");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "." || part === "") continue;
      if (part === "..") base.pop();
      else base.push(part);
    }
    var id = normalize(base);
    if (modules[id]) return id;
    if (modules[id + ".js"]) return id + ".js";
    if (modules[id + ".cjs"]) return id + ".cjs";
    return null;
  }

  function load(id) {
    if (cache[id]) return cache[id].exports;
    var module = { exports: {} };
    cache[id] = module;
    var localRequire = (function (from) {
      return function (request) {
        var resolved = resolve(from, request);
        return resolved ? load(resolved) : hostRequire(request);
      };
    })(id);
    modules[id](module, module.exports, localRequire);
    return module.exports;
  }

  module.exports = load(${JSON.stringify(entry)});
})(require);
`;

fs.writeFileSync(path.join(root, "index.js"), bundle);

// SiYuan reads a plugin's root index.css and injects it automatically; keep the
// readable source in src/styles.css and generate the package file here.
const styles = fs.readFileSync(path.join(root, "src", "styles.css"), "utf8");
fs.writeFileSync(
  path.join(root, "index.css"),
  `/* Generated from src/styles.css by tools/build.cjs — do not edit directly. */\n${styles}`,
);
process.stdout.write(`bundled ${files.length} modules into index.js and generated index.css\n`);
