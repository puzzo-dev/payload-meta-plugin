import type { Endpoint, CollectionSlug, PayloadRequest } from 'payload'
import { decryptCredential } from './metaCrypto'
import type { MetaCredentials } from '../types'

/**
 * Resolve a site's active Meta credentials from the meta-config collection.
 * Per-site lookup only — never falls back to another site's config, which
 * would leak data across tenants. Decrypts the masking-safety-net way
 * (re-decrypt if an "enc:" prefix leaked through afterRead), and fails
 * closed on any inconsistency rather than guessing.
 */
export async function getMetaCredentials(
    payload: Parameters<Endpoint['handler']>[0]['payload'],
    siteSlug?: string | null,
    _req?: PayloadRequest,
): Promise<MetaCredentials | null> {
    const isMasked = (v: string) => v.includes('•')

    const buildCreds = (cfg: Record<string, unknown>): MetaCredentials | null => {
        const rawToken = cfg.accessToken as string
        if (!rawToken) return null

        if (isMasked(rawToken)) {
            payload.logger.error(
                `[MetaCredentials] Credential masking leaked through for config ${cfg.id}. ` +
                `This indicates a Payload framework bug. Failing closed — do NOT fall back to raw SQL.`,
            )
            return null
        }

        const accessToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken
        if (!accessToken || isMasked(accessToken)) return null

        const rawAppSecret = cfg.appSecret as string | undefined
        const appSecret = rawAppSecret
            ? (rawAppSecret.startsWith('enc:') ? decryptCredential(rawAppSecret) : rawAppSecret)
            : undefined

        return {
            appId: (cfg.appId as string) || undefined,
            appSecret,
            accessToken,
            businessManagerId: (cfg.businessManagerId as string) || undefined,
            pixelId: (cfg.pixelEnabled && cfg.pixelId) ? (cfg.pixelId as string) : undefined,
            catalogId: (cfg.catalogEnabled && cfg.catalogId) ? (cfg.catalogId as string) : undefined,
            whatsappPhoneNumberId: (cfg.whatsappEnabled && cfg.whatsappPhoneNumberId) ? (cfg.whatsappPhoneNumberId as string) : undefined,
            whatsappBusinessAccountId: (cfg.whatsappEnabled && cfg.whatsappBusinessAccountId) ? (cfg.whatsappBusinessAccountId as string) : undefined,
        }
    }

    if (!siteSlug) return null

    const sites = await payload.find({
        collection: 'sites',
        where: { slug: { equals: siteSlug } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
    })
    if (sites.totalDocs === 0) return null

    const configs = await payload.find({
        collection: 'meta-config' as unknown as CollectionSlug,
        where: { site: { equals: sites.docs[0].id }, isActive: { equals: true } },
        limit: 1,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })
    if (configs.totalDocs === 0) return null

    return buildCreds(configs.docs[0] as unknown as Record<string, unknown>)
}
