import { getUserOrgId, getUserSiteId, getUserWithRole } from '../types'

function relationId(value: unknown): string | number | null {
    if (value == null || value === '') return null
    if (typeof value === 'object') {
        const id = (value as { id?: unknown }).id
        if (typeof id === 'string' || typeof id === 'number') return id
        return null
    }
    if (typeof value === 'string' || typeof value === 'number') return value
    return null
}

/**
 * The site dropdown's starting value. An editor is pinned to their own site.
 * An organization admin has no single site, so the form leaves the dropdown
 * open unless that organization has exactly one site (the admin UI fills that
 * case). A super-admin picks any site.
 */
export function defaultSiteId(user: unknown): string | number | null {
    const account = getUserWithRole(user)
    if (!account || account.role === 'super-admin') return null
    return getUserSiteId(account)
}

/** The organization dropdown's starting value. Super-admins choose an organization first. */
export function defaultOrganizationId(user: unknown): string | number | null {
    const account = getUserWithRole(user)
    if (!account || account.role === 'super-admin') return null
    return getUserOrgId(account)
}

/**
 * Editors are forced onto their own site. Organization admins may choose a
 * site, but only one that belongs to their organization — that check needs
 * the site row, so this only returns the pinned id or the submitted value.
 */
export function pinnedSiteValue(user: unknown, submitted: unknown): unknown {
    const account = getUserWithRole(user)
    if (!account || account.role === 'super-admin') return submitted
    const ownSite = getUserSiteId(account)
    if (ownSite != null) return ownSite
    return relationId(submitted) ?? submitted
}

/**
 * Non-super-admins keep their own organization. Super-admins get the
 * organization that owns the submitted site when that lookup succeeded.
 */
export function pinnedOrganizationValue(
    user: unknown,
    submitted: unknown,
    siteOrganizationId: string | number | null,
): unknown {
    const account = getUserWithRole(user)
    if (account && account.role !== 'super-admin') {
        const ownOrg = getUserOrgId(account)
        if (ownOrg != null) return ownOrg
    }
    return siteOrganizationId ?? relationId(submitted) ?? submitted
}
