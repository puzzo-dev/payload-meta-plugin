import type { CollectionConfig, CollectionAfterChangeHook, CollectionSlug, FieldAccess } from 'payload'
import {
    siteScopedCreate, siteScopedDelete, siteScopedRead, siteScopedUpdate
} from '../access/roles';
import { organizationField } from '../fields/organizationField';
import { encryptCredential, decryptCredential } from '../utils/metaCrypto';
import type { UserWithRole } from '../types';

/**
 * Field-level guard: only admins/super-admins (or trusted server calls using
 * overrideAccess) may set the Meta App Secret / Access Token. Editors can still
 * see the (masked) config, but must not be able to rotate credentials or exfiltrate
 * them by pointing the connection at something else.
 */
const adminOrAboveField: FieldAccess = ({ req }) =>
    ['super-admin', 'admin'].includes((req?.user as unknown as UserWithRole | undefined)?.role ?? '')

// ── Credential encryption hooks (reused by appSecret, accessToken) ──

async function encryptBeforeChange({ value, previousDoc, field, req }: { value: unknown; previousDoc?: Record<string, unknown>; field: { name: string }, req: any }) {
    if (typeof value === 'string' && value && !value.startsWith('••••')) {
        return encryptCredential(value)
    }
    if (typeof value === 'string' && value.startsWith('••••')) {
        if (!previousDoc?.id) {
            throw new Error(`Cannot save masked credential for ${field.name}. Please re-enter it.`)
        }
        const rawConfig = await req.payload.findByID({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: previousDoc.id,
            depth: 0,
            overrideAccess: true,
            context: { preventMasking: true, skipConnectionTest: true },
        }) as Record<string, unknown>;

        const decrypted = rawConfig[field.name];
        return decrypted && typeof decrypted === 'string' ? encryptCredential(decrypted) : value;
    }
    return value
}

function decryptAfterRead({ value, req, context }: { value: unknown; req: any; context?: Record<string, unknown> }) {
    if (typeof value !== 'string') return value
    const decrypted = decryptCredential(value)
    const ctx = req?.context || context || {}
    if (ctx.preventMasking) return decrypted
    if (req?.user && decrypted.length > 4) {
        return '••••' + decrypted.slice(-4)
    }
    return decrypted
}

