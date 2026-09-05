// Code-owned trust root for the reviewed paper-slide public manifest.
(function (root) {
  "use strict";

  // Publication replaces null with build_public_index_shards(...).manifest_sha256
  // and bumps this asset's ?v= reference in the same release. A null pin is an
  // explicit fail-closed state: the viewer must not fetch or infer availability.
  root.PaperPilotPublicSlideTrustRoot = Object.freeze({
    schema_version: "paper-slide-public-trust-root-v1",
    manifest_path: "/automatic-paper-search/paper-slides-v1/manifest.json",
    manifest_sha256: null,
  });
})(typeof globalThis === "undefined" ? this : globalThis);
