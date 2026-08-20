// Which builds are still allowed to run.
//
// Most of these pin the *fail-open* rule rather than the blocking rule, and
// that is deliberate: blocking is easy to get right and cheap to get wrong in
// one direction only. Every test that asserts `null` here is asserting that
// some malformed or missing thing did not brick the whole fleet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { updateBlockFor } from "../.test-build/lib/updateGate.js";

const at = (installed, config) => updateBlockFor({ installed, config });

test("no config is not a refusal", () => {
  // The unreachable case. If this ever blocks, every offline launch is a wall.
  assert.equal(at("0.2.0", null), null);
  assert.equal(at("0.2.0", undefined), null);
});

test("an empty config is not a refusal", () => {
  assert.equal(at("0.2.0", {}), null);
});

test("not knowing our own version is not grounds for blocking ourselves", () => {
  assert.equal(at(null, { minimumVersion: "9.0.0" }), null);
  assert.equal(at("", { minimumVersion: "9.0.0" }), null);
});

test("below the floor is a refusal", () => {
  const block = at("0.2.0", { minimumVersion: "0.3.0" });
  assert.equal(block?.reason, "too-old");
  assert.equal(block?.installed, "0.2.0");
  assert.equal(block?.required, "0.3.0");
});

test("at the floor, and above it, are both allowed", () => {
  assert.equal(at("0.3.0", { minimumVersion: "0.3.0" }), null);
  assert.equal(at("0.4.0", { minimumVersion: "0.3.0" }), null);
});

test("a floor nobody can parse is no floor at all", () => {
  // The typo case. A bad value in one JSON field must not become a wall.
  assert.equal(at("0.2.0", { minimumVersion: "latest" }), null);
  assert.equal(at("0.2.0", { minimumVersion: "" }), null);
  assert.equal(at("0.2.0", { minimumVersion: null }), null);
});

test("the floor excludes a prerelease of the floor version", () => {
  const block = at("0.3.0-beta.1", { minimumVersion: "0.3.0" });
  assert.equal(block?.reason, "too-old");
});

test("a named build is withdrawn regardless of the floor", () => {
  const block = at("0.4.1", { minimumVersion: "0.4.0", killedVersions: ["0.4.1"] });
  assert.equal(block?.reason, "withdrawn");
  // The point of a kill-switch: 0.4.1 is above the floor and still refused.
  assert.equal(at("0.4.2", { minimumVersion: "0.4.0", killedVersions: ["0.4.1"] }), null);
  assert.equal(at("0.4.0", { minimumVersion: "0.4.0", killedVersions: ["0.4.1"] }), null);
});

test("withdrawn is reported ahead of too-old when a build is both", () => {
  const block = at("0.1.0", { minimumVersion: "0.3.0", killedVersions: ["0.1.0"] });
  assert.equal(block?.reason, "withdrawn");
});

test("the withdrawn list is matched as versions, not as strings", () => {
  assert.equal(at("0.4.1", { killedVersions: ["v0.4.1"] })?.reason, "withdrawn");
  assert.equal(at("v0.4.1", { killedVersions: ["0.4.1"] })?.reason, "withdrawn");
});

test("an unreadable entry in the withdrawn list withdraws nothing", () => {
  assert.equal(at("0.4.1", { killedVersions: ["", "nonsense", null] }), null);
  // And a good entry beside a bad one still works.
  assert.equal(at("0.4.1", { killedVersions: ["nonsense", "0.4.1"] })?.reason, "withdrawn");
});

test("a withdrawn list that is not a list is ignored", () => {
  assert.equal(at("0.4.1", { killedVersions: "0.4.1" }), null);
});

test("too-old points at the version they will actually get", () => {
  // The floor is what they must clear; latestVersion is what the download page
  // will hand them, and that is the number worth showing.
  const block = at("0.2.0", { minimumVersion: "0.3.0", latestVersion: "0.5.0" });
  assert.equal(block?.required, "0.5.0");
});

test("too-old falls back to the floor when there is no latest", () => {
  assert.equal(at("0.2.0", { minimumVersion: "0.3.0" })?.required, "0.3.0");
});

test("withdrawn shows the latest version, or nothing when unknown", () => {
  assert.equal(at("0.4.1", { killedVersions: ["0.4.1"], latestVersion: "0.4.2" })?.required, "0.4.2");
  assert.equal(at("0.4.1", { killedVersions: ["0.4.1"] })?.required, null);
});

test("links are carried through, and blank ones read as absent", () => {
  const block = at("0.2.0", {
    minimumVersion: "0.3.0",
    downloadUrl: "https://example.com/download",
    notesUrl: "  ",
  });
  assert.equal(block?.downloadUrl, "https://example.com/download");
  // A button with nowhere to go is worse than no button; the screen checks.
  assert.equal(block?.notesUrl, null);
});

test("a config full of unexpected shapes still decides something safe", () => {
  // Whatever the backend grows next must not reach a person as a locked app.
  assert.equal(at("0.2.0", { somethingNew: true, minimumVersion: undefined }), null);
});
