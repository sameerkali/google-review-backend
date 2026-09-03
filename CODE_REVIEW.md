# Code Review — QR Review Backend

Full-codebase strict review (security + bad practices). Scope: every file under `src/`, plus `package.json` and `vercel.json`. Findings are ranked by severity within each section.

**Status: all findings below have been fixed in code.** Each section notes the fix and flags anywhere the frontend needs to change to match. New required env vars: `ADMIN_USERNAME`/`ADMIN_PASSWORD` (were already set locally), `CRON_SECRET` (required only when `VERCEL` or `NODE_ENV=production` — set this in Vercel's project settings before the next deploy, or the app will refuse to boot there). `CORS_ORIGIN` is still optional but now logs a warning in production if unset.

---

## 1. Security Issues

### 1.1 CRITICAL — Hardcoded default admin credentials
**File:** [src/routes/admin.js:19-24](src/routes/admin.js#L19-L24)

```js
const adminUser = process.env.ADMIN_USERNAME || "admin";
const adminPass = process.env.ADMIN_PASSWORD || "admin";
```

If `ADMIN_USERNAME`/`ADMIN_PASSWORD` are ever unset in a deployed environment (a misconfigured staging box, a fresh clone, a Vercel project where the env var didn't get copied), the admin panel silently falls back to `admin` / `admin`. This is a full authentication bypass into a route that can create/delete businesses, reassign hardware, and read all analytics — with no log or warning that the fallback is active.

**Fix:** fail closed. Throw at startup (same pattern already used for `JWT_SECRET` in [server.js:12-14](src/server.js#L12-L14)) if either env var is missing, instead of defaulting.

---

### 1.2 CRITICAL — NoSQL operator injection in business login
**File:** [src/routes/business.js:12-14](src/routes/business.js#L12-L14)

```js
const { email, password } = req.body;
const business = await Business.findOne({ email }).select("+passwordHash").lean();
```

`email` is passed straight into the Mongo filter with no type coercion. Because `express.json()` parses arbitrary JSON, a request body like:

```json
{ "email": { "$gt": "" }, "password": "anything" }
```

turns the filter into `{ email: { $gt: "" } }`, which matches the first business whose email sorts greater than an empty string — i.e., **any** business in the collection, chosen by whatever Mongo's natural/index order returns, not the one the attacker asked for. This lets an attacker bypass the *intended* lookup entirely and get `findOne` to hand back an arbitrary business record (and its `passwordHash`) to test a guessed/leaked password against, without needing to know that business's email address at all. It's a classic Express+Mongoose operator-injection bug, and this codebase has no sanitization layer (no `express-mongo-sanitize`, no manual `$`-key stripping) anywhere to catch it.

**Fix:** coerce to string before querying — `String(req.body.email || "")` — and/or add `express-mongo-sanitize` (or equivalent) as global middleware in [server.js](src/server.js) to strip `$`/`.`-prefixed keys from `req.body`/`req.query`/`req.params` app-wide, since this pattern (unvalidated `req.body` value dropped straight into a filter) recurs elsewhere (see 1.3).

---

### 1.3 HIGH — Same injection shape elsewhere (defense-in-depth gap)
**Files:**
- [src/routes/admin.js:148](src/routes/admin.js#L148) — `POST /assign`: `const { serial, businessId } = req.body` used directly in `Hardware.findOneAndUpdate({ serial }, ...)`.
- [src/routes/admin.js:186-197](src/routes/admin.js#L186-L197) and [src/routes/business.js:53-65](src/routes/business.js#L53-L65) — the new reorder endpoints put `businessId` (admin route: from body; business route: from the JWT, which is safe) straight into `updateOne` filters per id.

These two admin routes are behind `adminAuth`, so the practical blast radius is smaller (an admin would have to attack themselves, or an admin token would have to be stolen/CSRF'd), but they share the identical root cause as 1.2: no app-wide policy of sanitizing/typing values before they reach a Mongoose filter. A single fix (1.2's `express-mongo-sanitize` recommendation) closes all of these at once instead of patching each call site individually.

---

### 1.4 HIGH — Cron endpoint fails open when `CRON_SECRET` is unset
**File:** [src/routes/cron.js:14-20](src/routes/cron.js#L14-L20)

```js
const secret = process.env.CRON_SECRET;
if (secret && req.headers.authorization !== `Bearer ${secret}`) {
  return res.status(401).json({ error: "unauthorized" });
}
```

If `CRON_SECRET` isn't configured, the check is skipped entirely (`secret` is falsy) and `/internal/cron/daily-stats` becomes a **public, unauthenticated endpoint** that re-runs a full aggregation over every business's `FeedbackSession` history for an arbitrary `?date=`. There's also no rate limiter on this router at all (`cron.js` never calls `publicLimiter`/`authLimiter`), so once discovered it can be hit in a tight loop, each call doing an O(all businesses × all sessions for that day) scan — a straightforward, cheap DoS/cost-amplification vector against the database.

**Fix:** same fail-closed pattern as 1.1 — require `CRON_SECRET` to be set (throw at boot if missing, mirroring `JWT_SECRET`), and add a rate limiter to this router.

---

### 1.5 MEDIUM — Wide-open CORS by default
**File:** [src/server.js:20-23](src/server.js#L20-L23)

```js
const corsOrigins = process.env.CORS_ORIGIN?.split(",").map(...).filter(Boolean);
app.use(cors(corsOrigins?.length ? { origin: corsOrigins } : undefined));
```

Same shape of problem as 1.1/1.4: a security-relevant setting silently degrades to the permissive option (`cors()` with no config reflects/allows any origin) when an env var is absent, rather than requiring an explicit allowlist in production. Combined with bearer tokens that a frontend might keep in `localStorage`, an open CORS policy means any origin's JS can call these APIs and read the JSON response if it can get the token attached to the request — the usual mitigation is that CORS alone doesn't hand over the token, but it does widen the attack surface for anything that goes wrong elsewhere (an XSS on an unrelated page that happens to share storage, a browser extension, etc). Worth at minimum a startup warning when `NODE_ENV=production` and `CORS_ORIGIN` is unset.

---

### 1.6 MEDIUM — `FeedbackSession.rating` validation is bypassed on write
**File:** [src/routes/feedback.js:108-121](src/routes/feedback.js#L108-L121)

```js
if (rating !== undefined) set.rating = rating;
...
await FeedbackSession.updateOne({ _id: session._id }, { $set: set });
```

The schema declares `rating: { min: 1, max: 5 }` ([models/FeedbackSession.js:17](src/models/FeedbackSession.js#L17)), but Mongoose does **not** run schema validators on `updateOne`/`findOneAndUpdate` unless `runValidators: true` is passed — and it isn't here. A caller can PATCH `rating: 999` (or a string, or an object) straight into the document with no server-side rejection. The aggregation code happens to guard against this defensively (`typeof s.rating === "number" && s.rating >= 1 && s.rating <= 5` in [aggregateDailyStats.js:66](src/jobs/aggregateDailyStats.js#L66)), so dashboards won't visibly break, but the raw data is corrupted and any other future consumer of `FeedbackSession` (exports, admin tooling, a different report) has no reason to assume the same defensive check. `menuItemIds` and `aspects` are set the same way with no shape/type validation at all.

**Fix:** add `{ runValidators: true }` to the `updateOne` call, and validate `rating` is an integer 1–5 and `menuItemIds`/`aspects` are arrays before building `$set`.

---

### 1.7 LOW/MEDIUM — Stale JWTs aren't invalidated on suspension or deletion
**Files:** [src/middleware/auth.js](src/middleware/auth.js), [src/routes/business.js](src/routes/business.js)

`businessAuth` only checks the JWT signature and that `role === "business"` — it never re-checks that the business still exists or that `status === "active"`. Business tokens are minted with a 30-day expiry ([auth.js:29](src/middleware/auth.js#L29)). Consequences:

- An admin suspending a business (`status: "suspended"`) does **not** revoke that business's existing session — every menu-item route (`GET/POST/PATCH/DELETE /business/me/menu-items*`) keeps working on the stale token for up to 30 days. Only the dashboard routes ([businessDashboard.js](src/routes/businessDashboard.js)) re-check anything from the DB per request, and even those only check the *plan tier*, not `status`.
- An admin deleting a business ([admin.js:94-106](src/routes/admin.js#L94-L106)) deletes the `Business` doc and its `MenuItem`s, but a held token for that `businessId` can still call `POST /business/me/menu-items` and happily recreate menu items under a business id that no longer exists anywhere else in the system — an orphaned, invisible-to-the-admin-panel write.

**Fix:** either check business status/existence in `businessAuth` (adds one DB read per request — acceptable given this is already done for `/business/me` and the dashboard routes), or accept the tradeoff explicitly and shorten the token TTL.

---

### 1.8 LOW — `ipHash` is not real anonymization
**File:** [src/utils/deviceInfo.js:11-12](src/utils/deviceInfo.js#L11-L12)

```js
const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
return { ..., ipHash: crypto.createHash("sha256").update(ip).digest("hex") };
```

Unsalted `SHA-256(ip)` is trivially reversible: the entire IPv4 space is ~4.3 billion addresses, which is a rainbow-table-in-minutes problem on commodity hardware. Anyone with read access to `AnalyticsEvent` (or a DB backup) can recover the real IP for every hashed record, and can trivially confirm/deny "did this specific IP visit," which somewhat defeats the apparent privacy intent of hashing it in the first place.

**Fix:** use an HMAC with a server-side secret (`crypto.createHmac("sha256", process.env.IP_HASH_SECRET).update(ip).digest("hex")`) instead of a bare hash, so reversal requires the secret, not just compute.

---

### 1.9 LOW — Unvalidated/unbounded `googleReviewUrl`
**File:** [src/models/Business.js:20](src/models/Business.js#L20)

`website` has a validator requiring `http(s)://` ([models/Business.js:13-19](src/models/Business.js#L13-L19)), but `googleReviewUrl` — the field actually handed back to end-user clients to open ([feedback.js:180](src/routes/feedback.js#L180): `res.json({ googleUrl: business.googleReviewUrl })`) — has no format validation at all. An admin (trusted, but this is still worth a schema-level guard for the same reason `website` has one) could set it to a `javascript:` URL or anything else; if any client ever does `window.location = googleUrl` without checking the scheme, that's a self-XSS/open-redirect vector via admin-entered data. Low severity only because it requires admin-level access to set.

---

## 2. Bad Practices / Code Quality

### 2.1 No centralized input-validation layer
There's no schema-validation library (zod/joi/express-validator) anywhere in the stack — every route hand-rolls its own coercion, inconsistently. Some do it carefully (`feedback.js`'s `String(req.body.code || "").trim()`, `Number.isFinite(req.body.length)`), others don't (business login's `email`, `/assign`'s `serial`/`businessId`, `/:token` PATCH's `rating`). This inconsistency is the direct root cause of findings 1.2, 1.3, and 1.6. Introducing one shared validation approach (even a small hand-written `pick`/`coerce` helper used everywhere) would remove a whole class of future bugs, not just today's.

### 2.2 Mass-assignment into `Business.create`/`findByIdAndUpdate` with no allowlist
**File:** [src/routes/admin.js:29-36](src/routes/admin.js#L29-L36) and [admin.js:63-71](src/routes/admin.js#L63-L71)

```js
const { serial, password, ...body } = req.body;
...
const b = await Business.create(body);
```

Only `serial` and `password` are stripped out; everything else in `req.body` — including `passwordHash` itself — passes through untouched. An admin request that happens to include a raw `passwordHash` field (a frontend bug, a copy-pasted payload, a future refactor) would store that raw string as the credential hash, silently bypassing `hashPassword()` and `verifyPassword()`'s expected `salt:hash` format (so login for that account would simply always fail, or — if the format happens to coincidentally parse — behave unpredictably). Low severity today (admin-only, trusted caller) but a foot-gun with no test or schema constraint stopping it.

**Fix:** explicitly allowlist the fields these routes accept, the same way `POST /business/me/menu-items` already does ([business.js:41-47](src/routes/business.js#L41-L47)) rather than spreading `req.body`.

### 2.3 Shared rate-limiter instance across unrelated login routes
**File:** [src/middleware/rateLimit.js:4-10](src/middleware/rateLimit.js#L4-L10), used at [admin.js:18](src/routes/admin.js#L18) and [business.js:12](src/routes/business.js#L12)

`authLimiter` is a single `rateLimit()` instance imported and reused for both `/admin/login` and `/business/login`. Since the limiter's default key is the client IP (not the route), a burst of failed business logins from one IP eats into the same 20-per-15-minutes budget as that IP's admin login attempts, and vice versa. Functionally harmless most of the time, but it's an easy source of confusing "why am I locked out of the admin panel, I only tried the business login" support tickets. Two separate instances (or a route-aware key) would remove the coupling.

### 2.4 No referential-integrity check on `businessId` in bulk menu upload
**File:** [src/routes/admin.js:216-250](src/routes/admin.js#L216-L250) (pre-existing, not part of the reorder change)

`POST /admin/menu-items/bulk` accepts any syntactically-valid ObjectId as `businessId` and will happily `insertMany` menu items against a business id that doesn't exist — Mongoose's `ref` is documentation, not a foreign-key constraint. The route's own error message ("check businessId is a valid, existing business id") acknowledges the intent but the code never actually checks existence. Worth a one-time `Business.exists({_id: businessId})` check per unique businessId in the batch (the same batch you're already grouping by businessId for the new sortOrder logic) if orphaned menu items are a real operational concern.

### 2.5 Unbounded, unpaginated list endpoints
**Files:** [admin.js:80-83](src/routes/admin.js#L80-L83) (`GET /business` with no `page`), [admin.js:121-124](src/routes/admin.js#L121-L124) (`GET /hardware` with no `page`)

Both intentionally return the *entire* collection when `page` is omitted ("used to bootstrap dropdowns elsewhere in the admin panel," per the comment). That's fine at current scale but has no ceiling — if either collection grows into the tens of thousands of rows, this becomes a slow, memory-heavy request with no way to opt out short of a code change. Consider at least a hard cap (e.g., `.limit(2000)`) on the unpaginated branch as a safety net.

### 2.6 `express.json()` default body-size limit not reconsidered for the new bulk-upload feature
**File:** [src/server.js:25](src/server.js#L25)

`express.json()` defaults to a 100kb body limit. That's a reasonable default in general, but this review was prompted by a JSON bulk-upload-during-onboarding feature (`POST /admin/menu-items/bulk`) whose whole purpose is accepting a potentially large exported menu file. Worth deliberately sizing the limit for that route (or globally) rather than inheriting whatever the default happens to be — a large-but-legitimate onboarding JSON file failing silently with a generic 413 is the kind of bug that only shows up during a live customer onboarding call.

### 2.7 Sequential per-business loop in the nightly aggregation job
**File:** [src/jobs/aggregateDailyStats.js:120-133](src/jobs/aggregateDailyStats.js#L120-L133)

`aggregateDailyStatsForAllBusinesses` awaits each business one at a time in a `for` loop. Safe and simple, but on a 2am cron with enough businesses this will eventually become the long pole in the job's runtime. Not urgent (the code already isolates per-business failures into a `failed` array so one bad business doesn't kill the run), but worth a bounded-concurrency batch (`Promise.all` in chunks of N) if the business count grows well past what's comfortable sequentially — the code's own comments already flag "fine at 10 businesses, painful at 200" for the read side of this same job, and the same ceiling applies to the write/loop side.

### 2.8 Free-text fields stored and echoed back with no sanitization
**Files:** [feedback.js:116](src/routes/feedback.js#L116) (`freeTextItem`), [feedback.js:131](src/routes/feedback.js#L131) (`draftGenerated`), `aspects`

These are length-capped but not sanitized in any way, and are echoed back verbatim in dashboard responses (`recentActivity` in [businessDashboard.js:129-142](src/routes/businessDashboard.js#L129-L142)). This is *not* a backend vulnerability by itself — JSON APIs returning raw strings is normal, and escaping is correctly the frontend's job — but it's worth stating explicitly as an assumption: if any admin/business frontend ever renders `freeTextItem` or `draftGenerated` via `dangerouslySetInnerHTML` (or equivalent) instead of as text, this becomes a stored-XSS vector. Flagging so it's a documented contract, not an accident waiting to be discovered.

---

## Summary Table

| # | Finding | Severity | File |
|---|---|---|---|
| 1.1 | Hardcoded fallback admin/admin credentials | Critical | admin.js |
| 1.2 | NoSQL injection in business login (`email` filter) | Critical | business.js |
| 1.3 | Same injection shape, admin-scoped routes | High | admin.js, business.js |
| 1.4 | Cron endpoint fails open without `CRON_SECRET` | High | cron.js |
| 1.5 | CORS defaults to allow-all without `CORS_ORIGIN` | Medium | server.js |
| 1.6 | `rating` validation bypassed on `updateOne` | Medium | feedback.js |
| 1.7 | No token invalidation on suspend/delete | Low/Medium | auth.js, business.js |
| 1.8 | `ipHash` is reversible unsalted SHA-256 | Low | deviceInfo.js |
| 1.9 | `googleReviewUrl` has no scheme validation | Low | models/Business.js |
| 2.1 | No centralized validation layer | — | app-wide |
| 2.2 | Mass-assignment with no field allowlist | — | admin.js |
| 2.3 | Shared rate limiter across unrelated logins | — | rateLimit.js |
| 2.4 | No referential check on bulk-upload `businessId` | — | admin.js |
| 2.5 | Unbounded list endpoints | — | admin.js |
| 2.6 | Default body-size limit vs. bulk upload | — | server.js |
| 2.7 | Sequential aggregation loop | — | aggregateDailyStats.js |
| 2.8 | Unsanitized free-text fields (frontend contract) | — | feedback.js |

Everything not listed here — auth token structure, password hashing (scrypt + timing-safe compare, correctly done), the regex-escaping on admin search, the `.select(false)` on `passwordHash`, the centralized error handler, connection pooling for serverless — was reviewed and looks sound.
