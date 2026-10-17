import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLE_NAME,
  BUNDLE_VERSION,
  bundleVersionFromLabels,
  classifyCompatibility,
  parseBundleStamp,
  REQUIRED_DAGU_VERSION,
} from "../src/bundle.ts";

test("package metadata is the bundle compatibility authority", () => {
  assert.equal(BUNDLE_NAME, "@a4s/omp-dagu");
  assert.equal(BUNDLE_VERSION, "0.3.13");
  assert.equal(REQUIRED_DAGU_VERSION, "2.20.1");
});

test("compatibility keeps major stable and also minor stable before 1.0", () => {
  assert.equal(classifyCompatibility("0.2.0", "0.2.0"), "ok");
  assert.equal(classifyCompatibility("0.2.9", "0.2.0"), "ok");
  assert.equal(classifyCompatibility("0.3.0", "0.2.0"), "incompatible");
  assert.equal(classifyCompatibility("1.2.0", "2.2.0"), "incompatible");
  assert.equal(classifyCompatibility(undefined, "0.2.0"), "unstamped");
  assert.equal(classifyCompatibility("1.9.0", "1.2.0"), "ok");
  assert.equal(classifyCompatibility("not-semver", "0.2.0"), "incompatible");
});

test("labels and exact line-one stamps are parsed", () => {
  assert.equal(bundleVersionFromLabels(["workspace=a4s", "dagu-feature-bundle=0.2.4"]), "0.2.4");
  assert.equal(bundleVersionFromLabels(["workspace=a4s"]), undefined);
  assert.deepEqual(
    parseBundleStamp(
      "# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=pablontiv/a4s@0123456789012345678901234567890123456789 bootstrap=bootstrap-a4s-0.2.0 dagu=2.20.1\nlabels:\n",
    ),
    {
      version: "0.2.0",
      source: "pablontiv/a4s@0123456789012345678901234567890123456789",
      bootstrap: "bootstrap-a4s-0.2.0",
      dagu: "2.20.1",
    },
  );
  assert.equal(parseBundleStamp("labels:\n# dagu-feature-bundle: @a4s/omp-dagu@0.2.0 source=x@y bootstrap=z dagu=2.20.1\n"), undefined);
});
