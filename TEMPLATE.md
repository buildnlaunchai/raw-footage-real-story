# GOLDEN TEMPLATE — Standalone-First Distributable App

> Drop this file into any new app repo as `TEMPLATE.md`. Every app built for the
> Build & Launch AI ecosystem follows it. It exists so distribution is free: an app
> built this way is already a clean, deployable, embeddable package with zero extra work.

## Keeping the copies identical — a rule, because it has already failed

**This file lives in every app repo, and every copy must be byte-identical. Change one,
sync them all in the same sitting.** It is a document whose entire value is that the
warning reaches the repo about to make the mistake.

That is not a tidiness rule. On 2026-08-28 one app's copy was **93 lines behind** and was
missing the whole credit-mode section — and it was that very app that had just shipped the
credit-mode bug the missing section warns about. The advice existed. It was written down.
It simply was not in the repo where somebody would read it.

**A repo that gitignores `TEMPLATE.md` is a bug, not a preference.** An ignored copy cannot
be synced, does not survive a fresh clone, and silently opts that app out of every lesson
every other app has already paid for. If you find one, delete the ignore line and commit
the file.

Two cheap checks, worth running whenever this file is edited:

```sh
# every copy identical?
md5 -q */TEMPLATE.md ../*/TEMPLATE.md | sort -u | wc -l      # must print 1

# any repo ignoring it?
git check-ignore -v TEMPLATE.md                              # must print nothing
```

---

## The three laws

An app that obeys these three is automatically distributable. Break one and distribution breaks.

1. **Zero hardcoded secrets or config.** No API key, DB URL, domain, or provider string
   in code. Everything comes from environment variables. A grep for secret-shaped strings
   returns nothing.
2. **Migration-complete, own schema.** Every table, RLS policy, function, and enum lives in
   the app's own Postgres schema, named after the app slug (`create schema animator;` then
   `animator.jobs`, etc.), and all of it is in `supabase/migrations/`. A fresh Supabase
   project + `supabase db push` = a working backend. Nothing lives in `public` or in any
   shared table. This one rule makes the same migration file serve both worlds: your shared
   apps project (many schemas, one free DB) and a distributor's fresh project (one schema,
   their own DB) — identical file, zero changes.
3. **Single-tenant-safe.** The app works for one deployer with their own users. No dependency
   on another product's schema, IDs, or auth. It can run completely alone.

---

## Hosting model (your side vs. a distributor's side)

Two Supabase projects total on your side, both free:

- **Project 1** — the Build & Launch hub. Apps never touch it.
- **Project 2** — the shared "apps" project. Every app lives here in its own schema.
  All apps point at this project via env vars.

Each app is its own repo and its own VS Code window. The DB is shared; the code never is.

A Skool distributor gets the zip, creates their own fresh free project, runs `db push` —
the app's schema is created in their project. Same migration file, no edits.

**When an app outgrows the shared project** (DB size, traffic): transfer just that app —
create a new project, run its migrations there, repoint its env vars. The schema-per-app
rule is what makes this a one-evening move instead of a surgery.

Free-tier note: a free project pauses after 7 days of inactivity. Keep a lightweight ping
(a cron hitting a trivial endpoint every 3–4 days) on the shared apps project once real
users depend on it.

---

Every app runs in exactly two modes, decided at load time from one env var.

| Mode | When | Auth | Data |
|---|---|---|---|
| `standalone` | Deployed alone (Skool distributor, or you testing) | The app's own Supabase Auth | The app's own DB |
| `embedded` | Inside the Build & Launch hub via iframe | Trusts a signed token from the hub | Still the app's own DB |

Set by `NEXT_PUBLIC_APP_MODE` (`standalone` | `embedded`). Default `standalone`.

**Embedded mode contract:** the hub loads the app in an iframe and passes a **signed JWT**
(hub signs with a private key; the app verifies with the hub's public key in
`HUB_PUBLIC_KEY`). The token asserts the user's id, email, and which tools they can access.
The app verifies it, then creates-or-looks-up a local user row keyed by that identity — so
an embedded user gets a real row in the app's own DB, no shared table. If the token is
missing or invalid in embedded mode, the app shows a locked state, never its own login.

Asymmetric signing is required, not symmetric: with many distributed apps, a shared secret
would let any one app forge tokens for another.

