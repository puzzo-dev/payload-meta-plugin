import type { Plugin } from 'payload'
import { MetaConfig } from './collections/MetaConfig'
import { metaCatalogFeedEndpoint } from './endpoints/metaCatalogFeed'
import { metaConversionEventHandler } from './actions/metaActions'
import {
    metaOAuthStartEndpoint,
    metaOAuthCallbackEndpoint,
    metaOAuthPagesEndpoint,
    metaOAuthSelectPageEndpoint,
    metaOAuthListPixelsEndpoint,
    metaOAuthCreatePixelEndpoint,
} from './endpoints/metaOAuth'
import { threadsOAuthStartEndpoint, threadsOAuthCallbackEndpoint } from './endpoints/threadsOAuth'

/** Minimal interface for a host CMS action registry, if you have one (e.g. a workflow/automation engine). */
export interface ActionRegistryRef {
    register: (slug: string, handler: (ctx: any) => Promise<{ success: boolean; data?: Record<string, unknown>; error?: string }>) => void
}

export interface MetaPluginOptions {
    /**
     * Your host CMS's action registry, if it has one (an automation/workflow
     * engine that dispatches named actions). When provided, the plugin
     * registers `meta-conversion-event` so a workflow step can invoke it.
     */
    registry?: ActionRegistryRef
    /** Reserved for future host bindings. Unused for now. */
    host?: Record<string, unknown>
}

/**
 * Meta Network Plugin for Payload CMS
 *
 * Lets an admin/superadmin connect any site in the multi-tenant platform to
 * Meta's network. Modular per-channel (Pixel/Conversions API, Commerce Catalog,
 * WhatsApp Business Cloud API) and per-site — a site enables only what it needs.
 *
 * Provides:
 *  - `meta-config` collection — per-site connection + per-channel config,
 *    credentials encrypted at rest, Graph API connection-health check.
 *  - "Connect to Meta Business" OAuth flow (same UX as the official Meta for
 *    WordPress plugin): authorize, pick a Facebook Page you manage, its linked
 *    Instagram Business account is auto-detected, then select or create a
 *    Pixel — plus a separate Threads connect flow. Manual credential entry
 *    stays fully available side by side; OAuth just populates the same
 *    fields.
 *  - Server-side Conversions API dispatch (`sendConversionEvent`), wired into
 *    the CMS workflow engine as a `meta-conversion-event` action (requires
 *    `registry`) so any Workflow can fire a "Trigger Meta Conversion Event"
 *    step — order creation → Purchase, contact-form submit → Lead, etc.
 *  - `GET /api/meta-catalog/feed?site=<slug>` — Commerce Catalog CSV feed,
 *    generated from whichever collection the site's meta-config designates.
 *
 * Deliberately does not yet include a WhatsApp webhook verify-token handshake
 * — if your host CMS already has a generic inbound-webhook system, extend
 * that rather than duplicating one here. See this package's README.md for
 * the full list of what is and isn't built.
 */
export function metaPlugin(options: MetaPluginOptions = {}): Plugin {
    if (options.registry) {
        options.registry.register('meta-conversion-event', metaConversionEventHandler)
    }

    return (config) => {
        const modifiedCollections = (config.collections || []).map((collection) => {
            if (collection.slug !== 'workflows') return collection

            const stepsField = collection.fields.find((f: any) => f.name === 'steps') as any
            if (!stepsField || stepsField.type !== 'blocks') return collection

            stepsField.blocks = [
                ...(stepsField.blocks || []),
                {
                    slug: 'trigger_meta_conversion',
                    labels: { singular: 'Trigger Meta Conversion Event', plural: 'Trigger Meta Conversion Events' },
                    fields: [
                        {
                            name: 'event_name',
                            type: 'select',
                            required: true,
                            options: [
                                { label: 'Lead', value: 'Lead' },
                                { label: 'Purchase', value: 'Purchase' },
                                { label: 'AddToCart', value: 'AddToCart' },
                                { label: 'InitiateCheckout', value: 'InitiateCheckout' },
                                { label: 'ViewContent', value: 'ViewContent' },
                                { label: 'CompleteRegistration', value: 'CompleteRegistration' },
                            ],
                            admin: { description: 'Meta standard event name.' },
                        },
                        {
                            name: 'value',
                            type: 'text',
                            admin: { description: 'Numeric value, e.g. order total. Supports {{var}} (e.g. {{order_total}}).' },
                        },
                        {
                            name: 'currency',
                            type: 'text',
                            defaultValue: 'USD',
                            admin: { description: '3-letter currency code. Supports {{var}}.' },
                        },
                        {
                            name: 'content_name',
                            type: 'text',
                            admin: { description: 'Optional. Supports {{var}}.' },
                        },
                        {
                            name: 'event_source_url',
                            type: 'text',
                            admin: { description: 'Optional. Supports {{var}}.' },
                        },
                    ],
                },
            ]
            return collection
        })

        return {
            ...config,
            collections: [...modifiedCollections, MetaConfig],
            endpoints: [
                ...(config.endpoints || []),
                metaCatalogFeedEndpoint,
                metaOAuthStartEndpoint,
                metaOAuthCallbackEndpoint,
                metaOAuthPagesEndpoint,
                metaOAuthSelectPageEndpoint,
                metaOAuthListPixelsEndpoint,
                metaOAuthCreatePixelEndpoint,
                threadsOAuthStartEndpoint,
                threadsOAuthCallbackEndpoint,
            ],
        }
    }
}

export { encryptCredential, decryptCredential } from './utils/metaCrypto'
export { getMetaCredentials } from './utils/metaCredentials'
export { sendConversionEvent } from './sync/conversionsApi'
export { metaConversionEventHandler } from './actions/metaActions'
export type { ConversionEventInput, ConversionEventResult } from './sync/conversionsApi'
export type { MetaCredentials, MetaConfigDoc } from './types'
