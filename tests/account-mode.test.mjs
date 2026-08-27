// The one thing the app has to remember for a member who goes offline on credit.
//
// Credit mode puts the platform in the data path: we call the provider on our
// key and bill credit for it. The app is built to keep working offline for a
// month — signed licence cached, projects open, exports run — and none of that
// helps a credit member, because every generation needs a hub that is not there.
//
// Offline it cannot ASK what mode the account is on, and the mode is not in the
// cached licence token either, because the platform does not sign it into the
// claims. So the last known answer is remembered. What follows is the whole
// contract of that memory, including the part that matters most: it changes what
// the app SAYS and never what it allows.
import { test } from "node:test";
import assert from "node:assert/strict";

/** A localStorage good enough to hold three strings, and to be made to fail. */
function installStorage({ throws = false } = {}) {
  const map = new Map();
  globalThis.localStorage = {
    getItem(k) {
      if (throws) throw new Error("storage is not available");
      return map.has(k) ? map.get(k) : null;
    },
    setItem(k, v) {
      if (throws) throw new Error("storage is not available");
      map.set(k, String(v));
    },
    removeItem(k) {
      if (throws) throw new Error("storage is not available");
      map.delete(k);
    },
  };
  return map;
}

const load = async (tag) =>
  await import(`../.test-build/lib/accountMode.js?${tag}`);

test("nothing is remembered before the platform has ever answered", async () => {
  installStorage();
  const { lastKnownMode, offlineModeNote } = await load("empty");
  assert.equal(lastKnownMode(), null);
  assert.equal(offlineModeNote(), null, "an unknown mode must not invent a sentence");
});

test("a credit account is remembered, and gets the sentence that explains it", async () => {
  const map = installStorage();
  const { lastKnownMode, offlineModeNote } = await load("credit");
  // providerKeyStatus() writes this on every successful call; the exported
  // helpers are what the screens read back. Written directly here because the
  // writer is private on purpose — nothing outside this module may set it.
  map.set("lastKnownKeyMode", "credit");

  assert.equal(lastKnownMode(), "credit");
  const note = offlineModeNote();
  assert.ok(note, "a credit member offline needs to be told why");
  assert.match(note, /credits/i);
  assert.match(note, /nothing is wrong with your account/i);
  assert.doesNotMatch(note, /membership|expired|renew/i,
    "being offline is not a billing problem and must not read like one");
});

test("a member on their own key is told nothing extra", async () => {
  const map = installStorage();
  const { offlineModeNote } = await load("byok");
  map.set("lastKnownKeyMode", "byok");
  // Offline is inconvenient for them, not disqualifying — their key still works
  // against their provider. The generic "couldn't check your account" is enough,
  // and adding a credit sentence would be a lie.
  assert.equal(offlineModeNote(), null);
});

test("signing out forgets it — the next person is not the last person", async () => {
  const map = installStorage();
  const { forgetMode, lastKnownMode } = await load("forget");
  map.set("lastKnownKeyMode", "credit");
  forgetMode();
  assert.equal(lastKnownMode(), null, "a shared machine must not leak the last account's billing");
});

test("a value that is not a mode is ignored rather than shown", async () => {
  const map = installStorage();
  const { lastKnownMode } = await load("junk");
  for (const junk of ["", "platform", "true", "{}"]) {
    map.set("lastKnownKeyMode", junk);
    assert.equal(lastKnownMode(), null, `${JSON.stringify(junk)} is not a mode`);
  }
});

test("storage that refuses is survivable, because this decides nothing", async () => {
  installStorage({ throws: true });
  const { lastKnownMode, offlineModeNote, forgetMode } = await load("nostorage");
  // A private window, a locked-down profile. Losing the hint costs a vaguer
  // sentence; throwing here would cost the screen.
  assert.equal(lastKnownMode(), null);
  assert.equal(offlineModeNote(), null);
  assert.doesNotThrow(() => forgetMode());
});
