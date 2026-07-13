import type { Access, PayloadRequest } from 'payload'
import { timingSafeEqual } from 'node:crypto'

/**
 * Minimal access control helpers used by the plugin. This is a self-contained
 * published npm package (not workspace-linked into any particular host repo),
 * so it defines its own copy of these primitives rather than importing them
 * from elsewhere.
 */

export type UserWithRole = {
    id: string | number
    role: 'super-admin' | 'admin' | 'editor' | string
    email?: string
    organization?: string | number | { id: string | number } | null
    site?: string | number | { id: string | number } | null
}

export const anyone: Access = () => true

export const authenticated: Access = ({ req: { user } }) => Boolean(user)

export const superAdminOnly: Access = ({ req: { user } }) => {
    if (!user) return false
    return (user as unknown as UserWithRole).role === 'super-admin'
}

export function isInternalAuth(req: { headers?: { get: (name: string) => string | null } } | PayloadRequest): boolean {
    const secret = process.env.INTERNAL_API_SECRET
    if (!secret) return false
    const authSecret = req.headers?.get('x-internal-auth')
    if (!authSecret) return false
    const a = Buffer.from(authSecret)
    const b = Buffer.from(secret)
    if (a.byteLength !== b.byteLength) return false
    return timingSafeEqual(a, b)
}

export const getUserOrgId = (user: UserWithRole): string | number | null => {
    if (!user.organization) return null
    if (typeof user.organization === 'object') return user.organization.id
    return user.organization
}

export const getUserSiteId = (user: UserWithRole): string | number | null => {
    if (!user.site) return null
    if (typeof user.site === 'object') return user.site.id
    return user.site
}

/** Resolved Meta API credentials for a single site, decrypted and ready to use. */
export interface MetaCredentials {
    appId?: string
    appSecret?: string
    accessToken: string
    businessManagerId?: string
    pixelId?: string
    catalogId?: string
    whatsappPhoneNumberId?: string
    whatsappBusinessAccountId?: string
}

export interface MetaConfigDoc {
    id: string | number
    label: string
    site: string | number | { id: string | number }
    isActive: boolean
    connectionStatus?: 'connected' | 'disconnected' | 'untested'
    authMethod?: 'manual' | 'oauth'
    appId?: string
    appSecret?: string
    accessToken?: string
    businessManagerId?: string
    oauthUserAccessToken?: string
    facebookPageId?: string
    facebookPageName?: string
    instagramBusinessAccountId?: string
    instagramUsername?: string
    pixelEnabled?: boolean
    pixelId?: string
    catalogEnabled?: boolean
    catalogId?: string
    catalogSourceCollection?: string
    catalogItemUrlTemplate?: string
    whatsappEnabled?: boolean
    whatsappPhoneNumberId?: string
    whatsappBusinessAccountId?: string
    threadsEnabled?: boolean
    threadsUserId?: string
    threadsUsername?: string
    threadsAccessToken?: string
}

/** Structured logger signature used across the plugin. */
export type LogFn = (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void

/**
 * Runtime collection slugs that may not yet be in the host CMS's generated
 * payload-types.ts. Cast through this when referencing collections that
 * aren't in Config['collections'] yet.
 */
export type RuntimeCollectionSlug =
    | 'users'
    | 'sites'
    | 'organizations'
    | 'meta-config'
