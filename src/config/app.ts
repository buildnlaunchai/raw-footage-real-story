/**
 * App identity. Per TEMPLATE.md the slug is permanent once this app is registered
 * with the Build & Launch hub — it becomes the hub tool slug, the JWT `aud` value
 * the app must enforce, and the name of its own Postgres schema.
 *
 * It is a compile-time constant on purpose, not an env var: an identity that a
 * deployer can change is an identity an attacker can change.
 */
export const APP_SLUG = "raw-footage-real-story";

export const APP_NAME = "Raw Footage, Real Story";

/**
 * v1 is always standalone and fully offline. `embedded` is the v2 hub seam:
 * verify the hub-signed JWT with `audience: APP_SLUG`, and never grant access
 * locally in that mode. Nothing reads this yet beyond defaulting.
 */
export type AppMode = "standalone" | "embedded";

export const APP_MODE: AppMode =
  import.meta.env.VITE_APP_MODE === "embedded" ? "embedded" : "standalone";
