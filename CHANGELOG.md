# Changelog

## 0.3.0

### Added

- Each site connects with its own Facebook login. The connection screen shows
  that account's name, and another site cannot reuse it.
- Commerce catalogue items sync to the site's Meta catalog when they are
  saved or deleted. A "Sync commerce products now" action sends the whole
  catalogue, the same way the WooCommerce Facebook plugin pushes products.
- After Facebook login, the same screen asks for the Page, catalog, and
  Pixel. A site with none can create the catalog or Pixel there.
- Official WhatsApp numbers on that Facebook login can be chosen for Payload
  notifications. The OpenWA bridge remains for sites that do not choose one.
- Choosing that number files the enquiry alert messages on the site's own
  WhatsApp account, including a short note that alerts are ready. The connect
  screen shows one status — preparing, Meta is reviewing (safe to leave),
  ready, or a single retry — and official alerts send as those messages once
  Meta approves them. The CMS keeps checking and tells the owner through a
  workflow when that happens.

## 0.2.2

### Added

- Test suite for credential encryption, OAuth state signing, Conversions API
  payloads, the catalog feed, and per-site access control.

### Fixed

- Resetting the encryption key in tests left the OAuth state secret cached, so
  a later test could accept a state token signed with the previous secret.

### Changed

- Removed unsafe casts in the plugin source.
- Documented the canonical sources for the mirrored `organizationField` and
  credential-crypto helpers.

## 0.2.1

### Fixed

- Removed a hardcoded fallback secret.

### Changed

- Widened the `@payloadcms/ui` peer dependency to `^3.84.1 || ^3.86.0`.

## 0.2.0

### Added

- One platform Meta App (`META_APP_ID` / `META_APP_SECRET`) for every tenant.
  Sites connect through it with OAuth. They do not create their own App, and
  the admin UI shows a masked App ID plus the connected Page and Instagram
  account.
- SHA-256 hashing of email and phone on the Trigger Meta Conversion Event
  step, so match data sent to Meta is never the raw value.

### Changed

- Commerce Catalog feed currency default is NGN.
- Production startup fails without `META_ENCRYPTION_KEY` unless
  `ALLOW_PLAINTEXT_META_CREDS=true`.

## 0.1.0

### Added

- Initial release. Per-site `meta-config` with encrypted credentials, Meta
  Business Login, Threads connect, server-side Conversions API, and a Commerce
  Catalog CSV feed.
