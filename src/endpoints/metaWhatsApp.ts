import type { Endpoint } from 'payload'
import { graphGet } from '../utils/metaGraphClient'
import { callerOwnsConfigSite, asCollectionSlug, getUserWithRole } from '../types'
import { listBusinesses } from '../utils/metaBusinesses'
import { tokenForCatalog } from '../sync/catalogSync'
import type { AlertSummary } from '../whatsapp/alertTemplates'
import { ensureAlertTemplates, readAlertTemplates } from '../whatsapp/fileAlertTemplates'

export interface WhatsAppNumberOption {
    id: string
    displayPhone: string
    verifiedName: string
    wabaId: string
    wabaName: string
}

interface GraphPhone {
    id?: string
    display_phone_number?: string
    verified_name?: string
}

export function phonesFromWaba(
    waba: { id: string; name?: string },
    phones: GraphPhone[],
): WhatsAppNumberOption[] {
    const options: WhatsAppNumberOption[] = []
    for (const phone of phones) {
        if (!phone.id) continue
        options.push({
            id: phone.id,
            displayPhone: phone.display_phone_number || phone.id,
            verifiedName: phone.verified_name || '',
            wabaId: waba.id,
            wabaName: waba.name || waba.id,
        })
    }
    return options
}

function isAdminOrAbove(req: { user?: unknown }): boolean {
    const role = getUserWithRole(req.user)?.role
    return role === 'super-admin' || role === 'admin' || role === 'editor'
}

async function loadConfig(req: Parameters<Endpoint['handler']>[0], configId: string) {
    return (await req.payload.findByID({
        collection: asCollectionSlug('meta-config'),
        id: configId,
        depth: 0,
        overrideAccess: true,
        context: { preventMasking: true },
    })) as Record<string, unknown>
}

async function numbersForToken(
    token: string,
    businessManagerId: unknown,
): Promise<{ ok: true; numbers: WhatsAppNumberOption[] } | { ok: false; error: string }> {
    const businesses = await listBusinesses(token, businessManagerId)
    if (!businesses.ok) return businesses

    const numbers: WhatsAppNumberOption[] = []
    const seen = new Set<string>()
    for (const business of businesses.businesses) {
        for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts'] as const) {
            const accounts = await graphGet<{ data?: Array<{ id: string; name?: string }> }>(
                `/${business.id}/${edge}`,
                { fields: 'id,name', access_token: token, limit: '25' },
            )
            if (!accounts.ok) continue
            for (const waba of accounts.data?.data ?? []) {
                const phones = await graphGet<{ data?: GraphPhone[] }>(`/${waba.id}/phone_numbers`, {
                    fields: 'id,display_phone_number,verified_name',
                    access_token: token,
                    limit: '25',
                })
                if (!phones.ok) continue
                for (const option of phonesFromWaba(waba, phones.data?.data ?? [])) {
                    if (seen.has(option.id)) continue
                    seen.add(option.id)
                    numbers.push(option)
                }
            }
        }
    }
    return { ok: true, numbers }
}

// ── GET /meta-whatsapp/numbers?configId= ────────────────────────────────────
export const metaWhatsAppNumbersEndpoint: Endpoint = {
    path: '/meta-whatsapp/numbers',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook before choosing a WhatsApp number.' }, { status: 400 })
        const listed = await numbersForToken(token, config.businessManagerId)
        if (!listed.ok) return Response.json({ error: listed.error }, { status: 502 })
        return Response.json({ numbers: listed.numbers })
    },
}

