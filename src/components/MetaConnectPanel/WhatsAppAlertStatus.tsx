'use client'

import React from 'react'
import { ConnectButton, EmptyState, LoadingState, SuccessState, messageBoxStyle } from '../shared'

export interface WhatsAppAlertCard {
    state: 'ready' | 'reviewing' | 'needs_attention' | 'setting_up'
    headline: string
    detail: string
    items?: Array<{ label: string; detail: string }>
}

const wrapStyle: React.CSSProperties = { marginTop: '0.75rem' }
const quietButton: React.CSSProperties = {
    background: 'none',
    border: 'none',
    padding: 0,
    marginTop: '0.5rem',
    fontSize: '0.8125rem',
    textDecoration: 'underline',
    cursor: 'pointer',
    color: 'inherit',
}

/**
 * One status for both alert messages. Review polls quietly in the parent;
 * this card never lists template names, account ids, or Graph errors.
 */
export const WhatsAppAlertStatus: React.FC<{
    alerts: WhatsAppAlertCard
    busy: boolean
    onRetry: () => void
    onCheck: () => void
}> = ({ alerts, busy, onRetry, onCheck }) => {
    if (alerts.state === 'setting_up') {
        return (
            <div style={wrapStyle}>
                <LoadingState message={`${alerts.headline}. ${alerts.detail}`} />
            </div>
        )
    }

    if (alerts.state === 'ready') {
        return (
            <div style={wrapStyle}>
                <SuccessState message={`${alerts.headline}. ${alerts.detail}`} />
            </div>
        )
    }

    if (alerts.state === 'reviewing') {
        return (
            <div style={wrapStyle}>
                <EmptyState message={`${alerts.headline}. ${alerts.detail}`} />
                <button type="button" style={quietButton} onClick={onCheck} disabled={busy}>
                    Check again
                </button>
            </div>
        )
    }

    return (
        <div style={wrapStyle}>
            <div style={messageBoxStyle('warning')}>
                <div>{alerts.headline}</div>
                <div style={{ marginTop: '0.35rem' }}>{alerts.detail}</div>
                {alerts.items?.map((item) => (
                    <div key={item.label} style={{ marginTop: '0.35rem' }}>{item.detail}</div>
                ))}
            </div>
            <ConnectButton onClick={onRetry} disabled={busy}>Try again</ConnectButton>
        </div>
    )
}
