import type { MetaCredentials, LogFn } from '../types'

export interface ConversionEventUserData {
    /** SHA-256 hashed by the caller before this reaches here — never send raw PII to Meta. */
    emailHash?: string
    phoneHash?: string
    clientIpAddress?: string
    clientUserAgent?: string
}

export interface ConversionEventInput {
    /** Standard Meta event name — e.g. "Lead", "Purchase", "AddToCart", "CompleteRegistration". */
    eventName: string
    /** Unix seconds. Defaults to now if omitted. */
    eventTime?: number
    /** Dedup key — set the same value on a client Pixel event and this CAPI event to avoid double-counting. Optional: this plugin fires CAPI-only by design (no client fbq() calls), so most callers can omit it. */
    eventId?: string
    eventSourceUrl?: string
    userData?: ConversionEventUserData
    customData?: Record<string, unknown>
    actionSource?: 'website' | 'system_generated' | 'other'
}

export interface ConversionEventResult {
    ok: boolean
    status?: number
    error?: string
    eventsReceived?: number
}

/**
 * Send a single event to Meta's Conversions API.
 * https://graph.facebook.com/v21.0/{pixel_id}/events
 *
 * Requires creds.pixelId and creds.accessToken — callers should check both
 * are present (via getMetaCredentials, which only returns pixelId when the
 * site's meta-config has pixelEnabled: true) before calling this.
 */
export async function sendConversionEvent(
    creds: MetaCredentials,
    input: ConversionEventInput,
    log?: LogFn,
): Promise<ConversionEventResult> {
    if (!creds.pixelId) {
        return { ok: false, error: 'Meta Pixel not enabled/configured for this site' }
    }
    if (!creds.accessToken) {
        return { ok: false, error: 'Meta access token not configured for this site' }
    }

    const event: Record<string, unknown> = {
        event_name: input.eventName,
        event_time: input.eventTime ?? Math.floor(Date.now() / 1000),
        action_source: input.actionSource ?? 'website',
    }
    if (input.eventId) event.event_id = input.eventId
    if (input.eventSourceUrl) event.event_source_url = input.eventSourceUrl
    if (input.customData) event.custom_data = input.customData

    const userData: Record<string, unknown> = {}
    if (input.userData?.emailHash) userData.em = [input.userData.emailHash]
    if (input.userData?.phoneHash) userData.ph = [input.userData.phoneHash]
    if (input.userData?.clientIpAddress) userData.client_ip_address = input.userData.clientIpAddress
    if (input.userData?.clientUserAgent) userData.client_user_agent = input.userData.clientUserAgent
    if (Object.keys(userData).length > 0) event.user_data = userData

    try {
        const res = await fetch(
            `https://graph.facebook.com/v21.0/${creds.pixelId}/events`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    data: [event],
                    access_token: creds.accessToken,
                }),
                signal: AbortSignal.timeout(15000),
            },
        )

        const body = await res.json().catch(() => ({})) as { events_received?: number; error?: { message?: string } }

        if (!res.ok) {
            const msg = body?.error?.message || `Meta CAPI error: ${res.status}`
            log?.('warn', `[MetaConversionsApi] ${input.eventName} failed: ${msg}`)
            return { ok: false, status: res.status, error: msg }
        }

        log?.('info', `[MetaConversionsApi] Sent ${input.eventName} to pixel ${creds.pixelId}`)
        return { ok: true, status: res.status, eventsReceived: body.events_received }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log?.('error', `[MetaConversionsApi] ${input.eventName} network error: ${msg}`)
        return { ok: false, error: msg }
    }
}
