/**
 * Whether the sign-in gate is switched on at all.
 *
 * **Off by default, and that is the point.** The gate blocks the entire
 * application, so a mistake here does not degrade a feature — it locks every
 * beta tester out of an app they were already asked to bypass Gatekeeper to
 * open. It stays dark until the platform endpoints exist, the app is signed
 * with a stable identity, and someone deliberately turns it on.
 *
 * Read from the build environment rather than a constant so that turning it on
 * for a staging build is a build flag and not a commit that could reach a
 * release by accident:
 *
 *   VITE_AUTH_GATE=on npm run tauri build
 *
 * Anything other than exactly "on" is off. There is no truthiness here on
 * purpose: an empty string, "false", "0" and a typo should all mean the safe
 * thing.
 */
export const AUTH_GATE_ENABLED: boolean = import.meta.env.VITE_AUTH_GATE === "on";
