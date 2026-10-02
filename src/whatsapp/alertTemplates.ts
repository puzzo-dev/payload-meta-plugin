/**
 * Utility templates filed on a site's own WhatsApp Business Account.
 *
 * Names are deterministic so status can be read from Graph without a new
 * database column. Meta still reviews them; this module only describes the
 * copy, the send parameters, and the one status the connect screen shows.
 */

export const ALERT_LANGUAGE = 'en'

/** Notification-template key for the one-time "alerts are ready" owner notice. */
export const WHATSAPP_ALERTS_READY_KEY = 'whatsapp_alerts_ready'

export type AlertState = 'ready' | 'reviewing' | 'needs_attention' | 'setting_up'

export interface AlertSummaryItem {
    label: string
    detail: string
}

export interface AlertSummary {
    state: AlertState
    headline: string
    detail: string
    /** Present only when the owner needs to know which message to retry. */
    items?: AlertSummaryItem[]
}

export interface ListedTemplate {
    id?: string
    name?: string
    status?: string
    rejected_reason?: string
    language?: string
}

export interface AlertTemplateDefinition {
    notificationKey: 'booking_received_customer' | 'new_booking_owner_alert' | 'whatsapp_alerts_ready'
    metaName: 'ops_enquiry_guest' | 'ops_enquiry_owner' | 'ops_alerts_ready'
    label: string
    body: string
    example: string[]
    parameters: (variables: Record<string, unknown>) => string[]
}

const GUEST_BODY =
    'Hi {{1}}, we have your enquiry for a {{2}} on {{3}} at {{4}}. Your reference is {{5}}. We will call you within 2 to 4 hours.'

const OWNER_BODY =
    'New enquiry from {{1}}. Event: {{2}}. When: {{3}}. Guests: {{4}}. Location: {{5}}. Reach them at {{6}}. Notes: {{7}}. Reference {{8}}. Call them within 2 to 4 hours. You do not need to open the quotation to read this.'

const READY_BODY =
    'WhatsApp alerts for {{1}} are ready. New enquiries will reach you on this number.'

export const ALERT_TEMPLATES: AlertTemplateDefinition[] = [
    {
        notificationKey: 'booking_received_customer',
        metaName: 'ops_enquiry_guest',
        label: 'The message to the guest',
        body: GUEST_BODY,
        example: ['Ada', 'Wedding', '12 Oct 2026 at 4:00 PM', 'Victoria Island, Lagos', 'QTN-0001'],
        parameters: guestBodyParameters,
    },
    {
        notificationKey: 'new_booking_owner_alert',
        metaName: 'ops_enquiry_owner',
        label: 'The message to you',
        body: OWNER_BODY,
        example: [
            'Ada Okonkwo',
            'Wedding',
            '12 Oct 2026 at 4:00 PM',
            '80',
            'Victoria Island, Lagos',
            '+2348000000000 · ada@example.com',
            'None',
            'QTN-0001',
        ],
        parameters: ownerBodyParameters,
    },
    {
        notificationKey: WHATSAPP_ALERTS_READY_KEY,
        metaName: 'ops_alerts_ready',
        label: 'The note that alerts are ready',
        body: READY_BODY,
        example: ['Avril Beetails'],
        parameters: readyBodyParameters,
    },
]

export interface WhatsAppTemplateMessage {
    name: string
    languageCode: string
    bodyParameters: string[]
}

export function whatsappTemplateMessage(
    templateKey: string,
    variables: Record<string, unknown>,
): WhatsAppTemplateMessage | null {
    const definition = ALERT_TEMPLATES.find((template) => template.notificationKey === templateKey)
    if (!definition) return null
    return {
        name: definition.metaName,
        languageCode: ALERT_LANGUAGE,
        bodyParameters: definition.parameters(variables),
    }
}

export function cleanParameter(value: unknown): string {
    const raw = value == null ? '' : String(value)
    return raw.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 200)
}

export function templateParameter(value: unknown, fallback: string): string {
    return cleanParameter(value) || fallback
}

function readPath(source: Record<string, unknown>, path: string): unknown {
    return path.split('.').reduce<unknown>((current, key) => {
        if (current == null || typeof current !== 'object') return undefined
        return (current as Record<string, unknown>)[key]
    }, source)
}

function whenLine(variables: Record<string, unknown>): string {
    const date = cleanParameter(readPath(variables, 'doc.values.event_date'))
    const time = cleanParameter(readPath(variables, 'doc.values.event_time'))
    if (date && time) return `${date} at ${time}`.slice(0, 200)
    return date || time || 'a date to confirm'
}

export function guestBodyParameters(variables: Record<string, unknown>): string[] {
    return [
        templateParameter(readPath(variables, 'doc.values.first_name'), 'there'),
        templateParameter(readPath(variables, 'doc.values.event_type'), 'celebration'),
        whenLine(variables),
        templateParameter(readPath(variables, 'doc.values.event_location'), 'a location to confirm'),
        templateParameter(readPath(variables, 'quotation_name'), 'pending'),
    ]
}

export function readyBodyParameters(variables: Record<string, unknown>): string[] {
    return [templateParameter(readPath(variables, 'siteName'), 'your business')]
}

