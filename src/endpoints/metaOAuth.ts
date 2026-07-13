import type { Endpoint, CollectionSlug } from 'payload'
import { encryptCredential, decryptCredential, signOAuthState, verifyOAuthState } from '../utils/metaCrypto'
import { graphGet, graphPost, GRAPH_API_VERSION } from '../utils/metaGraphClient'
import type { UserWithRole } from '../types'

/**
 * Meta Business Login connect flow — same idea as the official "Meta for
 * WordPress" plugin's connector: pick a Facebook Page you manage, auto-detect
 * its linked Instagram Business account, then select or create a Pixel.
 *
 * Scopes requested: business_management, pages_show_list, pages_read_engagement,
 * pages_manage_metadata, instagram_basic, ads_management, catalog_management,
 * whatsapp_business_management. Trim this list if a deployment's Meta App
 * review doesn't cover all of them — Meta will simply omit ungranted
 * permissions from the resulting token rather than failing the whole flow.
 *
 * IMPORTANT: these endpoints implement Meta's documented Graph API contracts
 * (OAuth dialog, token exchange, /me/accounts, owned_pixels, adspixels) as of
 * API version v21.0, but have not been exercised against a real Meta App —
 * doing so requires a live App ID/Secret and a browser to complete the OAuth
 * consent screen, neither of which exist in this environment. Do a manual
 * test connect before relying on this in production, and check Meta's current
 * API version if anything here returns a deprecation error.
 */

const OAUTH_SCOPES = [
    'business_management',
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_metadata',
    'instagram_basic',
    'ads_management',
    'catalog_management',
    'whatsapp_business_management',
].join(',')

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = (req.user as unknown as UserWithRole | undefined)?.role
    return role === 'super-admin' || role === 'admin'
}

function serverUrl(): string {
    return (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
}

function callbackRedirectUri(): string {
    return `${serverUrl()}/api/meta-oauth/callback`
}

async function loadConfig(payload: Parameters<Endpoint['handler']>[0]['payload'], configId: string) {
    return payload.findByID({
        collection: 'meta-config' as unknown as CollectionSlug,
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    }) as unknown as Record<string, unknown>
}

// ── GET /meta-oauth/start?configId=<id> ────────────────────────────────────
export const metaOAuthStartEndpoint: Endpoint = {
    path: '/meta-oauth/start',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.json({ error: 'Config not found' }, { status: 404 })
        }

        const appId = config.appId as string | undefined
        if (!appId) {
            return Response.json({ error: 'Set a Meta App ID on the Connection tab before connecting.' }, { status: 400 })
        }

        const state = signOAuthState(configId)
        const params = new URLSearchParams({
            client_id: appId,
            redirect_uri: callbackRedirectUri(),
            state,
            scope: OAUTH_SCOPES,
            response_type: 'code',
        })

        return Response.redirect(`https://www.facebook.com/${GRAPH_API_VERSION}/dialog/oauth?${params}`, 302)
    },
}

// ── GET /meta-oauth/callback?code=&state= ──────────────────────────────────
export const metaOAuthCallbackEndpoint: Endpoint = {
    path: '/meta-oauth/callback',
    method: 'get',
    handler: async (req) => {
        const code = req.query?.code as string | undefined
        const state = req.query?.state as string | undefined
        const oauthError = req.query?.error_description as string | undefined

        const adminBase = `${serverUrl()}/admin/collections/meta-config`

        if (oauthError) {
            return Response.redirect(`${adminBase}?meta_oauth_error=${encodeURIComponent(oauthError)}`, 302)
        }
        if (!code || !state) {
            return Response.redirect(`${adminBase}?meta_oauth_error=${encodeURIComponent('Missing code or state')}`, 302)
        }

        const configId = verifyOAuthState(state)
        if (!configId) {
            return Response.redirect(`${adminBase}?meta_oauth_error=${encodeURIComponent('Invalid or expired connect request — try again')}`, 302)
        }

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.redirect(`${adminBase}?meta_oauth_error=${encodeURIComponent('Config not found')}`, 302)
        }

        const appId = config.appId as string | undefined
        const rawAppSecret = config.appSecret as string | undefined
        const appSecret = rawAppSecret?.startsWith('enc:') ? decryptCredential(rawAppSecret) : rawAppSecret
        if (!appId || !appSecret) {
            return Response.redirect(`${adminBase}/${configId}?meta_oauth_error=${encodeURIComponent('App ID/Secret not configured')}`, 302)
        }

        // Step 1: code -> short-lived user access token
        const shortLived = await graphGet<{ access_token?: string }>('/oauth/access_token', {
            client_id: appId,
            client_secret: appSecret,
            redirect_uri: callbackRedirectUri(),
            code,
        })
        if (!shortLived.ok || !shortLived.data?.access_token) {
            return Response.redirect(`${adminBase}/${configId}?meta_oauth_error=${encodeURIComponent(shortLived.error || 'Token exchange failed')}`, 302)
        }

        // Step 2: short-lived -> long-lived user access token (~60 days, refreshed on next connect)
        const longLived = await graphGet<{ access_token?: string }>('/oauth/access_token', {
            grant_type: 'fb_exchange_token',
            client_id: appId,
            client_secret: appSecret,
            fb_exchange_token: shortLived.data.access_token,
        })
        if (!longLived.ok || !longLived.data?.access_token) {
            return Response.redirect(`${adminBase}/${configId}?meta_oauth_error=${encodeURIComponent(longLived.error || 'Long-lived token exchange failed')}`, 302)
        }

        await req.payload.update({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: configId,
            data: {
                authMethod: 'oauth',
                oauthUserAccessToken: encryptCredential(longLived.data.access_token),
                connectionStatus: 'connected',
            } as any,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.redirect(`${adminBase}/${configId}?meta_oauth_success=1`, 302)
    },
}

// ── GET /meta-oauth/pages?configId=<id> ─────────────────────────────────────
export const metaOAuthPagesEndpoint: Endpoint = {
    path: '/meta-oauth/pages',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        const rawToken = config.oauthUserAccessToken as string | undefined
        if (!rawToken) return Response.json({ error: 'Not connected — click "Connect to Meta Business" first' }, { status: 400 })
        const userToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        const result = await graphGet<{ data?: Array<{ id: string; name: string }> }>('/me/accounts', {
            fields: 'id,name',
            access_token: userToken,
            limit: '100',
        })
        if (!result.ok) return Response.json({ error: result.error }, { status: 502 })

        return Response.json({ pages: result.data?.data ?? [] })
    },
}

