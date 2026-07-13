import type { Endpoint, CollectionSlug } from 'payload'
import { encryptCredential, decryptCredential, signOAuthState, verifyOAuthState } from '../utils/metaCrypto'
import { threadsGet, threadsPost } from '../utils/metaGraphClient'
import type { UserWithRole } from '../types'

/**
 * Threads connect flow. Threads API is a genuinely separate product from the
 * main Facebook/Instagram Graph API — its own authorize host (threads.net,
 * not facebook.com), its own token host (graph.threads.net, not
 * graph.facebook.com), and its own token/profile shape — even though it's
 * configured as a product on the same Meta App (same App ID/Secret as the
 * Facebook/Instagram connection reuses).
 *
 * Same caveat as metaOAuth.ts: implemented per Meta's documented Threads API
 * contract, not live-tested against a real Threads App — verify with a
 * manual test connect before relying on this in production.
 */

const THREADS_SCOPES = 'threads_basic,threads_content_publish'

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = (req.user as unknown as UserWithRole | undefined)?.role
    return role === 'super-admin' || role === 'admin'
}

function serverUrl(): string {
    return (process.env.PAYLOAD_PUBLIC_SERVER_URL || '').replace(/\/+$/, '')
}

function callbackRedirectUri(): string {
    return `${serverUrl()}/api/threads-oauth/callback`
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

// ── GET /threads-oauth/start?configId=<id> ─────────────────────────────────
export const threadsOAuthStartEndpoint: Endpoint = {
    path: '/threads-oauth/start',
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
            return Response.json({ error: 'Set a Meta App ID on the Connection tab before connecting Threads.' }, { status: 400 })
        }

        const state = signOAuthState(configId)
        const params = new URLSearchParams({
            client_id: appId,
            redirect_uri: callbackRedirectUri(),
            state,
            scope: THREADS_SCOPES,
            response_type: 'code',
        })

        return Response.redirect(`https://threads.net/oauth/authorize?${params}`, 302)
    },
}

// ── GET /threads-oauth/callback?code=&state= ────────────────────────────────
export const threadsOAuthCallbackEndpoint: Endpoint = {
    path: '/threads-oauth/callback',
    method: 'get',
    handler: async (req) => {
        const code = req.query?.code as string | undefined
        const state = req.query?.state as string | undefined
        const oauthError = req.query?.error_description as string | undefined

        const adminBase = `${serverUrl()}/admin/collections/meta-config`

        if (oauthError) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent(oauthError)}`, 302)
        }
        if (!code || !state) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Missing code or state')}`, 302)
        }

        const configId = verifyOAuthState(state)
        if (!configId) {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Invalid or expired connect request — try again')}`, 302)
        }

        let config: Record<string, unknown>
        try {
            config = await loadConfig(req.payload, configId)
        } catch {
            return Response.redirect(`${adminBase}?threads_oauth_error=${encodeURIComponent('Config not found')}`, 302)
        }

        const appId = config.appId as string | undefined
        const rawAppSecret = config.appSecret as string | undefined
        const appSecret = rawAppSecret?.startsWith('enc:') ? decryptCredential(rawAppSecret) : rawAppSecret
        if (!appId || !appSecret) {
            return Response.redirect(`${adminBase}/${configId}?threads_oauth_error=${encodeURIComponent('App ID/Secret not configured')}`, 302)
        }

        // Step 1: code -> short-lived Threads user token
        const shortLived = await threadsPost<{ access_token?: string; user_id?: string }>('/oauth/access_token', {
            client_id: appId,
            client_secret: appSecret,
            grant_type: 'authorization_code',
            redirect_uri: callbackRedirectUri(),
            code,
        })
        if (!shortLived.ok || !shortLived.data?.access_token) {
            return Response.redirect(`${adminBase}/${configId}?threads_oauth_error=${encodeURIComponent(shortLived.error || 'Token exchange failed')}`, 302)
        }

        // Step 2: short-lived -> long-lived Threads token (~60 days)
        const longLived = await threadsGet<{ access_token?: string }>('/access_token', {
            grant_type: 'th_exchange_token',
            client_secret: appSecret,
            access_token: shortLived.data.access_token,
        })
        const finalToken = longLived.ok && longLived.data?.access_token ? longLived.data.access_token : shortLived.data.access_token

        // Step 3: fetch profile (id, username)
        const profile = await threadsGet<{ id?: string; username?: string }>('/v1.0/me', {
            fields: 'id,username',
            access_token: finalToken,
        })

        await req.payload.update({
            collection: 'meta-config' as unknown as CollectionSlug,
            id: configId,
            data: {
                threadsEnabled: true,
                threadsAccessToken: encryptCredential(finalToken),
                threadsUserId: profile.data?.id || null,
                threadsUsername: profile.data?.username || null,
            } as any,
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })

        return Response.redirect(`${adminBase}/${configId}?threads_oauth_success=1`, 302)
    },
}
