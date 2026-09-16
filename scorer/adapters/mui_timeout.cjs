// Versioned oracle profile, loaded by Mocha --require, never NODE_OPTIONS.
// Setters retain Mocha's parsing, disabled-timeout semantics and active timer reset.
// Adjust the effective getter rather than multiplying setters: inherited/cloned
// budgets must not grow every time Mocha copies them. Assertions/retries stay native.
const path = require("path");
const mochaRoot = path.dirname(require.resolve("mocha/package.json", { paths: [process.cwd()] }));
const version = require(path.join(mochaRoot, "package.json")).version;
if (version !== EXPECTED_MOCHA_VERSION) throw new Error(`Unsupported profile Mocha: ${version}`);
const Runnable = require(path.join(mochaRoot, "lib/runnable.js"));
const nativeTimeout = Runnable.prototype.timeout;
Runnable.prototype.timeout = function (value) {
  if (arguments.length) return nativeTimeout.apply(this, arguments);
  const configured = nativeTimeout.call(this);
  return Number.isFinite(configured) && configured > 0
    ? Math.max(configured, MINIMUM_TIMEOUT_MS)
    : configured;
};