// ── POST /meta-oauth/select-page { configId, pageId } ───────────────────────
export const metaOAuthSelectPageEndpoint: Endpoint = {
    path: '/meta-oauth/select-page',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const body = (await req.json?.()) as { configId?: string; pageId?: string } | undefined
        const configId = body?.configId
        const pageId = body?.pageId
        if (!configId || !pageId) return Response.json({ error: 'Missing configId or pageId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        const rawToken = config.oauthUserAccessToken as string | undefined
        if (!rawToken) return Response.json({ error: 'Not connected — click "Connect to Meta Business" first' }, { status: 400 })
        const userToken = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        // Re-fetch fresh from Graph rather than trusting a client-supplied page token —
        // the browser only ever sees page IDs/names, never page tokens.
        const pagesResult = await graphGet<{ data?: Array<{ id: string; name: string; access_token?: string }> }>('/me/accounts', {
            fields: 'id,name,access_token',
            access_token: userToken,
            limit: '100',
        })
        if (!pagesResult.ok) return Response.json({ error: pagesResult.error }, { status: 502 })

        const page = (pagesResult.data?.data ?? []).find((p) => p.id === pageId)
        if (!page || !page.access_token) {
            return Response.json({ error: 'Page not found or not accessible with the current connection' }, { status: 404 })
        }

        const igResult = await graphGet<{ instagram_business_account?: { id: string; username?: string } }>(`/${pageId}`, {
            fields: 'instagram_business_account{id,username}',
            access_token: page.access_token,
        })
        const igAccount = igResult.ok ? igResult.data?.instagram_business_account : undefined

        await req.payload.update({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: configId,
            data: {
                facebookPageId: page.id,
                facebookPageName: page.name,
                accessToken: encryptCredential(page.access_token),
                instagramBusinessAccountId: igAccount?.id || null,
                instagramUsername: igAccount?.username || null,
            } as any,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.json({
            ok: true,
            facebookPageId: page.id,
            facebookPageName: page.name,
            instagramBusinessAccountId: igAccount?.id || null,
            instagramUsername: igAccount?.username || null,
        })
    },
}

// ── GET /meta-oauth/pixels?configId=<id> ────────────────────────────────────
export const metaOAuthListPixelsEndpoint: Endpoint = {
    path: '/meta-oauth/pixels',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        const businessManagerId = config.businessManagerId as string | undefined
        if (!businessManagerId) {
            return Response.json({ error: 'Set a Business Manager ID on the Connection tab first' }, { status: 400 })
        }
        const rawToken = (config.accessToken as string) || (config.oauthUserAccessToken as string)
        if (!rawToken) return Response.json({ error: 'Not connected' }, { status: 400 })
        const token = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        const result = await graphGet<{ data?: Array<{ id: string; name: string }> }>(`/${businessManagerId}/owned_pixels`, {
            fields: 'id,name',
            access_token: token,
            limit: '100',
        })
        if (!result.ok) return Response.json({ error: result.error }, { status: 502 })

        return Response.json({ pixels: result.data?.data ?? [] })
    },
}

// ── POST /meta-oauth/pixels { configId, name } ──────────────────────────────
export const metaOAuthCreatePixelEndpoint: Endpoint = {
    path: '/meta-oauth/pixels',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })

        const body = (await req.json?.()) as { configId?: string; name?: string } | undefined
        const configId = body?.configId
        const name = body?.name
        if (!configId || !name) return Response.json({ error: 'Missing configId or name' }, { status: 400 })

        const config = await loadConfig(req.payload, configId)
        const businessManagerId = config.businessManagerId as string | undefined
        if (!businessManagerId) {
            return Response.json({ error: 'Set a Business Manager ID on the Connection tab first' }, { status: 400 })
        }
        const rawToken = (config.accessToken as string) || (config.oauthUserAccessToken as string)
        if (!rawToken) return Response.json({ error: 'Not connected' }, { status: 400 })
        const token = rawToken.startsWith('enc:') ? decryptCredential(rawToken) : rawToken

        const result = await graphPost<{ id?: string }>(`/${businessManagerId}/adspixels`, {
            name,
            access_token: token,
        })
        if (!result.ok || !result.data?.id) {
            return Response.json({ error: result.error || 'Pixel creation failed' }, { status: 502 })
        }

        await req.payload.update({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: configId,
            data: { pixelId: result.data.id, pixelEnabled: true } as any,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.json({ ok: true, pixelId: result.data.id })
    },
}