**Every embedded app MUST enforce `aud`.** The hub mints each token addressed to one app
(`aud` = that app's tool slug) and scopes the `tools` claim to that app alone. The app has to
require and check it — with `jose`, pass `audience` to `jwtVerify`, which rejects a
mismatched *and* a missing `aud`:

```ts
await jwtVerify(token, hubPublicKey, {
  algorithms: ['RS256'],
  audience: MY_TOOL_SLUG,   // required, not optional
  clockTolerance: '30s',
  maxTokenAge: '1h',
})
```

Skipping it is not a small omission, and it fails in the direction of "everything works",
which is why it needs to be a rule rather than a habit. Every app holds the same hub public
key, so an unenforced `aud` means any app's token verifies at every other app — and each app
server sees the raw token, so one compromised or merely careless app could replay its users'
tokens across the whole estate. Asymmetric signing stops an app **forging** tokens; `aud` is
what stops it **reusing** real ones. Test the negative before shipping: a token minted for a
different app must be rejected.

The hub's token carries `sub`, `email`, `tools`, `iss`, `aud`, `iat` and `exp`, and lives for
60 minutes. Treat `exp` as the session deadline — re-verify on every request and show locked
state once it passes. Do not cache the decision, and do not store the `tools` claim: the hub's
access engine is the only source of truth, and a persisted copy can only ever go stale in the
user's favour.

---

## Embedded apps are served from a hub subdomain

**The rule: in embedded mode, an app is served from a subdomain of the hub's own domain —
`animator.buildnlaunchai.com`, next to the hub's `www.buildnlaunchai.com`. Not from
`*.vercel.app`, and not from its own separate domain.**

This is not a preference about tidy URLs. It is the only reason the hub token can survive
the trip from the URL into a cookie, and getting it wrong produces a failure that looks like
absolutely anything except what it is.

**Why.** The app receives its token at `?hub_token=…` and immediately swaps it into an
httpOnly cookie (see `lib/hub/transport.ts`). Whether the browser will *send that cookie back*
inside an iframe depends on whether the iframe is same-site — and "same-site" is decided by the
**registrable domain (eTLD+1)**, not the origin. `animator.buildnlaunchai.com` framed by
`www.buildnlaunchai.com` shares the registrable domain `buildnlaunchai.com`, so the iframe is
**first-party**: the cookie is not a third-party cookie, and none of the third-party cookie
machinery applies to it.

Get this wrong and the app is dead in Safari specifically. Safari's ITP blocks third-party
cookies with **no exceptions** — not a heuristic, not a prompt. The token verifies perfectly,
the middleware then finds no cookie on the next request, and every real user sees locked state
while every test you wrote passes. Chrome's restrictions and Firefox's Total Cookie Protection
land in the same place by different routes.

Because the app is same-site, its hub cookie is **`SameSite=Lax`**, not `None`. Lax is sent on
same-site requests including iframes, and it adds CSRF defence and working local development
for free. `None` demands `Secure`, and `Secure` over plain http is rejected — which is why an
embedded app on `http://localhost` silently loses its cookie.

### The `vercel.app` trap — read this before you debug anything

**`vercel.app` is itself on the Public Suffix List** (so are `vercel.dev`, `vercel.run` and
`now.sh`). That means every `*.vercel.app` deployment is *its own registrable domain*:

| Hub | App | Same-site? |
|---|---|---|
| `www.buildnlaunchai.com` | `animator.buildnlaunchai.com` | **yes** — cookie works |
| `www.buildnlaunchai.com` | `livinganimator.vercel.app` | **no** — third-party, Safari blocks |
| `www.buildnlaunchai.com` | any preview URL (`*.vercel.app`) | **no** — third-party, always |

So: **a `vercel.app` URL can never reproduce the working embedded case, and neither can a
preview deployment.** No amount of correct JWT code changes that. If you test the embed on a
preview URL you will watch a perfectly valid token fail, and you will go debug the token —
which was never the problem. Test embedded mode **only** on the real hub subdomain.

### The two-project pattern

`NEXT_PUBLIC_APP_MODE` is a per-project production environment variable, so **one Vercel
project cannot be both modes at once**. Every embedded app therefore gets two Vercel projects
from the same repo — same code, same commit, different env:

| Project | Domain | `NEXT_PUBLIC_APP_MODE` | Purpose |
|---|---|---|---|
| standalone | `<app>.vercel.app` (or its own domain) | `standalone` | The live reference a Skool distributor sees before they deploy their own |
| embedded | `<app>.buildnlaunchai.com` | `embedded` + `HUB_PUBLIC_KEY` | What the hub iframes |

Free on Hobby, and it keeps the standalone promise honest: the thing distributors are told
works alone is a URL you can actually open, not a claim.

### Cookie scope: host-only, always

The hub-token cookie must have **no `Domain` attribute**. Host-only is the default and it is
load-bearing: `Domain=.buildnlaunchai.com` would send one app's hub token to the hub and to
every sibling app on the parent domain — handing each app a working token for all the others.
The `aud` claim exists to stop exactly that replay; a `Domain` attribute reopens it one layer
below where any claim check can see it.

### If an app truly cannot live on a hub subdomain

The fallback is CHIPS — `SameSite=None; Secure; Partitioned` — which opts a cross-site cookie
into per-top-level-site partitioned storage. It works in current browsers but has had a rough
run (Safari shipped it in 18.4, pulled it in 18.5, re-shipped in 26.2), so treat it as the
escape hatch, not the default. The subdomain needs no browser to cooperate.

---

## Repo structure

```
/supabase/migrations/     every migration, ordered. db push = working backend.
/.env.example             every var, blank values, one comment per line explaining it
/.env.local               gitignored, real values, never committed
/README.md                the deploy guide (below)
/scripts/preflight.sh     greps for hardcoded secrets, checks .env.example is complete
/src or /app              the app itself
```

`.gitignore` must contain `.env.local` before the first commit.

Set `git config --local user.email` to an address GitHub resolves to the account
your Vercel scope is connected to — the `<id>+<username>@users.noreply.github.com`
form is guaranteed to resolve, an unverified address is not. On the Hobby plan
with a private repo, Vercel blocks any deployment whose commit author lacks
contributing access ("the commit author did not have contributing access"), so a
mismatched email silently strands every push while the dashboard's first import
still succeeds — which makes it look like a build problem rather than an identity
one.

---

## README.md — the deploy guide

Written for a Skool member who is not you. Plain steps, in order:

1. Prerequisites (Node version, a Supabase account, a Vercel account).
2. Clone, `pnpm install`.
3. Create a Supabase project. Copy URL + anon key + service role key.
4. `supabase link` and `supabase db push` — creates the whole backend.
5. Copy `.env.example` to `.env.local`, fill in the values (each explained).
6. Which API keys the app needs, and a direct link to get each.
7. `pnpm dev` to test locally.
8. Deploy to Vercel: import repo, paste the same env vars, deploy.
9. (Optional) embedded mode: set `NEXT_PUBLIC_APP_MODE=embedded` and `HUB_PUBLIC_KEY`.

No step assumes prior knowledge of the codebase. If a step needs a value, say exactly
where to get it.

---

## Distribution build

`pnpm run dist` (a script in every app) produces a clean `dist/` zip for Skool:

1. Runs `scripts/preflight.sh` — fails if any secret-shaped string is in the code, or if
   `.env.example` is missing a var the code reads.
2. Regenerates `.env.example` from the actual env vars the code references.
3. Refreshes the README's env-var list.
4. Verifies migrations apply cleanly to a throwaway DB.
5. Zips everything except `.env.local`, `node_modules`, `.git`, `dist`.

If preflight fails, no zip. That's the guarantee: a shipped zip is always deployable and
never leaks a secret.

---

## Design

Each app is its own product with its own identity — do NOT clone the hub's look. Follow the
`frontend-design` skill: pin the subject, pick a palette and type pairing specific to that
app, spend the boldness budget on the one signature interaction. The hub is an instrument
panel; a video tool or an image animator should look like its own thing. The only shared
constraint is the quality floor: responsive to 375px, visible keyboard focus, reduced-motion
respected, both light and dark if the app supports themes.

---

## Browser runtime — required reading for any app running AI in the browser

Packaging an app changes what its browser is allowed to do. That is the whole
category of bug here, and it looks like a broken product rather than a broken
config.

**The rule: packaging must not add restrictions the product never had to satisfy.**
A tool that ran as a plain static file had no CSP, no COOP and no COEP. Wrapping
it in Next.js and adding security headers is not free — every header is a new
constraint the app was never tested against. Add them deliberately, or not at all.

**If you add a CSP, these are load-bearing, not hardening:**

- `connect-src` **must include `blob:`** if the app ever hands a user-selected
  file to a library. `URL.createObjectURL(file)` produces a `blob:` URL, and
  libraries like transformers.js `fetch()` it. Miss this and the image *displays*
  (`img-src` allows `blob:`) while inference dies with a bare
  **"Failed to fetch"** — which reads exactly like a CDN or network fault and
  sends you debugging the wrong system entirely.
- `connect-src` must cover **redirect targets**, not just the URL you call. CSP
  re-checks every hop. Model weights on `huggingface.co` 302 to
  `cas-bridge.xethub.hf.co`, so `*.hf.co` is what actually permits the download.
- `script-src` needs `'wasm-unsafe-eval'` for any ONNX/WASM runtime.
- `worker-src` needs `blob:` — WASM runtimes spawn workers from blob URLs.

**COOP/COEP: do not add them reflexively.** The received wisdom is that
in-browser AI needs cross-origin isolation for SharedArrayBuffer and WASM
threads. Check before believing it:

- Single-threaded WASM (`device:'wasm'`, no threading) never touches
  SharedArrayBuffer and needs no isolation at all.
- `COEP: require-corp` demands every cross-origin subresource send
  `Cross-Origin-Resource-Policy`. jsDelivr sends it; **Hugging Face does not**.
  Enabling it therefore *blocks the model download* — producing the same
  "Failed to fetch" people add COEP to fix, which is a genuinely vicious loop.
- If you truly need SharedArrayBuffer, use `COEP: credentialless`, and re-test
  the model download in a real browser before shipping.

**Verify in a real browser.** `curl` proves which headers you send; it cannot
prove the app works, because CSP, COEP and CORS are enforced only by browsers. An
app whose headers look right and whose AI is untested is an app you have not
tested. For any in-browser-AI app, the deploy is not done until someone has
watched the model download and produced real output on the deployed URL.

---

## Extracting from the shared ERP database (one-time, per app)

For apps whose data currently lives in the Caparison ERP's shared Supabase:

1. List the exact tables this app reads or writes.
2. Copy their `CREATE TABLE` + RLS + functions into this repo's first migration, **inside the
   app's own schema** (`create schema <app_slug>;`). Drop any ERP-specific columns (org ids,
   cross-product foreign keys) the standalone app doesn't need.