// ── afterChange: test the connection when an access token is saved ──
//
// This hook does the minimum useful thing on every save: verifies the stored
// access token is actually valid by calling Graph API's /me, and records
// connectionStatus. Enumerating Pages/Pixels/WhatsApp numbers reachable by a
// token is the "Connect to Meta Business" OAuth flow's job (components/), not
// this hook's.
const testMetaConnection: CollectionAfterChangeHook = async ({ doc, previousDoc, operation, req }) => {
    if (operation === 'update' && previousDoc) {
        const alreadyConnected = doc.connectionStatus === 'connected'
        if (alreadyConnected) return doc
    }

    const rawConfig = await req.payload.findByID({
        collection: 'meta-config' as unknown as CollectionSlug,
        id: doc.id,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true, skipConnectionTest: true },
    }) as unknown as Record<string, unknown>

    const accessToken = rawConfig.accessToken as string | undefined
    if (!accessToken) return doc

    const decryptedToken = decryptCredential(accessToken)
    if (!decryptedToken) return doc

    let connected = false
    try {
        const res = await fetch(
            `https://graph.facebook.com/v21.0/me?access_token=${encodeURIComponent(decryptedToken)}`,
            { method: 'GET', signal: AbortSignal.timeout(15000) },
        )
        connected = res.ok

        await req.payload.update({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: doc.id,
            data: { connectionStatus: connected ? 'connected' : 'disconnected' } as any,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        req.payload.logger.info(`[MetaConfig] Connection test ${connected ? 'succeeded' : 'failed'} for config ${doc.id}`)
    } catch (err) {
        req.payload.logger.warn(`[MetaConfig] Connection test failed: ${err}`)
        try {
            await req.payload.update({
                collection: 'meta-config' as unknown as CollectionSlug,
                id: doc.id,
                data: { connectionStatus: 'disconnected' } as any,
                overrideAccess: true,
                context: { skipConnectionTest: true },
            })
        } catch { /* non-critical */ }
    }

    return doc
}

/**
 * MetaConfig
 *
 * Per-site Meta (Facebook/Instagram/WhatsApp) connection configuration.
 * Modular: a site enables only the channels it needs via the checkboxes on
 * each tab — nothing here assumes every site wants Pixel + Catalog + WhatsApp.
 *
 * UX Flow — two ways to connect, both fully supported side by side:
 *   A. Manual: enter App ID/Secret (optional) + long-lived Access Token → Save.
 *      afterChange hook verifies the token against Graph API and sets connectionStatus.
 *   B. OAuth ("Connect to Meta Business", like the official Meta for WordPress
 *      plugin): set App ID/Secret, click Connect, pick a Facebook Page you
 *      manage — its linked Instagram Business account is auto-detected — then
 *      select or create a Pixel. Connect Threads separately (its own OAuth
 *      flow — see collections/MetaConfig.ts Threads tab). OAuth just populates
 *      the same `accessToken`/`pixelId` fields manual entry uses, so nothing
 *      downstream (Conversions API, Catalog feed) needs to know which path
 *      populated them.
 *   Either way: enable whichever channel tabs this site needs (Pixel / Catalog
 *   / WhatsApp / Threads) — nothing here assumes a site wants all of them.
 *
 * Deliberately does NOT yet include: WhatsApp webhook verify-token handling
 * — if your host CMS already has a generic inbound-webhook system, extend
 * that rather than duplicating one here. See README.md for full status.
 */
export const MetaConfig: CollectionConfig = {
    slug: 'meta-config',
    labels: { singular: 'Meta Config', plural: 'Meta Configs' },
    admin: {
        useAsTitle: 'label',
        defaultColumns: ['label', 'site', 'connectionStatus', 'isActive', 'updatedAt'],
        group: 'Integrations',
        description: 'Connect this site to Meta (Facebook/Instagram/WhatsApp). Enable only the channels this site needs.',
    },
    access: {
        read: siteScopedRead(),
        create: siteScopedCreate(),
        update: siteScopedUpdate(),
        delete: siteScopedDelete(),
    },
    hooks: {
        afterChange: [
            (args) => {
                if ((args.context as Record<string, unknown>)?.skipConnectionTest) return args.doc

                const payload = args.req.payload
                const docRef = args.doc
                // Fire-and-forget, same 2s-after-commit pattern as ERPNextConfig — avoids
                // racing the save transaction with the immediate findByID re-read.
                setTimeout(() => {
                    testMetaConnection({ ...args, doc: docRef }).catch((err: unknown) => {
                        payload.logger.error(`[MetaConfig] Background connection test failed: ${err}`)
                    })
                }, 2000)

                return args.doc
            },
        ],
    },
    fields: [
        {
            name: 'label',
            type: 'text',
            required: true,
            admin: { description: 'Friendly name, e.g. "Acme Storefront — Meta"' },
        },
        {
            type: 'row',
            fields: [
                {
                    name: 'site',
                    type: 'relationship',
                    relationTo: 'sites',
                    required: true,
                    admin: {
                        description: 'The site this Meta config belongs to (one per site)',
                        width: '70%',
                    },
                },
                {
                    name: 'isActive',
                    type: 'checkbox',
                    defaultValue: true,
                    admin: { width: '30%' },
                },
            ],
        },
        organizationField(),

        {
            type: 'tabs',
            tabs: [
                // ── Tab 1: Connection ────────────────────────────────
                {
                    label: '🔑 Connection',
                    description: 'Create a Meta App and a long-lived System User or Page access token in Meta Business Manager, then enter them here.',
                    fields: [
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'appId',
                                    type: 'text',
                                    admin: { description: 'Meta App ID', width: '50%' },
                                },
                                {
                                    name: 'appSecret',
                                    type: 'text',
                                    access: { create: adminOrAboveField, update: adminOrAboveField },
                                    admin: { description: 'Meta App Secret', width: '50%' },
                                    hooks: {
                                        beforeChange: [
                                            async ({ value, previousDoc, req }) =>
                                                await encryptBeforeChange({ value, previousDoc, field: { name: 'appSecret' }, req }),
                                        ],
                                        afterRead: [
                                            ({ value, req, context }) =>
                                                decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                        ],
                                    },
                                },
                            ],
                        },
                        {
                            name: 'accessToken',
                            type: 'text',
                            required: true,
                            access: { create: adminOrAboveField, update: adminOrAboveField },
                            admin: { description: 'Long-lived System User or Page access token' },
                            hooks: {
                                beforeChange: [
                                    async ({ value, previousDoc, req }) =>
                                        await encryptBeforeChange({ value, previousDoc, field: { name: 'accessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                        {
                            name: 'businessManagerId',
                            type: 'text',
                            admin: { description: 'Meta Business Manager ID (needed to list/create Pixels via Connect, and for some other Graph API calls)' },
                        },
                        {
                            name: 'connectionStatus',
                            type: 'select',
                            defaultValue: 'untested',
                            options: [
                                { label: '✅ Connected', value: 'connected' },
                                { label: '❌ Disconnected', value: 'disconnected' },
                                { label: '⏳ Untested', value: 'untested' },
                            ],
                            admin: {
                                description: 'Connection health — updated automatically when you save.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'authMethod',
                            type: 'select',
                            defaultValue: 'manual',
                            options: [
                                { label: 'Manual (paste Access Token)', value: 'manual' },
                                { label: 'Connected via Meta Business Login', value: 'oauth' },
                            ],
                            admin: {
                                description: 'Set automatically by the Connect flow below — informational only, does not change how credentials are used.',
                                readOnly: true,
                            },
                        },
                        {
                            name: 'metaConnectPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'payload-meta-plugin/components/MetaConnectPanel',
                                        exportName: 'MetaConnectPanelField',
                                    },
                                },
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'facebookPageId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect. Facebook Page ID.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'facebookPageName',
                                    type: 'text',
                                    admin: { description: 'Set by Connect.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'instagramBusinessAccountId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect — auto-detected from the selected Page.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'instagramUsername',
                                    type: 'text',
                                    admin: { description: 'Set by Connect.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            name: 'oauthUserAccessToken',
                            type: 'text',
                            admin: {
                                hidden: true,
                                description: 'Internal — long-lived user token from Meta Business Login, used to re-fetch Pages/Pixels. Not the credential used for API calls (accessToken, set to the selected Page\'s token, is).',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, previousDoc, req }) =>
                                        await encryptBeforeChange({ value, previousDoc, field: { name: 'oauthUserAccessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                    ],
                },

                // ── Tab 2: Pixel & Conversions API ───────────────────
                {
                    label: '📊 Pixel & Conversions API',
                    description: 'Client-side Pixel events plus a matching server-side Conversions API event (deduplicated by event_id) for accurate tracking despite iOS ad-tracking loss.',
                    fields: [
                        {
                            name: 'pixelEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: { description: 'Enable Pixel + Conversions API for this site' },
                        },
                        {
                            name: 'pixelId',
                            type: 'text',
                            admin: {
                                description: 'Meta Pixel ID — paste one directly, or use "Select / Create Pixel" below (requires Business Manager ID + Connect on the Connection tab).',
                                condition: (_data, siblingData) => Boolean(siblingData?.pixelEnabled),
                            },
                        },
                        {
                            name: 'metaPixelSelectPanel',
                            type: 'ui',
                            admin: {
                                condition: (_data, siblingData) => Boolean(siblingData?.pixelEnabled),
                                components: {
                                    Field: {
                                        path: 'payload-meta-plugin/components/MetaPixelSelect',
                                        exportName: 'MetaPixelSelectField',
                                    },
                                },
                            },
                        },
                    ],
                },

                // ── Tab 3: Commerce Catalog ──────────────────────────
                {
                    label: '🛍️ Commerce Catalog',
                    description: 'Expose this site\'s product/menu collection as a Meta-compatible Commerce Catalog feed for Facebook/Instagram Shop.',
                    fields: [
                        {
                            name: 'catalogEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: { description: 'Enable Commerce Catalog for this site' },
                        },
                        {
                            name: 'catalogId',
                            type: 'text',
                            admin: {
                                description: 'Meta Commerce Catalog ID',
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                        {
                            name: 'catalogSourceCollection',
                            type: 'text',
                            admin: {
                                description: 'Payload collection slug to feed into the catalog (e.g. "products", "menu-items") — not hardcoded to any one site\'s schema.',
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                        {
                            name: 'catalogItemUrlTemplate',
                            type: 'text',
                            admin: {
                                description: 'Item page URL template on the live site — "{slug}" is replaced per item, e.g. https://example.com/products/{slug}. Required for a valid feed (Meta rejects items without a working link).',
                                condition: (_data, siblingData) => Boolean(siblingData?.catalogEnabled),
                            },
                        },
                    ],
                },

                // ── Tab 4: WhatsApp Business ─────────────────────────
                {
                    label: '💬 WhatsApp Business',
                    description: 'WhatsApp Business Cloud API. Outbound sending already works via the CMS\'s notification system (lib/whatsapp.ts) once this site\'s number is entered here.',
                    fields: [
                        {
                            name: 'whatsappEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: { description: 'Enable WhatsApp Business Cloud API for this site' },
                        },
                        {
                            name: 'whatsappPhoneNumberId',
                            type: 'text',
                            admin: {
                                description: 'WhatsApp Business phone number ID',
                                condition: (_data, siblingData) => Boolean(siblingData?.whatsappEnabled),
                            },
                        },
                        {
                            name: 'whatsappBusinessAccountId',
                            type: 'text',
                            admin: {
                                description: 'WhatsApp Business Account ID',
                                condition: (_data, siblingData) => Boolean(siblingData?.whatsappEnabled),
                            },
                        },
                    ],
                },

                // ── Tab 5: Threads ────────────────────────────────────
                {
                    label: '🧵 Threads',
                    description: 'Threads is a separate product/API from Facebook & Instagram (its own OAuth flow, on the same Meta App) — connect it independently.',
                    fields: [
                        {
                            name: 'threadsEnabled',
                            type: 'checkbox',
                            defaultValue: false,
                            admin: { description: 'Enable Threads for this site — set automatically once Connect Threads succeeds; can also be toggled off to disable without disconnecting.' },
                        },
                        {
                            name: 'threadsConnectPanel',
                            type: 'ui',
                            admin: {
                                components: {
                                    Field: {
                                        path: 'payload-meta-plugin/components/ThreadsConnectPanel',
                                        exportName: 'ThreadsConnectPanelField',
                                    },
                                },
                            },
                        },
                        {
                            type: 'row',
                            fields: [
                                {
                                    name: 'threadsUserId',
                                    type: 'text',
                                    admin: { description: 'Set by Connect Threads.', readOnly: true, width: '50%' },
                                },
                                {
                                    name: 'threadsUsername',
                                    type: 'text',
                                    admin: { description: 'Set by Connect Threads.', readOnly: true, width: '50%' },
                                },
                            ],
                        },
                        {
                            name: 'threadsAccessToken',
                            type: 'text',
                            admin: {
                                hidden: true,
                                description: 'Internal — long-lived Threads access token.',
                            },
                            hooks: {
                                beforeChange: [
                                    async ({ value, previousDoc, req }) =>
                                        await encryptBeforeChange({ value, previousDoc, field: { name: 'threadsAccessToken' }, req }),
                                ],
                                afterRead: [
                                    ({ value, req, context }) =>
                                        decryptAfterRead({ value, req, context: context as Record<string, unknown> }),
                                ],
                            },
                        },
                    ],
                },
            ],
        },
    ],
    timestamps: true,
}
