# payload-meta-plugin

A self-contained **Payload CMS 3.x plugin** for connecting multi-tenant sites to Meta's network (Facebook, Instagram, WhatsApp).

Modeled on the official "Meta for WooCommerce"/"Facebook for WordPress" plugins, but **modular per-channel and per-site** — a site enables only the Meta channels it actually needs, instead of every site being wired to one hardcoded product line. A B2B services site might only want the Pixel + Conversions API; an e-commerce site might want Pixel + Commerce Catalog + WhatsApp.

It provides:

- **Meta Connection Configuration** per site (multi-tenant) with encrypted credentials — same architecture as [`payload-erpnext-plugin`](../payload-erpnext-plugin).
- **"Connect to Meta Business" OAuth flow** — the same connector UX as the official Meta for WordPress plugin: authorize once, pick a Facebook Page you manage, its linked Instagram Business account is auto-detected, then select an existing Pixel or create a new one. **Manual credential entry stays fully available side by side** — OAuth is a convenience, not a requirement.
- **Threads connect flow** — separate from the Facebook/Instagram connector (Threads is its own API/host, see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads)), also with manual token entry as a fallback.
- **Server-Side Conversions API** — a `sendConversionEvent()` helper and a `meta-conversion-event` action registered into the CMS workflow engine, so any Workflow can fire a "Trigger Meta Conversion Event" step (order created → `Purchase`, contact form submitted → `Lead`, etc.).
- **Commerce Catalog Feed** — `GET /api/meta-catalog/feed?site=<slug>`, a CSV feed generated from whichever collection a site's config designates, for Facebook/Instagram Shop.
- **Connection Health Check** — verifies the stored access token against the Graph API and records connection status, same UX as `ErpnextConfig`'s auto-fetch.

> [!NOTE]
> This plugin does **not** duplicate WhatsApp webhook receiving or outbound sending — the host CMS already has a generic `webhooks` collection (`payload-cms/src/collections/Webhooks.ts`) + `webhookReceiver.ts` for inbound, and `lib/whatsapp.ts`'s `sendWhatsApp()` (Meta Cloud API provider) for outbound. See [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp) below.

> [!WARNING]
> **Held out of production** (`payload-cms/src/payload.config.ts` only registers `metaPlugin()` when `NODE_ENV !== 'production'`) until the Meta App clears App Review and switches to Live mode. In Development mode, Meta only allows OAuth for users added as Testers/Admins/Developers on the App itself — real customers can't connect regardless of what's deployed, so there's no benefit to shipping it early, and doing so would surface a Connect button that fails for anyone not on that list. Fully active in dev for continued testing against the real App (App ID/Secret + use cases already configured, see below). Once App Review completes, remove the `NODE_ENV` condition around `metaPlugin(...)` in `payload.config.ts` to go live.
>
> Check Meta's current Graph API version (`GRAPH_API_VERSION` in `utils/metaGraphClient.ts`, currently `v21.0`) if any call returns a deprecation error — Meta bumps this periodically.

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

> Inside this monorepo it's referenced as `workspace:*` — that works fine in CI/production as long as the build pipeline has an explicit build step for it before anything that imports it gets typechecked (its `dist/` is gitignored, not committed). Forgetting that step is a real failure mode: it happened once (Jenkinsfile only built `payload-erpnext-plugin`, not this package, causing a "Cannot find module" typecheck failure), fixed by adding the matching `pnpm build`/`tsc --noEmit` steps for this package alongside the erpnext plugin's in the Jenkinsfile's Validate stage.

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

### 2. Set the encryption key and the platform Meta App

```bash
# .env
META_ENCRYPTION_KEY=$(openssl rand -hex 32)
META_APP_ID=your-meta-app-id
META_APP_SECRET=your-meta-app-secret
```

Without `META_ENCRYPTION_KEY`, credentials are stored in plain text (allowed in development; the plugin **fails fast at startup in production** unless you explicitly set `ALLOW_PLAINTEXT_META_CREDS=true`, which you should not do).