3. If the app needs existing rows, export them to seed data; otherwise start empty.
4. Point the app at its **own** new Supabase project. Confirm it runs with zero reference to
   the ERP DB.
5. Run `scripts/preflight.sh` — it must pass before the app is considered extracted.

The app is "done extracting" when it boots, works, and passes preflight against a brand-new
empty Supabase project that has never seen the ERP.

---

## Hub integration (when connecting an extracted app to Build & Launch)

No change to the app's **code**. There is deployment work, and the order matters:

1. **Second Vercel project** from the same repo, env `NEXT_PUBLIC_APP_MODE=embedded` plus
   `HUB_PUBLIC_KEY` (the hub operator gives you the PEM). The standalone project stays exactly
   as it is — see "The two-project pattern" above.
2. **Domain**: add `<app>.buildnlaunchai.com` to that project and point the DNS record at
   Vercel. `embed_url` **must** be this subdomain — a `*.vercel.app` URL is cross-site and the
   embed will fail in Safari for every user while passing every test.
3. **Hub**: create a tool row, `runtime = iframe`, `slug` = the id the app checks in its
   `tools`/`aud` claims, and `embed_url` = the subdomain from step 2.

The hub's iframe branch mints a token scoped to that one app and passes it. Access still flows
through the hub's access engine — the app never grants its own access in embedded mode, and
never stores what the token told it.

