import { getMetaCredentials } from '../utils/metaCredentials'
import { sendConversionEvent } from '../sync/conversionsApi'

// ── Shared value resolution ─────────────────────────────────────────────────
// {{key}} / {{nested.path}} substitution into a workflow's context object.
function dottedPathLookup(ctx: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((o, k) => (o === undefined || o === null ? undefined : (o as Record<string, unknown>)[k]), ctx)
}

function resolveValue(template: string, ctx: Record<string, unknown>): unknown {
    const wholeMatch = template.trim().match(/^\{\{\s*([\w.]+)\s*\}\}$/)
    if (wholeMatch) {
        const val = dottedPathLookup(ctx, wholeMatch[1])
        return val !== undefined ? val : template
    }
    if (template.includes('{{')) {
        return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
            const val = dottedPathLookup(ctx, key)
            return val !== undefined && val !== null ? String(val) : ''
        })
    }
    return template
}

// ── meta-conversion-event ───────────────────────────────────────────────────
// Fires a server-side Meta Conversions API event. Used by a "Trigger Meta
// Conversion Event" step in a host CMS's Workflows/automation builder (see
// index.ts, which injects the `trigger_meta_conversion` block into the
// `workflows` collection's steps field, if one exists).
//
// step.event_name        — Meta standard event name (e.g. "Lead", "Purchase")
// step.value              — numeric value, supports {{var}}
// step.currency           — 3-letter currency code, supports {{var}} (default "USD")
// step.content_name       — supports {{var}}
// step.event_source_url   — supports {{var}}
//
// No event_id / dedup handling — this plugin fires Conversions API only, no
// client-side fbq() calls exist to deduplicate against (see README.md).
export async function metaConversionEventHandler(ctx: any): Promise<any> {
    const { payload, workflowContext, step } = ctx
    const siteSlug = workflowContext.siteSlug as string
    const creds = await getMetaCredentials(payload, siteSlug)
    if (!creds) return { success: false, error: 'Missing Meta credentials for site: ' + siteSlug }
    if (!creds.pixelId) return { success: false, error: `Meta Pixel not enabled for site: ${siteSlug}` }

    const eventName = step.event_name as string
    if (!eventName) return { success: false, error: 'meta-conversion-event requires event_name' }

    const rawValue = step.value ? resolveValue(String(step.value), workflowContext) : undefined
    const numericValue = rawValue !== undefined ? Number(rawValue) : undefined
    const currency = step.currency ? String(resolveValue(String(step.currency), workflowContext)) : 'USD'
    const contentName = step.content_name ? String(resolveValue(String(step.content_name), workflowContext)) : undefined
    const eventSourceUrl = step.event_source_url ? String(resolveValue(String(step.event_source_url), workflowContext)) : undefined

    const customData: Record<string, unknown> = {}
    if (numericValue !== undefined && !Number.isNaN(numericValue)) {
        customData.value = numericValue
        customData.currency = currency
    }
    if (contentName) customData.content_name = contentName

    const result = await sendConversionEvent(
        creds,
        { eventName, eventSourceUrl, customData: Object.keys(customData).length > 0 ? customData : undefined },
        (level, msg) => payload.logger[level](msg),
    )

    if (!result.ok) return { success: false, error: result.error }
    return { success: true, data: { meta_event_sent: eventName, meta_events_received: result.eventsReceived } }
}