`META_APP_ID`/`META_APP_SECRET` are the **one Meta App for the whole deployment** — same pattern as Buffer/Hootsuite/Zapier: every tenant site connects through this single App, they never create their own. There's no API to create a Meta App programmatically (unlike, say, ERPNext's OAuth Client doctype), so this is a one-time manual step:

1. Create an App at [developers.facebook.com](https://developers.facebook.com), add the **Facebook Login for Business** product (and **Threads API** if you'll connect Threads).
2. Add `{PAYLOAD_PUBLIC_SERVER_URL}/api/meta-oauth/callback` and `{PAYLOAD_PUBLIC_SERVER_URL}/api/threads-oauth/callback` as **Valid OAuth Redirect URIs**.
3. Switch the App to **Live** mode and request **Advanced Access** (via App Review) for whichever scopes you need — `pages_show_list`, `pages_read_engagement`, `instagram_basic`, `business_management`, `ads_management`, etc. In Development mode, OAuth only works for users added as Testers/Admins/Developers on the App itself — real tenant site owners won't be able to connect until this is done. Meta may also require **Business Verification** for the ads/marketing-adjacent scopes.
4. Set `META_APP_ID`/`META_APP_SECRET` from that App's Settings → Basic page and restart.

Site owners never see or enter these — the admin UI shows only a masked, read-only App ID (`GET /api/meta-oauth/app-info`) so they can confirm a platform App is configured before clicking Connect.

### 3. Create a `Meta Config` in the Payload Admin

Go to **Integrations → Meta Config**:

- Select the site/tenant.
- **🔑 Connection tab**: either paste a long-lived Access Token manually, **or** click **Connect to Meta Business** and log in — see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads) for the full walkthrough. Either way, save — the plugin verifies the token against the Graph API a couple of seconds later and updates **Connection Status**.
- Enable and configure only the channel tabs this site needs:
  - **📊 Pixel & Conversions API** — Pixel ID (paste one, or use **Select / Create Pixel**).
  - **🛍️ Commerce Catalog** — Catalog ID, the Payload collection slug to feed (e.g. `catalogue-items`), and an item URL template.
  - **💬 WhatsApp Business** — phone number ID + Business Account ID (outbound sending is already live via the host CMS's notification system once these are set — see [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp)).
  - **🧵 Threads** — click **Connect Threads** (its own, separate OAuth flow).
- Mark **Active** and save.

### 4. Wire a Conversions API event into a Workflow

Go to **Automation → Workflows**:

- Create or edit a workflow (e.g. triggered on order creation).
- In **Steps**, add a **Trigger Meta Conversion Event** block.
- Pick the event name (`Purchase`, `Lead`, `AddToCart`, etc.) and map `value`/`currency`/`content_name`/`email`/`phone` using `{{var}}` references into the workflow context — same templating syntax as the ERPNext plugin's `trigger_erp` step. `email`/`phone` are optional but recommended: they're SHA-256 hashed before ever leaving the server and significantly improve Meta's event match quality.
- Trigger collection is just as generic as any other Workflow — e.g. watch `form-submissions` (`collection_change` / `afterCreate`) to fire `Lead` on every contact-form or job-application submission, no plugin-specific wiring required.

---

## Connecting Facebook, Instagram, and Threads

Two ways to connect, fully interchangeable — pick whichever suits a given site. Both populate the exact same `accessToken`/`pixelId` fields, so nothing downstream (Conversions API, Catalog feed) needs to know which path was used.

### Option A — Manual

Paste a long-lived Page or System User access token directly into `accessToken` on the **🔑 Connection** tab. Useful if a site owner already has a token from elsewhere, or wants to skip the OAuth consent screen. Fully supported indefinitely — not a legacy fallback.

### Option B — Connect to Meta Business (OAuth)

Uses the one platform-level Meta App set up via `META_APP_ID`/`META_APP_SECRET` (see [Set the encryption key and the platform Meta App](#2-set-the-encryption-key-and-the-platform-meta-app) — that's a one-time deployment setup step, not something each site does). Once that's configured:

1. On the `meta-config` document's 🔑 Connection tab, the panel shows a masked, read-only **Platform Meta App** ID confirming it's configured.
2. Click **Connect to Meta Business** — you'll be redirected to Meta's OAuth consent screen requesting `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `instagram_basic`, `ads_management`, `catalog_management`, and `whatsapp_business_management` (trim the scope list in `metaOAuth.ts` if your App's review doesn't cover all of them — Meta simply omits ungranted permissions from the resulting token rather than failing the whole flow).
3. After consenting, you land back on the `meta-config` edit page. Click **Load My Pages**, pick the Facebook Page this site should use, then **Use This Page** — the linked Instagram Business account (if any) is detected automatically. The panel then shows a summary of what's connected: Business Manager ID, Facebook Page (name + ID), and Instagram handle.
4. On the **📊 Pixel & Conversions API** tab, enter a **Business Manager ID** (found in Meta Business Settings) on the Connection tab first, then use **Load Existing Pixels** to pick one, or **Create New Pixel** to make a fresh one scoped to that Business Manager.

### Connecting Threads

Threads is a **separate product/API** from Facebook and Instagram — its own OAuth host (`threads.net`, not `facebook.com`), its own token host (`graph.threads.net`, not `graph.facebook.com`), and its own token/profile shape — even though it's added as a product on the *same* Meta App and reuses the same platform-level `META_APP_ID`/`META_APP_SECRET`.

1. Add the **Threads API** product to the same Meta App (see setup step above), and register `{PAYLOAD_PUBLIC_SERVER_URL}/api/threads-oauth/callback` as its redirect URI.
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
| `META_APP_ID` / `META_APP_SECRET` | For OAuth Connect | The one Meta App for the whole deployment (developers.facebook.com) — every tenant site's Connect button uses this. Not required if every site only ever uses manual Access Token entry. Never entered by a site owner; see [Set the encryption key and the platform Meta App](#2-set-the-encryption-key-and-the-platform-meta-app). |
| `META_ENCRYPTION_KEY` | Production: yes | 32-byte hex key (`openssl rand -hex 32`) for AES-256-GCM credential encryption. Separate from `payload-erpnext-plugin`'s `ERPNEXT_ENCRYPTION_KEY` — rotating one doesn't affect the other. |
| `ALLOW_PLAINTEXT_META_CREDS` | No | Set to `true` to explicitly allow plain-text credential storage in production. Do not set this unless you understand the risk (a DB dump/backup leaks every tenant's Meta access token). |
| `PAYLOAD_PUBLIC_SERVER_URL` | For Catalog feed + OAuth | Used to build absolute image URLs in the Commerce Catalog feed, and the OAuth callback redirect URIs (`/api/meta-oauth/callback`, `/api/threads-oauth/callback`). Already set for the host CMS's other public-facing needs. |
| `META_OAUTH_STATE_SECRET` | No | HMAC key for signing the OAuth `state` param. Falls back to `META_ENCRYPTION_KEY` if unset — only set this separately if you want state-signing and credential-encryption keys to rotate independently. |

---

## The `meta-config` Collection

One document per site. `appId`/`appSecret` are **not** fields here — they're the one platform-level Meta App (`META_APP_ID`/`META_APP_SECRET`), never per-site. Every other credential field is directly editable (manual entry) — the Connect buttons are a convenience layer on top, not a replacement:

| Tab | Fields | Notes |
|---|---|---|
| 🔑 Connection | `accessToken` (encrypted, required), `businessManagerId`, `connectionStatus` (read-only), `authMethod` (read-only, informational), masked **Platform Meta App** readout, **Connect to Meta Business** button, `facebookPageId`/`facebookPageName`/`instagramBusinessAccountId`/`instagramUsername` (read-only, set by Connect, shown as a connected-account summary), `oauthUserAccessToken` (hidden, encrypted, internal) | `connectionStatus` updates ~2 seconds after save via a background Graph API `/me` check. See [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads). |
| 📊 Pixel & Conversions API | `pixelEnabled`, `pixelId`, **Select / Create Pixel** button | Enables `sendConversionEvent()` / the `meta-conversion-event` workflow action for this site. |
| 🛍️ Commerce Catalog | `catalogEnabled`, `catalogId`, `catalogSourceCollection`, `catalogItemUrlTemplate` | Enables `GET /api/meta-catalog/feed?site=<slug>`. |
| 💬 WhatsApp Business | `whatsappEnabled`, `whatsappPhoneNumberId`, `whatsappBusinessAccountId` | Populates the host CMS's existing `lib/whatsapp.ts` `metaCloud` provider — no plugin code needed for outbound sending. |
| 🧵 Threads | `threadsEnabled`, **Connect Threads** button, `threadsUserId`/`threadsUsername` (read-only, set by Connect), `threadsAccessToken` (hidden, encrypted) | Independent OAuth flow — see [Connecting Facebook, Instagram, and Threads](#connecting-facebook-instagram-and-threads). |

Credentials (`accessToken`, `oauthUserAccessToken`, `threadsAccessToken`) are AES-256-GCM encrypted at rest and masked in the admin UI (`••••1234`) for any authenticated non-internal request — the same pattern `ErpnextConfig` uses for `apiKey`/`apiSecret`. `META_APP_SECRET` never touches the database at all — it's read from the environment on each OAuth request.

---

## Conversions API / Workflow Steps

`sendConversionEvent(creds, input, log?)` posts a single event to `graph.facebook.com/v21.0/{pixel_id}/events`. Exported directly for host-app code that wants to call it outside the workflow engine:

```typescript
import { getMetaCredentials, sendConversionEvent } from 'payload-meta-plugin'

const creds = await getMetaCredentials(payload, 'thatofadagirl')
if (creds?.pixelId) {
  await sendConversionEvent(creds, {
    eventName: 'Purchase',
    customData: { value: 12500, currency: 'NGN' },
  })
}
```

There is deliberately **no client-side event to deduplicate against** — this plugin doesn't fire `fbq()` calls, so the `eventId`/dedup dance Meta's docs describe for hybrid Pixel+CAPI setups doesn't apply here. If a site later adds its own client Pixel events independently, `eventId` is available on `ConversionEventInput` to dedupe against those.

`ConversionEventInput.userData` accepts pre-hashed `emailHash`/`phoneHash` (SHA-256, caller hashes before calling — never pass raw PII here) for better event match quality. The workflow step below does this hashing for you from plain `email`/`phone` step fields.

The **Trigger Meta Conversion Event** workflow step (`trigger_meta_conversion` block) is the no-code path — see [Quick Start](#quick-start) step 4. It reads `event_name`/`value`/`currency`/`content_name`/`event_source_url`/`email`/`phone` off the step, resolves `{{var}}` templates against the workflow context, hashes `email`/`phone` (SHA-256, trimmed + lowercased; phone digits-only) before they ever reach Meta, and calls `sendConversionEvent()` under the hood (`metaConversionEventHandler` in `actions/metaActions.ts`).

**Any collection can trigger it** — the Workflow engine's trigger isn't Meta-specific. Watching `form-submissions` on `afterCreate` is the common case: a contact form or job application becomes a `Lead` event with zero extra plugin code, using the site's connected Pixel from the Connect flow above.

### Migrating from the old `analytics-integrations`/`meta-capi` path

Earlier, Meta Conversions API had a second, unrelated implementation: the host CMS's generic `send_analytics_event` workflow block (`analytics_provider: 'meta'`) reading credentials from an `analytics-integrations` collection row (`provider: 'meta-capi'`). That path is retired — `send_analytics_event` is GA4-only now. If you were using it, recreate the same event as a **Trigger Meta Conversion Event** step instead; the site's Pixel/token now come from `meta-config` (via Connect or manual entry above), not a second credential entry.

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

The host CMS already has real, generic, multi-tenant WhatsApp infrastructure:

- **Outbound**: `payload-cms/src/lib/whatsapp.ts`'s `sendWhatsApp()` supports the official Meta Cloud API provider (`metaCloud: { phoneNumberId, accessToken }`) alongside OpenWA, resolved per-site via `notificationService.ts`. Filling in `whatsappPhoneNumberId`/`whatsappBusinessAccountId` on `meta-config` is enough — no plugin code needed.
- **Inbound**: `payload-cms/src/collections/Webhooks.ts` + `webhookReceiver.ts` (`POST /api/webhooks/:id`) is a fully generic, per-site, HMAC-verified webhook receiver with replay protection and job-queue dispatch — its own admin description cites "WhatsApp Bot" as an example use case.

The one real gap: Meta's WhatsApp Cloud API webhook subscription requires a `GET` `hub.challenge`/`hub.verify_token` handshake before it will start sending `POST`s, and the generic receiver only handles `POST`+HMAC today. That's a small, targeted extension to the *host CMS's* existing `Webhooks` collection/`webhookReceiver.ts` — not something this plugin should duplicate with its own parallel WhatsApp-specific route. (An earlier, unrelated attempt at a WhatsApp webhook route lived directly in one frontend site, hardcoded and non-functional; it's been deleted.)

---

## Security

- Credentials (`accessToken`) are AES-256-GCM encrypted at rest (`META_ENCRYPTION_KEY`), masked in the admin UI, and only decrypted server-side when actually needed (e.g. `getMetaCredentials()`, the connection-health check). `META_APP_SECRET` is never stored in the database at all — it's read from the environment only, on each OAuth request.
- `accessToken` is only writable by `admin`/`super-admin` roles (`adminOrAboveField` field-level access) — editors can see the masked config but can't rotate credentials or repoint a connection.
- `getMetaCredentials()` never falls back across sites — a lookup for one site's slug will never return another tenant's credentials, even on a partial/missing config.
- The Commerce Catalog feed is intentionally public (Meta's crawler needs unauthenticated access) but strictly site-scoped — it can never return another site's data, and only returns docs that already belong to the requested site.
- The OAuth `state` param is HMAC-signed with a 10-minute TTL and verified with a constant-time comparison (`signOAuthState`/`verifyOAuthState` in `utils/metaCrypto.ts`) — the callback endpoints reject a forged, tampered, or replayed-after-expiry state before doing anything else.
- `/meta-oauth/select-page` and the Pixel endpoints only ever accept a `configId` + an identifier (`pageId`, pixel `name`) from the browser — the actual page/pixel access token is always re-fetched fresh from Graph server-side, never trusted from the client.
- OAuth endpoints (`/meta-oauth/*`, `/threads-oauth/start`) require an authenticated `admin`/`super-admin` session — same role gate as manual credential entry.

---

## What's Not Built Yet

- **WhatsApp webhook verify-token handshake** — belongs on the host CMS's `Webhooks` collection/`webhookReceiver.ts`, not this plugin (see [Why Not Rebuild WhatsApp?](#why-not-rebuild-whatsapp)).
- **Not live in production** — see the warning at the top of this README. A real Meta App exists and is being tested end-to-end in dev, but it's still in Development mode pending App Review/Live mode, so it's held out of production deploys until that clears (real customers can't complete OAuth against a Development-mode App regardless of what's deployed).

See `payload-cms/docs/future-features.md` in the host monorepo for the full, up-to-date plan and status.

---

## License

MIT