export function ownerBodyParameters(variables: Record<string, unknown>): string[] {
    const first = cleanParameter(readPath(variables, 'doc.values.first_name'))
    const last = cleanParameter(readPath(variables, 'doc.values.last_name'))
    const phone = cleanParameter(readPath(variables, 'doc.values.whatsapp_number'))
    const email = cleanParameter(readPath(variables, 'doc.values.email'))
    return [
        [first, last].filter(Boolean).join(' ') || 'A guest',
        templateParameter(readPath(variables, 'doc.values.event_type'), 'Not given'),
        whenLine(variables),
        templateParameter(readPath(variables, 'doc.values.guest_count'), 'Not given'),
        templateParameter(readPath(variables, 'doc.values.event_location'), 'Not given'),
        [phone, email].filter(Boolean).join(' · ') || 'Not given',
        templateParameter(readPath(variables, 'doc.values.special_requirements'), 'None'),
        templateParameter(readPath(variables, 'quotation_name'), 'pending'),
    ]
}

const ATTENTION_STATUSES = new Set(['REJECTED', 'PAUSED', 'DISABLED'])
const REVIEW_STATUSES = new Set(['PENDING', 'IN_APPEAL', 'PENDING_DELETION'])

function pickTemplate(listed: ListedTemplate[], name: string): ListedTemplate | undefined {
    return listed.find((row) => row.name === name && (!row.language || row.language === ALERT_LANGUAGE))
}

function attentionDetail(status: string, label: string): string {
    const readable = label.toLowerCase()
    if (status === 'PAUSED' || status === 'DISABLED') {
        return `Meta has paused ${readable}. Trying again sends a fresh copy.`
    }
    return `Meta did not accept ${readable}. Trying again sends a fresh copy.`
}

export function summarizeAlertTemplates(listed: ListedTemplate[]): AlertSummary {
    const rows = ALERT_TEMPLATES.map((definition) => {
        const row = pickTemplate(listed, definition.metaName)
        const status = (row?.status || '').toUpperCase()
        return { definition, row, status }
    })

    const attention = rows.filter((entry) => ATTENTION_STATUSES.has(entry.status))
    if (attention.length > 0) {
        return {
            state: 'needs_attention',
            headline: attention.length === 1
                ? 'One alert message needs another try'
                : 'The alert messages need another try',
            detail: 'Your WhatsApp number is saved. Nothing else on this page has to change.',
            items: attention.map((entry) => ({
                label: entry.definition.label,
                detail: attentionDetail(entry.status, entry.definition.label),
            })),
        }
    }

    if (rows.some((entry) => entry.status !== 'APPROVED' && !REVIEW_STATUSES.has(entry.status))) {
        return {
            state: 'setting_up',
            headline: 'Preparing WhatsApp alerts',
            detail: 'This takes a moment. You do not need to open WhatsApp.',
        }
    }

    if (rows.every((entry) => entry.status === 'APPROVED')) {
        return {
            state: 'ready',
            headline: 'WhatsApp alerts are ready',
            detail: 'Guests and you will receive them from this number. You can leave this page.',
        }
    }

    return {
        state: 'reviewing',
        headline: 'Meta is reviewing the alert messages',
        detail: 'You can leave this page. This usually finishes within a few minutes, and the alerts start on their own.',
    }
}

/** Owner-facing sentence. The Graph error stays in the server log. */
export function plainTemplateFailure(graphError: string): string {
    if (/permission|oauth|whatsapp_business_management|#200/i.test(graphError)) {
        return 'Reconnect with Facebook so WhatsApp alerts can be prepared. The number you chose is already saved.'
    }
    if (/rate limit|too many calls|request limit/i.test(graphError)) {
        return 'Meta is busy right now. You can leave this page and check again in a few minutes.'
    }
    return 'WhatsApp alerts could not be prepared just now. The number is saved. Try again when you are ready.'
}

export function isTemplateAlreadyFiled(graphError: string): boolean {
    return /already exists|duplicate/i.test(graphError)
}

/**
 * Cloud API send failures that are about the filed template.
 * Returns null when the failure is something else, so the caller keeps its own wording.
 * Waiting on Meta is retryable: the message stays queued and goes out after approval.
 */
export function explainTemplateSendError(body: string): { retryable: boolean; error: string } | null {
    const aboutTemplate = /template/i.test(body) || /132001|132015|132016/.test(body)
    if (!aboutTemplate) return null
    const waiting = /not approved|pending review|is pending|\bpending\b|does not exist|doesn't exist|not exist|paused|disabled|132001|132015|132016/i.test(body)
    if (waiting) {
        return {
            retryable: true,
            error: 'WhatsApp alerts are still with Meta for review. This one will send after they are approved. Email still goes out if this site has email alerts on.',
        }
    }
    return {
        retryable: false,
        error: 'WhatsApp could not send this alert. Email still goes out if this site has email alerts on.',
    }
}

export function variableSlots(body: string): number {
    const nums = [...body.matchAll(/\{\{(\d+)\}\}/g)].map((match) => Number(match[1]))
    return nums.length === 0 ? 0 : Math.max(...nums)
}