// ── POST /meta-whatsapp/select { configId, phoneNumberId } ──────────────────
export const metaWhatsAppSelectEndpoint: Endpoint = {
    path: '/meta-whatsapp/select',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; phoneNumberId?: string } | undefined
        if (!body?.configId || !body.phoneNumberId) {
            return Response.json({ error: 'Missing configId or phoneNumberId' }, { status: 400 })
        }
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const token = tokenForCatalog(config)
        if (!token) return Response.json({ error: 'Connect this site with Facebook first.' }, { status: 400 })

        const listed = await numbersForToken(token, config.businessManagerId)
        if (!listed.ok) return Response.json({ error: listed.error }, { status: 502 })
        const chosen = listed.numbers.find((number) => number.id === body.phoneNumberId)
        if (!chosen) {
            return Response.json({ error: 'That WhatsApp number is not on this Facebook login.' }, { status: 404 })
        }

        const previousPhone = typeof config.whatsappPhoneNumberId === 'string' ? config.whatsappPhoneNumberId : ''
        await req.payload.update({
            collection: asCollectionSlug('meta-config'),
            id: body.configId,
            data: {
                whatsappEnabled: true,
                whatsappPhoneNumberId: chosen.id,
                whatsappBusinessAccountId: chosen.wabaId,
                // A different number has its own Meta review. The owner is told again once that one is approved.
                ...(previousPhone !== chosen.id ? { whatsappAlertsAnnouncedAt: null } : {}),
            },
            overrideAccess: true,
            context: { skipConnectionTest: true },
        })
        const alerts = await fileAlertsQuietly(req, token, chosen.wabaId)
        return Response.json({
            ok: true,
            phoneNumberId: chosen.id,
            displayPhone: chosen.displayPhone,
            wabaId: chosen.wabaId,
            alerts,
        })
    },
}

const savedNumberSummary: AlertSummary = {
    state: 'needs_attention',
    headline: 'WhatsApp alerts need another try',
    detail: 'The number is saved. Try again when you are ready.',
}

async function fileAlertsQuietly(
    req: Parameters<Endpoint['handler']>[0],
    token: string,
    wabaId: string,
    retry = false,
): Promise<AlertSummary> {
    try {
        return await ensureAlertTemplates(token, wabaId, { replaceRejected: retry })
    } catch (err) {
        req.payload.logger.warn(`[MetaWhatsApp] template filing failed: ${err}`)
        return savedNumberSummary
    }
}

function wabaIdFrom(config: Record<string, unknown>): string {
    return typeof config.whatsappBusinessAccountId === 'string' ? config.whatsappBusinessAccountId.trim() : ''
}

// ── GET /meta-whatsapp/templates?configId= ──────────────────────────────────
export const metaWhatsAppTemplatesEndpoint: Endpoint = {
    path: '/meta-whatsapp/templates',
    method: 'get',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const configId = req.query?.configId as string | undefined
        if (!configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const wabaId = wabaIdFrom(config)
        if (!wabaId) {
            return Response.json({
                state: 'setting_up',
                headline: 'Preparing WhatsApp alerts',
                detail: 'Choose a WhatsApp number first. You do not paste any codes.',
            })
        }
        const token = tokenForCatalog(config)
        if (!token) {
            return Response.json({
                state: 'needs_attention',
                headline: 'WhatsApp alerts need another try',
                detail: 'Reconnect with Facebook so WhatsApp alerts can be prepared. The number you chose is already saved.',
            })
        }
        try {
            return Response.json(await readAlertTemplates(token, wabaId))
        } catch (err) {
            req.payload.logger.warn(`[MetaWhatsApp] template status failed: ${err}`)
            return Response.json(savedNumberSummary)
        }
    },
}

// ── POST /meta-whatsapp/templates { configId, retry? } ──────────────────────
export const metaWhatsAppTemplatesFileEndpoint: Endpoint = {
    path: '/meta-whatsapp/templates',
    method: 'post',
    handler: async (req) => {
        if (!isAdminOrAbove(req)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const body = (await req.json?.()) as { configId?: string; retry?: boolean } | undefined
        if (!body?.configId) return Response.json({ error: 'Missing configId' }, { status: 400 })
        const config = await loadConfig(req, body.configId)
        if (!callerOwnsConfigSite(req, config)) return Response.json({ error: 'Forbidden' }, { status: 403 })
        const wabaId = wabaIdFrom(config)
        const token = tokenForCatalog(config)
        if (!wabaId || !token) return Response.json(savedNumberSummary)
        return Response.json(await fileAlertsQuietly(req, token, wabaId, body.retry === true))
    },
}
