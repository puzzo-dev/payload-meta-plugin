import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
    ALERT_TEMPLATES,
    explainTemplateSendError,
    guestBodyParameters,
    ownerBodyParameters,
    plainTemplateFailure,
    summarizeAlertTemplates,
    variableSlots,
    whatsappTemplateMessage,
} from './alertTemplates.js'

const enquiry = {
    doc: {
        values: {
            first_name: 'Ada',
            last_name: 'Okonkwo',
            event_type: 'Wedding',
            event_date: '12 Oct 2026',
            event_time: '4:00 PM',
            event_location: 'Victoria Island',
            guest_count: '80',
            whatsapp_number: '+2348000000000',
            email: 'ada@example.com',
            special_requirements: 'Outdoor bar',
        },
    },
    quotation_name: 'QTN-0001',
}

describe('alert template copy', () => {
    it('keeps every body free of a leading or trailing variable and adjacent variables', () => {
        for (const template of ALERT_TEMPLATES) {
            const body = template.body.trim()
            assert.equal(body.startsWith('{{'), false, template.metaName)
            assert.equal(/\{\{\d+\}\}\s*$/.test(body), false, template.metaName)
            assert.equal(/\{\{\d+\}\}\s*\{\{\d+\}\}/.test(body), false, template.metaName)
            assert.equal(template.example.length, variableSlots(body))
            assert.equal(template.parameters({}).length, variableSlots(body))
        }
    })
})

describe('summarizeAlertTemplates', () => {
    it('is ready only when every message is approved', () => {
        const summary = summarizeAlertTemplates(
            ALERT_TEMPLATES.map((template) => ({ name: template.metaName, status: 'APPROVED', language: 'en' })),
        )
        assert.equal(summary.state, 'ready')
        assert.equal(summary.items, undefined)
    })

    it('stays on review while any message is still pending', () => {
        const summary = summarizeAlertTemplates(
            ALERT_TEMPLATES.map((template, index) => ({
                name: template.metaName,
                status: index === ALERT_TEMPLATES.length - 1 ? 'PENDING' : 'APPROVED',
                language: 'en',
            })),
        )
        assert.equal(summary.state, 'reviewing')
        assert.match(summary.detail, /leave this page/i)
    })

    it('asks for one retry when Meta rejects a message, without showing the raw reason', () => {
        const summary = summarizeAlertTemplates(
            ALERT_TEMPLATES.map((template, index) => ({
                name: template.metaName,
                status: index === ALERT_TEMPLATES.length - 1 ? 'REJECTED' : 'APPROVED',
                language: 'en',
                rejected_reason: 'INVALID_FORMAT',
            })),
        )
        assert.equal(summary.state, 'needs_attention')
        assert.equal(summary.headline, 'One alert message needs another try')
        assert.equal(summary.items?.length, 1)
        assert.equal(summary.items?.[0].label, 'The note that alerts are ready')
        assert.equal(JSON.stringify(summary).includes('INVALID_FORMAT'), false)
        assert.equal(JSON.stringify(summary).includes('ops_enquiry'), false)
    })

    it('does not treat another language as ready, because sends use English', () => {
        const summary = summarizeAlertTemplates(
            ALERT_TEMPLATES.map((template) => ({ name: template.metaName, status: 'APPROVED', language: 'en_US' })),
        )
        assert.equal(summary.state, 'setting_up')
    })

    it('treats a missing message as still being prepared', () => {
        const summary = summarizeAlertTemplates([
            { name: 'ops_enquiry_guest', status: 'PENDING', language: 'en' },
        ])
        assert.equal(summary.state, 'setting_up')
    })
})

describe('template parameters', () => {
    it('fills the guest and owner messages from the enquiry', () => {
        assert.deepEqual(guestBodyParameters(enquiry), [
            'Ada',
            'Wedding',
            '12 Oct 2026 at 4:00 PM',
            'Victoria Island',
            'QTN-0001',
        ])
        assert.deepEqual(ownerBodyParameters(enquiry), [
            'Ada Okonkwo',
            'Wedding',
            '12 Oct 2026 at 4:00 PM',
            '80',
            'Victoria Island',
            '+2348000000000 · ada@example.com',
            'Outdoor bar',
            'QTN-0001',
        ])
    })

    it('substitutes calm fallbacks and strips line breaks', () => {
        const guest = guestBodyParameters({
            doc: { values: { first_name: 'Ada\n\nBello', special_requirements: 'ignored' } },
        })
        assert.equal(guest[0], 'Ada Bello')
        assert.equal(guest.includes(''), false)
        const owner = ownerBodyParameters({})
        assert.equal(owner[0], 'A guest')
        assert.equal(owner[6], 'None')
    })

    it('maps only the two enquiry notifications onto a template send', () => {
        const message = whatsappTemplateMessage('new_booking_owner_alert', enquiry)
        assert.equal(message?.name, 'ops_enquiry_owner')
        assert.equal(message?.languageCode, 'en')
        assert.equal(message?.bodyParameters[0], 'Ada Okonkwo')
        assert.equal(whatsappTemplateMessage('customer_signup_verification', {}), null)
        assert.deepEqual(
            whatsappTemplateMessage('whatsapp_alerts_ready', { siteName: 'Avril Beetails' })?.bodyParameters,
            ['Avril Beetails'],
        )
    })
})

describe('owner-facing errors', () => {
    it('does not repeat a Graph permission error', () => {
        const sentence = plainTemplateFailure('(#200) Requires whatsapp_business_management permission')
        assert.match(sentence, /Reconnect with Facebook/)
        assert.equal(sentence.includes('#200'), false)
        assert.equal(sentence.includes('whatsapp_business_management'), false)
    })

    it('queues a send that is waiting on Meta review and hides the response body', () => {
        const explained = explainTemplateSendError('(#132001) Template name does not exist in the translation')
        assert.equal(explained?.retryable, true)
        assert.match(explained?.error ?? '', /still with Meta for review/)
        assert.equal(explained?.error.includes('132001'), false)
    })

    it('leaves unrelated send failures to the caller', () => {
        assert.equal(explainTemplateSendError('Invalid OAuth access token'), null)
    })
})