---

## Credit mode — when the hub pays, the app must not spend the member's key

The hub is adding prepaid credit alongside BYOK. It changes one thing every connected
app has to care about, and it changes it silently unless someone reads this.

Access used to be a yes or a no. It is now a yes or a no **plus a mode**:

| Mode | When | Whose key pays for the AI call |
|---|---|---|
| `byok` | Active member, an explicit per-user grant, or a `public_preview` tool | The member's own provider key |
| `credit` | Membership has lapsed, but they hold platform credit | **The hub's. The member's key must not be released.** |
| `none` | No access | — |

**`can_access_tool()` cannot tell you which one.** It returns a boolean, and it returns
`true` for `byok` and `credit` alike. Anything that decides whether to hand a member's
decrypted provider key to a client must read the hub's `tool_access()` function instead,
which returns the mode. The boolean is still correct for "may they open this at all".

### The failure this section exists to prevent

In `credit` mode the hub pays the provider. If a client is still handed the member's own
key and spends it, the member pays their provider **and** is billed credit for a call the
hub never made. Money moves in both directions at once, and nothing in the database can
detect it afterwards: a wrong release is byte-for-byte identical to a right one.

So the ordering is not negotiable, and it is a sequencing rule rather than a code review
note because the window it protects opens on a date, not on a commit:

> **Every key-release path must read the mode BEFORE the first credit top-up can be
> bought.** In the hub that means `supabase/functions/_shared/client-gate.ts` (which feeds
> `desktop-keys` and `upworkpilot-keys`), `lib/runner.ts`, and `lib/key-release.ts`.

Until a top-up can be bought, the `credit` branch is unreachable — every member's balance
is zero — so the schema can land first and change nothing. That grace ends the moment a
product exists to sell.

### What a client app has to do

- Treat a `credit`-mode licence as **"you may run, and you get no key"**. Do not fall back
  to a locally stored key, and do not prompt the member for one.
- A `<client>-keys` response in credit mode withholds every provider slot. That is a
  normal, expected state — not an error, and not a reason to show the member a wall.
- The `mode` field on those responses already exists and reads `"byok"` today. It was
  declared ahead of time for exactly this change. **Read it. Never infer the mode from
  whether a key came back**, because "no key" and "no key yet" are different answers with
  different fixes.

### Two ways this has already gone wrong

Both were found by pointing a real client at a hub in credit mode, and both are the
same mistake wearing different clothes: **the mode was read as an afterthought.**

- **The extension read `mode` inside the "a key came back" branch.** So on every path
  where a key was *withheld* — which is every path in credit mode — the one field that
  explained the situation was parsed and dropped. The member was shown "the hub could
  not release your key", a sentence about a fault, for an account with nothing wrong
  with it. Read `mode` at the TOP of the parse, before you look at any slot.

- **The desktop app deserialised the mode into a strict enum that did not contain the
  hub's word.** It expected `"platform"`; the hub has always sent `"credit"`. Worse than
  the wrong word was the strictness: an unrecognised value is a HARD PARSE ERROR that
  fails the whole response, not just the field, so a perfectly entitled member could not
  read their keys at all. **An unknown mode must degrade, never throw** — the hub is
  explicitly allowed to add values, and a client that breaks when it does has turned
  their roadmap into your outage. The same applies to the withheld `reason` strings.

Neither had a test. Both now do, and both tests were confirmed to FAIL against the code
they were written for — a test that passes against the bug proves nothing.

### Testing the credit path locally

You cannot iterate against production: `credit_mode_enabled` is a **global** kill switch,
so turning it on to test turns it on for everybody. Use a local hub — the whole stack runs
under `supabase start`, credit mode can stay on permanently, and a fake upstream can stand
in for the providers so client work costs nothing.

**One trap will cost you an hour if nobody warns you, so consider yourself warned:**

> Local GoTrue signs its JWTs with **ES256**, while the local Edge Runtime verifies with
> the **HS256** shared secret. So a perfectly good session token minted by the local auth
> server is rejected at the function gateway with `{"msg":"Invalid JWT"}` — before your
> function runs, and with nothing in your logs to say why. It looks exactly like an auth
> bug in the code you just wrote.
>
> Serve functions with **`supabase functions serve --no-verify-jwt`** locally.

This does **not** weaken the test. `verify_jwt` was never the authorisation — the gate
inside the function calls `supabase.auth.getUser(jwt)` against the auth server and that is
what actually decides. Turning the gateway check off locally removes a duplicate that only
works in production anyway; every rule the function enforces is still enforced.
