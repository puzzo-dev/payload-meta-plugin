import { tokenForCatalog } from '../sync/catalogSync'
import { graphDelete, graphGet, graphPostJson } from '../utils/metaGraphClient'
import {
    ALERT_LANGUAGE,
    ALERT_TEMPLATES,
    type AlertSummary,
    type ListedTemplate,
    isTemplateAlreadyFiled,
    plainTemplateFailure,
    summarizeAlertTemplates,
} from './alertTemplates'

interface TemplateList {
    data?: ListedTemplate[]
}

const REPLACEABLE = new Set(['REJECTED', 'PAUSED', 'DISABLED'])

function graphId(value: string): boolean {
    return /^[0-9]+$/.test(value)
}

async function listNamed(token: string, wabaId: string, name: string) {
    return graphGet<TemplateList>(`/${wabaId}/message_templates`, {
        name,
        fields: 'id,name,status,rejected_reason,language',
        access_token: token,
        limit: '10',
    })
}

function preferLanguage(rows: ListedTemplate[] | undefined, name: string): ListedTemplate | undefined {
    return (rows ?? []).find((row) => row.name === name && (!row.language || row.language === ALERT_LANGUAGE))
}

/**
 * File each alert template if this WhatsApp account does not already have it.
 * A number selection must still succeed when this fails; callers catch and
 * show the calm summary instead of an error page.
 */
export async function ensureAlertTemplates(
    token: string,
    wabaId: string,
    options?: { replaceRejected?: boolean },
): Promise<AlertSummary> {
    if (!graphId(wabaId)) {
        return {
            state: 'needs_attention',
            headline: 'WhatsApp alerts need another try',
            detail: 'The number is saved. Try again when you are ready.',
        }
    }

    const found: ListedTemplate[] = []
    let failure: string | null = null

    for (const definition of ALERT_TEMPLATES) {
        const listed = await listNamed(token, wabaId, definition.metaName)
        if (!listed.ok) {
            return {
                state: 'needs_attention',
                headline: 'WhatsApp alerts need another try',
                detail: plainTemplateFailure(listed.error || ''),
            }
        }

        let row = preferLanguage(listed.data?.data, definition.metaName)
        const status = (row?.status || '').toUpperCase()
        if (options?.replaceRejected && row?.id && REPLACEABLE.has(status) && graphId(row.id)) {
            await graphDelete(`/${row.id}`, token)
            row = undefined
        }

        if (!row) {
            const created = await graphPostJson(`/${wabaId}/message_templates`, {
                name: definition.metaName,
                language: ALERT_LANGUAGE,
                category: 'UTILITY',
                components: [
                    {
                        type: 'BODY',
                        text: definition.body,
                        example: { body_text: [definition.example] },
                    },
                ],
            }, token)
            if (!created.ok && !isTemplateAlreadyFiled(created.error || '')) {
                failure = plainTemplateFailure(created.error || '')
            }
            const again = await listNamed(token, wabaId, definition.metaName)
            if (again.ok) row = preferLanguage(again.data?.data, definition.metaName) ?? row
        }

        if (row) found.push(row)
    }

    const summary = summarizeAlertTemplates(found)
    if (summary.state === 'ready' || summary.state === 'reviewing') return summary
    return {
        state: 'needs_attention',
        headline: 'WhatsApp alerts need another try',
        detail: failure || 'The number is saved. Try again when you are ready.',
    }
}

function wabaIdOf(config: Record<string, unknown>): string {
    return typeof config.whatsappBusinessAccountId === 'string' ? config.whatsappBusinessAccountId.trim() : ''
}

/** Status for a saved Meta connection. Null when the login or WhatsApp account is missing. */
export async function alertStatusForConfig(config: Record<string, unknown>): Promise<AlertSummary | null> {
    const token = tokenForCatalog(config)
    const wabaId = wabaIdOf(config)
    if (!token || !wabaId) return null
    return readAlertTemplates(token, wabaId)
}

/**
 * File any alert message this account does not have yet.
 * Rejected messages are left for the owner to retry from the connect screen.
 */
export async function fileMissingAlertTemplates(config: Record<string, unknown>): Promise<AlertSummary | null> {
    const token = tokenForCatalog(config)
    const wabaId = wabaIdOf(config)
    if (!token || !wabaId) return null
    return ensureAlertTemplates(token, wabaId)
}

export async function readAlertTemplates(token: string, wabaId: string): Promise<AlertSummary> {
    if (!graphId(wabaId)) {
        return {
            state: 'setting_up',
            headline: 'Preparing WhatsApp alerts',
            detail: 'Choose a WhatsApp number first. You do not paste any codes.',
        }
    }

    const found: ListedTemplate[] = []
    for (const definition of ALERT_TEMPLATES) {
        const listed = await listNamed(token, wabaId, definition.metaName)
        if (!listed.ok) {
            return {
                state: 'needs_attention',
                headline: 'WhatsApp alerts need another try',
                detail: plainTemplateFailure(listed.error || ''),
            }
        }
        const row = preferLanguage(listed.data?.data, definition.metaName)
        if (row) found.push(row)
    }
    return summarizeAlertTemplates(found)
}
