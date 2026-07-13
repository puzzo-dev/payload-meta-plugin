# payload-meta-plugin

A self-contained **Payload CMS 3.x plugin** for connecting multi-tenant sites to Meta's network (Facebook, Instagram, WhatsApp).

Modeled on the official "Meta for WooCommerce"/"Facebook for WordPress" plugins, but **modular per-channel and per-site** — a site enables only the Meta channels it actually needs, instead of every site being wired to one hardcoded product line. A B2B services site might only want the Pixel + Conversions API; an e-commerce site might want Pixel + Commerce Catalog + WhatsApp.

It provides:

- **Meta Connection Configuration** per site (multi-tenant) with encrypted credentials.
- **"Connect to Meta Business" OAuth flow** — the same connector UX as the official Meta for WordPress plugin: authorize once, pick a Facebook Page you manage, its linked Instagram Business account is auto-detected, then select an existing Pixel or create a new one. **Manual credential entry stays fully available side by side** — OAuth is a convenience, not a requirement.
- **Threads connect flow** — separate from the Facebook/Instagram connector (Threads is its own API/host, see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads)), also with manual token entry as a fallback.
- **Server-Side Conversions API** — a `sendConversionEvent()` helper and a `meta-conversion-event` action registered into the CMS workflow engine, so any Workflow can fire a "Trigger Meta Conversion Event" step (order created → `Purchase`, contact form submitted → `Lead`, etc.).
- **Commerce Catalog Feed** — `GET /api/meta-catalog/feed?site=<slug>`, a CSV feed generated from whichever collection a site's config designates, for Facebook/Instagram Shop.
- **Connection Health Check** — verifies the stored access token against the Graph API and records connection status.

> [!NOTE]
> This plugin does **not** ship its own WhatsApp webhook receiver or outbound sender. If your host CMS already has generic inbound-webhook infrastructure and/or a WhatsApp Cloud API sender, point `meta-config`'s WhatsApp fields at those instead of duplicating them here. See [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp) below.

