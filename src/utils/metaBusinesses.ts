import { graphGet } from './metaGraphClient'

export interface MetaBusiness {
    id: string
    name: string
}

/**
 * Businesses the Facebook login can manage. A saved Business Manager ID
 * limits the list to that one business. Otherwise every business on the login
 * is returned, which is how a first-time connect finds catalogs, Pixels, and
 * WhatsApp numbers without anyone pasting an ID.
 */
export async function listBusinesses(
    token: string,
    businessManagerId: unknown,
): Promise<{ ok: true; businesses: MetaBusiness[] } | { ok: false; error: string }> {
    const pinned = typeof businessManagerId === 'string' ? businessManagerId.trim() : ''
    if (pinned) return { ok: true, businesses: [{ id: pinned, name: pinned }] }

    const listed = await graphGet<{ data?: Array<{ id: string; name?: string }> }>('/me/businesses', {
        fields: 'id,name',
        access_token: token,
        limit: '25',
    })
    if (!listed.ok) {
        return { ok: false, error: listed.error || 'Could not read businesses for this Facebook login.' }
    }
    return {
        ok: true,
        businesses: (listed.data?.data ?? []).map((business) => ({
            id: business.id,
            name: business.name || business.id,
        })),
    }
}
