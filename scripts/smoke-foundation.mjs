import {
  canonicalize,
  specHash,
  merkleRoot,
  validateSiteSpec,
  slugify,
  normalizePath,
  resolveWithin,
  withDefaults,
  batchJobSchema,
} from "../packages/spec-schema/dist/index.js";

const eq = (label, actual, expected) =>
  console.log((JSON.stringify(actual) === JSON.stringify(expected) ? "ok   " : "FAIL ") + label + "  " + JSON.stringify(actual));

eq("canonicalize sorts + normalizes -0", canonicalize({ b: 1, a: [3, { z: 1, y: -0 }], c: "x\ny" }), '{"a":[3,{"y":0,"z":1}],"b":1,"c":"x\\ny"}');
// A SiteSpec hash covers the whole document, meta included: two specs that
// differ anywhere are different specs. Only a *SpecEnvelope* has its
// provenance stripped, because `meta` there records when and with what
// compiler a spec was produced rather than what the site is.
eq("spec_hash covers meta", specHash({ meta: { ts: 1 }, pages: [] }) !== specHash({ meta: { ts: 2 }, pages: [] }), true);
eq("spec_hash strips envelope provenance", specHash({ spec: { pages: [] }, meta: { compiler_version: "1.0.0", spec_hash: "blake3:abc", ts: 1 } }) === specHash({ spec: { pages: [] }, meta: { compiler_version: "1.0.0", spec_hash: "blake3:abc", ts: 2 } }), true);
eq("spec_hash sensitive to content", specHash({ a: 1 }) !== specHash({ a: 2 }), true);
eq("merkle root is order independent", merkleRoot([{ path: "b.html", bytes: 2, sha256: "aa" }, { path: "a.html", bytes: 1, sha256: "bb" }]) === merkleRoot([{ path: "a.html", bytes: 1, sha256: "bb" }, { path: "b.html", bytes: 2, sha256: "aa" }]), true);
eq("slugify transliterates", slugify("Café Norström & Söhne — Studio 12!"), "cafe-norstrom-sohne-studio-12");
eq("slugify refuses reserved", [slugify("API"), slugify("con")], ["page-api", "page-con"]);
eq("normalizePath", normalizePath("about//team/"), "/about/team");
eq("resolveWithin ok", resolveWithin("C:\\root", "a/b.html"), "C:\\root\\a\\b.html");
try {
  resolveWithin("C:\\root", "../evil");
  console.log("FAIL traversal not blocked");
} catch {
  console.log("ok   traversal blocked");
}
const bad = { meta: { title: "x", description: "y", locale: "en", theme: "light" }, design: { archetype: "a", tokens: {} }, pages: [] };
eq("invalid spec reports issues", validateSiteSpec(bad).issues.length > 0, true);
eq("defaults materialize", withDefaults(batchJobSchema, { batch_id: "b_1", template: "t", prompts: [{ site_id: "s", prompt: "hello world" }] }).policies.deadline_ms, 5400000);
console.log("foundation ok");