> [!WARNING]
> The OAuth endpoints (`metaOAuth.ts`, `threadsOAuth.ts`) are implemented strictly against Meta's and Threads' **documented** API contracts (OAuth dialog, token exchange, `/me/accounts`, `owned_pixels`, `adspixels`, Threads' separate `graph.threads.net` host). They have **not** been exercised against a real Meta App or Threads App — that requires a live App ID/Secret and a browser to complete the OAuth consent screen, neither of which exist in the environment this plugin was built in. **Do a manual test connect before relying on this in production**, and check Meta's current Graph API version (`GRAPH_API_VERSION` in `utils/metaGraphClient.ts`, currently `v21.0`) if any call returns a deprecation error — Meta bumps this periodically.

---

## Table of Contents

- [What This Plugin Actually Does](#what-this-plugin-actually-does)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads)
- [Configuration](#configuration)
- [The `meta-config` Collection](#the-meta-config-collection)
- [Conversions API / Workflow Steps](#conversions-api--workflow-steps)
- [Commerce Catalog Feed](#commerce-catalog-feed)
- [Endpoints](#endpoints)
- [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp)
- [Security](#security)
- [What's Not Built Yet](#whats-not-built-yet)
- [License](#license)

---

## What This Plugin Actually Does

Before this plugin existed, "Meta integration" on this platform meant a hand-typed Pixel ID in a CMS global and a client-side `fbq()` call scattered per-site — no server-side tracking, no Commerce Catalog, no real connection health check, and it existed on exactly one site.

This plugin is the deliberate fix for that: **one place, per site, to connect to Meta**, and **Meta event tracking happens server-side only** — no client-side `fbq()` custom events anywhere in any frontend. This isn't a stylistic preference; it's a direct response to iOS 14.5+ ad-tracking loss and ad-blockers, both of which silently drop client-side Pixel events. Server-side Conversions API events don't have that problem.

**Why this matters for the business**: every Lead, Purchase, and AddToCart that reaches Meta's ad systems reliably is a signal Meta's algorithm uses to find more people like that customer. Client-only tracking under-reports these events — often by 20–30% depending on ad-blocker prevalence and iOS share — which directly degrades ad targeting and inflates cost-per-acquisition. Fixing the *reliability* of the signal is usually a bigger lever than fixing the ad creative.

---

## Installation

```bash
npm install payload-meta-plugin
# or
pnpm add payload-meta-plugin
```

> If you're developing this plugin inside a monorepo alongside its host CMS, it's tempting to reference it as a `workspace:*`/`file:` link instead of a published version. Be aware that CI/CD pipelines with an isolated build context (e.g. a Docker build that only copies the host app's own directory) commonly can't resolve a workspace link to a sibling package — switch to a real published npm version before it needs to build in a pipeline like that.

---

## Quick Start

### 1. Add the plugin to `payload.config.ts`

```typescript
import { buildConfig } from 'payload'
import { metaPlugin } from 'payload-meta-plugin'
import { actionRegistry } from './lib/actionRegistry' // your host application's registry

export default buildConfig({
  // ... your config
  plugins: [
    metaPlugin({
      registry: actionRegistry, // optional — omit to skip registering the Conversions API workflow action
    }),
  ],
})
```

### 2. Set the encryption key

```bash
# .env
META_ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Without this, credentials are stored in plain text (allowed in development; the plugin **fails fast at startup in production** unless you explicitly set `ALLOW_PLAINTEXT_META_CREDS=true`, which you should not do).

### 3. Create a `Meta Config` in the Payload Admin

Go to **Integrations → Meta Config**:

- Select the site/tenant.
- **🔑 Connection tab**: either paste a long-lived Access Token manually, **or** enter a Meta App ID/Secret and click **Connect to Meta Business** — see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads) for the full walkthrough. Either way, save — the plugin verifies the token against the Graph API a couple of seconds later and updates **Connection Status**.
- Enable and configure only the channel tabs this site needs:
  - **📊 Pixel & Conversions API** — Pixel ID (paste one, or use **Select / Create Pixel**).
  - **🛍️ Commerce Catalog** — Catalog ID, the Payload collection slug to feed (e.g. `products`), and an item URL template.
  - **💬 WhatsApp Business** — phone number ID + Business Account ID (wire these into your own WhatsApp Cloud API sender, or your host CMS's if it has one — see [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp)).
  - **🧵 Threads** — click **Connect Threads** (its own, separate OAuth flow).
- Mark **Active** and save.

### 4. Wire a Conversions API event into a Workflow

Go to **Automation → Workflows**:

- Create or edit a workflow (e.g. triggered on order creation).
- In **Steps**, add a **Trigger Meta Conversion Event** block.
- Pick the event name (`Purchase`, `Lead`, `AddToCart`, etc.) and map `value`/`currency`/`content_name` using `{{var}}` references into the workflow context — using `{{var}}` references into the workflow context.

---

## Connecting Facebook, Instagram, and Threads

Two ways to connect, fully interchangeable — pick whichever suits a given site. Both populate the exact same `accessToken`/`pixelId` fields, so nothing downstream (Conversions API, Catalog feed) needs to know which path was used.

### Option A — Manual

Paste a long-lived Page or System User access token directly into `accessToken` on the **🔑 Connection** tab. This is the only option if you don't want to register a Meta App, or would rather not walk through an OAuth consent screen for a given site. Fully supported indefinitely — not a legacy fallback.

### Option B — Connect to Meta Business (OAuth)

Requires a **Meta App** (developers.facebook.com) with the **Facebook Login for Business** product added, plus **Business Manager** access to the Page(s)/Pixel(s)/WhatsApp number(s) you want to connect.

1. In your Meta App's settings, add `{PAYLOAD_PUBLIC_SERVER_URL}/api/meta-oauth/callback` as a **Valid OAuth Redirect URI**.
2. On the `meta-config` document, enter that App's **App ID** and **App Secret** on the 🔑 Connection tab, then save.
3. Click **Connect to Meta Business** — you'll be redirected to Meta's OAuth consent screen requesting `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `instagram_basic`, `ads_management`, `catalog_management`, and `whatsapp_business_management` (trim the scope list in `metaOAuth.ts` if your App's review doesn't cover all of them — Meta simply omits ungranted permissions from the resulting token rather than failing the whole flow).
4. After consenting, you land back on the `meta-config` edit page. Click **Load My Pages**, pick the Facebook Page this site should use, then **Use This Page** — the linked Instagram Business account (if any) is detected automatically and shown alongside it.
5. On the **📊 Pixel & Conversions API** tab, enter a **Business Manager ID** (found in Meta Business Settings) on the Connection tab first, then use **Load Existing Pixels** to pick one, or **Create New Pixel** to make a fresh one scoped to that Business Manager.

### Connecting Threads

Threads is a **separate product/API** from Facebook and Instagram — its own OAuth host (`threads.net`, not `facebook.com`), its own token host (`graph.threads.net`, not `graph.facebook.com`), and its own token/profile shape — even though it's added as a product on the *same* Meta App and reuses that App's ID/Secret.

1. Add the **Threads API** product to the same Meta App, and register `{PAYLOAD_PUBLIC_SERVER_URL}/api/threads-oauth/callback` as its redirect URI.
2. On the **🧵 Threads** tab, click **Connect Threads** — separate consent screen (`threads_basic`, `threads_content_publish`), separate callback, separate stored token (`threadsAccessToken`). Connecting Threads does not affect or require the Facebook/Instagram connection above, or vice versa.

### CSRF Protection Without a Session Store

Payload endpoints are stateless REST — there's no server-side session to carry a `configId` through the redirect to Meta's (or Threads') servers and back. Instead, `signOAuthState()`/`verifyOAuthState()` (`utils/metaCrypto.ts`) HMAC-sign `configId:timestamp` (10-minute TTL) into the `state` param, verified on callback with a constant-time comparison — tamper or replay it and the callback rejects with "Invalid or expired connect request."

```typescript
export interface MetaPluginOptions {
  /** CMS action registry — enables the `meta-conversion-event` workflow action. */
  registry?: ActionRegistryRef
  /** Reserved for future host bindings. Unused today. */
  host?: Record<string, unknown>
}
```

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `META_ENCRYPTION_KEY` | Production: yes | 32-byte hex key (`openssl rand -hex 32`) for AES-256-GCM credential encryption. Separate from `payload-erpnext-plugin`'s `ERPNEXT_ENCRYPTION_KEY` — rotating one doesn't affect the other. |
| `ALLOW_PLAINTEXT_META_CREDS` | No | Set to `true` to explicitly allow plain-text credential storage in production. Do not set this unless you understand the risk (a DB dump/backup leaks every tenant's Meta access token). |
| `PAYLOAD_PUBLIC_SERVER_URL` | For Catalog feed + OAuth | Used to build absolute image URLs in the Commerce Catalog feed, and the OAuth callback redirect URIs (`/api/meta-oauth/callback`, `/api/threads-oauth/callback`). Already set for the host CMS's other public-facing needs. |
| `META_OAUTH_STATE_SECRET` | No | HMAC key for signing the OAuth `state` param. Falls back to `META_ENCRYPTION_KEY` if unset — only set this separately if you want state-signing and credential-encryption keys to rotate independently. |

---

## The `meta-config` Collection

One document per site. Every credential field is directly editable (manual entry) — the Connect buttons are a convenience layer on top, not a replacement:

| Tab | Fields | Notes |
|---|---|---|
| 🔑 Connection | `appId`, `appSecret` (encrypted), `accessToken` (encrypted, required), `businessManagerId`, `connectionStatus` (read-only), `authMethod` (read-only, informational), **Connect to Meta Business** button, `facebookPageId`/`facebookPageName`/`instagramBusinessAccountId`/`instagramUsername` (read-only, set by Connect), `oauthUserAccessToken` (hidden, encrypted, internal) | `connectionStatus` updates ~2 seconds after save via a background Graph API `/me` check. See [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads). |
| 📊 Pixel & Conversions API | `pixelEnabled`, `pixelId`, **Select / Create Pixel** button | Enables `sendConversionEvent()` / the `meta-conversion-event` workflow action for this site. |
| 🛍️ Commerce Catalog | `catalogEnabled`, `catalogId`, `catalogSourceCollection`, `catalogItemUrlTemplate` | Enables `GET /api/meta-catalog/feed?site=<slug>`. |
| 💬 WhatsApp Business | `whatsappEnabled`, `whatsappPhoneNumberId`, `whatsappBusinessAccountId` | Populates the host CMS's existing `lib/whatsapp.ts` `metaCloud` provider — no plugin code needed for outbound sending. |
| 🧵 Threads | `threadsEnabled`, **Connect Threads** button, `threadsUserId`/`threadsUsername` (read-only, set by Connect), `threadsAccessToken` (hidden, encrypted) | Independent OAuth flow — see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads). |

Credentials (`appSecret`, `accessToken`, `oauthUserAccessToken`, `threadsAccessToken`) are AES-256-GCM encrypted at rest and masked in the admin UI (`••••1234`) for any authenticated non-internal request — the same pattern many Payload plugins use for sensitive credential fields.

---

## Conversions API / Workflow Steps

`sendConversionEvent(creds, input, log?)` posts a single event to `graph.facebook.com/v21.0/{pixel_id}/events`. Exported directly for host-app code that wants to call it outside the workflow engine:

```typescript
import { getMetaCredentials, sendConversionEvent } from 'payload-meta-plugin'

const creds = await getMetaCredentials(payload, 'my-site-slug')
if (creds?.pixelId) {
  await sendConversionEvent(creds, {
    eventName: 'Purchase',
    customData: { value: 12500, currency: 'USD' },
  })
}
```

There is deliberately **no client-side event to deduplicate against** — this plugin doesn't fire `fbq()` calls, so the `eventId`/dedup dance Meta's docs describe for hybrid Pixel+CAPI setups doesn't apply here. If a site later adds its own client Pixel events independently, `eventId` is available on `ConversionEventInput` to dedupe against those.

The **Trigger Meta Conversion Event** workflow step (`trigger_meta_conversion` block) is the no-code path — see [Quick Start](#quick-start) step 4.

---

## Commerce Catalog Feed

`GET /api/meta-catalog/feed?site=<slug>` — public, unauthenticated (Meta's Commerce Manager crawler doesn't send custom auth headers), site-scoped.

Generic by design: reads whichever collection `catalogSourceCollection` designates, tolerating a few common field-name variations so it isn't hardcoded to any one site's schema:

| Feed column | Source field(s) tried, in order |
|---|---|
| `title` | `title`, `name`, `heading` |
| `description` | `description`, `excerpt`, `body` (HTML stripped) |
| `price` | `price`, `price_from`, `priceFrom` |
| `image_link` | `image`, `featuredImage`, `photo` (resolved to an absolute URL) |
| `link` | `catalogItemUrlTemplate` with `{slug}` substituted |

Items missing a `title` or `price` are skipped rather than emitted as invalid rows — Meta rejects the whole feed on malformed entries, so a few incomplete source documents shouldn't take down catalog sync for everything else.

---

## Endpoints

All `/meta-oauth/*` and `/threads-oauth/start` endpoints require an authenticated `admin`/`super-admin` session. The two `*-oauth/callback` endpoints are hit by Meta's/Threads' redirect (not called directly) and verify the signed `state` param instead.

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/api/meta-catalog/feed?site=<slug>` | Public, unauthenticated. Commerce Catalog CSV feed. |
| `GET`  | `/api/meta-oauth/start?configId=<id>` | Redirects to Meta's OAuth2 authorize screen. |
| `GET`  | `/api/meta-oauth/callback` | Facebook/Instagram OAuth2 callback — exchanges the code, stores the long-lived user token. |
| `GET`  | `/api/meta-oauth/pages?configId=<id>` | Lists Facebook Pages reachable by the connected account. |
| `POST` | `/api/meta-oauth/select-page` | Body `{ configId, pageId }` — fetches that Page's token + linked Instagram account, stores both. |
| `GET`  | `/api/meta-oauth/pixels?configId=<id>` | Lists Pixels owned by the configured Business Manager. |
| `POST` | `/api/meta-oauth/pixels` | Body `{ configId, name }` — creates a new Pixel scoped to the Business Manager. |
| `GET`  | `/api/threads-oauth/start?configId=<id>` | Redirects to Threads' OAuth2 authorize screen. |
| `GET`  | `/api/threads-oauth/callback` | Threads OAuth2 callback — exchanges the code, stores the long-lived Threads token + profile. |

---

## Why Not Rebuild WhatsApp?

WhatsApp Business Cloud API needs two things: an outbound message sender, and an inbound webhook receiver (with Meta's `GET` `hub.challenge`/`hub.verify_token` handshake before Meta will start sending `POST`s). This plugin ships neither, on purpose.

Most Payload CMS installations of any real size already have — or will eventually build — a generic notification/messaging layer (an outbound sender abstraction over email/SMS/WhatsApp/etc.) and a generic inbound-webhook receiver (a `webhooks`-style collection with per-integration HMAC secrets, used for more than just Meta). If yours does, wire `meta-config`'s `whatsappPhoneNumberId`/`whatsappBusinessAccountId`/`whatsappAccessToken`-equivalent fields into that existing infrastructure, and add the `GET` verify-token handshake as a small, targeted extension to your existing webhook receiver — rather than having this plugin duplicate a second, parallel messaging/webhook system that only WhatsApp uses.

If your host CMS has no such infrastructure yet and you want WhatsApp support specifically through this plugin, that's a reasonable thing to open an issue or PR for — it just isn't built as of this version.

---

## Security

- Credentials (`appSecret`, `accessToken`) are AES-256-GCM encrypted at rest (`META_ENCRYPTION_KEY`), masked in the admin UI, and only decrypted server-side when actually needed (e.g. `getMetaCredentials()`, the connection-health check).
- `appSecret`/`accessToken` are only writable by `admin`/`super-admin` roles (`adminOrAboveField` field-level access) — editors can see the masked config but can't rotate credentials or repoint a connection.
- `getMetaCredentials()` never falls back across sites — a lookup for one site's slug will never return another tenant's credentials, even on a partial/missing config.
- The Commerce Catalog feed is intentionally public (Meta's crawler needs unauthenticated access) but strictly site-scoped — it can never return another site's data, and only returns docs that already belong to the requested site.
- The OAuth `state` param is HMAC-signed with a 10-minute TTL and verified with a constant-time comparison (`signOAuthState`/`verifyOAuthState` in `utils/metaCrypto.ts`) — the callback endpoints reject a forged, tampered, or replayed-after-expiry state before doing anything else.
- `/meta-oauth/select-page` and the Pixel endpoints only ever accept a `configId` + an identifier (`pageId`, pixel `name`) from the browser — the actual page/pixel access token is always re-fetched fresh from Graph server-side, never trusted from the client.
- OAuth endpoints (`/meta-oauth/*`, `/threads-oauth/start`) require an authenticated `admin`/`super-admin` session — same role gate as manual credential entry.

---

## What's Not Built Yet

- **WhatsApp outbound sending / inbound webhook receiving** — deliberately not duplicated here; see [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp).
- **Live verification of the OAuth flow** — see the warning at the top of this README. Implemented per Meta's/Threads' documented contracts, not yet exercised against a real App.

Contributions welcome — open an issue or PR.

---

## License

MIT
