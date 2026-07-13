'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import { FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState, ConnectButton, useOAuthRedirectMessage } from '../shared'

interface DocSnapshot {
    threadsEnabled?: boolean
    threadsUserId?: string
    threadsUsername?: string
    appId?: string
}

/**
 * Custom Field component: "Connect Threads" — its own OAuth flow (separate
 * host/token shape from the Facebook/Instagram connection above, though it
 * reuses the same Meta App ID/Secret — see endpoints/threadsOAuth.ts).
 */
export const ThreadsConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()
    const redirectMsg = useOAuthRedirectMessage('threads_oauth_success', 'threads_oauth_error')

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)

    const loadDoc = useCallback(() => {
        if (!id) return
        setLoadingDoc(true)
        fetch(`/api/meta-config/${id}?depth=0`)
            .then((res) => res.json())
            .then((data) => setDoc(data))
            .catch(() => { /* ignore */ })
            .finally(() => setLoadingDoc(false))
    }, [id])

    useEffect(() => { loadDoc() }, [loadDoc, redirectMsg.success])

    const startConnect = () => {
        if (!id) return
        window.location.href = `/api/threads-oauth/start?configId=${id}`
    }

    if (!id) {
        return (
            <FieldWrapper label="Connect Threads">
                <EmptyState message="Save the document first (with at least a Meta App ID), then Connect Threads will be available." />
            </FieldWrapper>
        )
    }

    const isConnected = Boolean(doc?.threadsUserId)

    return (
        <FieldWrapper label="Connect Threads">
            {redirectMsg.error && <ErrorState message={redirectMsg.error} />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : isConnected ? (
                <>
                    <SuccessState message={`Connected — @${doc?.threadsUsername} (${doc?.threadsUserId})`} />
                    <ConnectButton onClick={startConnect}>Reconnect / Switch Account</ConnectButton>
                </>
            ) : (
                <>
                    {!doc?.appId && (
                        <EmptyState message="Set a Meta App ID on the Connection tab first (Threads must be added as a product on that same Meta App)." />
                    )}
                    <ConnectButton onClick={startConnect} disabled={!doc?.appId}>
                        Connect Threads
                    </ConnectButton>
                </>
            )}
        </FieldWrapper>
    )
}
