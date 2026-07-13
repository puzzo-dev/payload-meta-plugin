'use client'

import React, { useCallback, useEffect, useState } from 'react'
import { useDocumentInfo } from '@payloadcms/ui'
import {
    FieldWrapper, LoadingState, EmptyState, ErrorState, SuccessState,
    ConnectButton, StyledSelect, useOAuthRedirectMessage,
    useMetaAppInfo, MetaAppInfoBadge, DetailList,
} from '../shared'

interface DocSnapshot {
    authMethod?: string
    facebookPageId?: string
    facebookPageName?: string
    instagramBusinessAccountId?: string
    instagramUsername?: string
    businessManagerId?: string
}

interface PageOption {
    id: string
    name: string
}

/**
 * Custom Field component: "Connect to Meta Business" — the Facebook Page /
 * Instagram half of the connector flow. Mirrors the official Meta for
 * WordPress plugin's connect UX: authorize once, then pick which Page you
 * manage (Instagram is auto-detected from that Page).
 */
export const MetaConnectPanelField: React.FC = () => {
    const { id } = useDocumentInfo()
    const redirectMsg = useOAuthRedirectMessage('meta_oauth_success', 'meta_oauth_error')
    const appInfo = useMetaAppInfo()

    const [doc, setDoc] = useState<DocSnapshot | null>(null)
    const [loadingDoc, setLoadingDoc] = useState(false)
    const [pages, setPages] = useState<PageOption[] | null>(null)
    const [loadingPages, setLoadingPages] = useState(false)
    const [selectedPageId, setSelectedPageId] = useState('')
    const [saving, setSaving] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

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

    const isConnected = doc?.authMethod === 'oauth'
    const hasPage = Boolean(doc?.facebookPageId)

    const startConnect = () => {
        if (!id) return
        window.location.href = `/api/meta-oauth/start?configId=${id}`
    }

    const loadPages = () => {
        if (!id) return
        setLoadingPages(true)
        setActionError(null)
        fetch(`/api/meta-oauth/pages?configId=${id}`)
            .then((res) => res.json())
            .then((data) => {
                if (data.error) { setActionError(data.error); return }
                setPages(data.pages ?? [])
            })
            .catch(() => setActionError('Failed to load Pages'))
            .finally(() => setLoadingPages(false))
    }

    const selectPage = () => {
        if (!id || !selectedPageId) return
        setSaving(true)
        setActionError(null)
        fetch('/api/meta-oauth/select-page', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: id, pageId: selectedPageId }),
        })
            .then((res) => res.json())
            .then((data) => {
                if (data.error) { setActionError(data.error); return }
                loadDoc()
                setPages(null)
            })
            .catch(() => setActionError('Failed to select Page'))
            .finally(() => setSaving(false))
    }

    if (!id) {
        return (
            <FieldWrapper path="metaConnectPanel" label="Connect to Meta Business">
                <MetaAppInfoBadge appInfo={appInfo} />
                <EmptyState message="Save the document first, then Connect will be available." />
            </FieldWrapper>
        )
    }

    return (
        <FieldWrapper path="metaConnectPanel" label="Connect to Meta Business">
            <MetaAppInfoBadge appInfo={appInfo} />
            {redirectMsg.error && <ErrorState message={redirectMsg.error} />}
            {redirectMsg.success && !isConnected && <SuccessState message="Connected! Fetching your Pages…" />}
            {actionError && <ErrorState message={actionError} />}

            {loadingDoc ? (
                <LoadingState message="Loading connection status…" />
            ) : !isConnected ? (
                <ConnectButton onClick={startConnect} disabled={!appInfo.configured}>
                    Connect to Meta Business
                </ConnectButton>
            ) : hasPage ? (
                <>
                    <SuccessState message="Connected to Meta Business" />
                    <DetailList
                        items={[
                            { label: 'Business Manager ID', value: doc?.businessManagerId || '—' },
                            { label: 'Facebook Page', value: `${doc?.facebookPageName} (${doc?.facebookPageId})` },
                            {
                                label: 'Instagram',
                                value: doc?.instagramUsername
                                    ? `@${doc.instagramUsername} (${doc.instagramBusinessAccountId})`
                                    : 'No Instagram Business account linked to this Page',
                            },
                        ]}
                    />
                    <ConnectButton onClick={loadPages} disabled={loadingPages}>
                        {loadingPages ? 'Loading…' : 'Change Page'}
                    </ConnectButton>
                </>
            ) : (
                <>
                    <EmptyState message="Connected to Meta Business. Now pick which Facebook Page this site should use — its linked Instagram account (if any) will be detected automatically." />
                    {pages === null ? (
                        <ConnectButton onClick={loadPages} disabled={loadingPages}>
                            {loadingPages ? 'Loading Pages…' : 'Load My Pages'}
                        </ConnectButton>
                    ) : pages.length === 0 ? (
                        <EmptyState message="No Pages found for this Meta Business account. Make sure you're an admin on at least one Facebook Page." />
                    ) : (
                        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                            <div style={{ flex: 1 }}>
                                <StyledSelect
                                    path="metaConnectPanel_pageSelect"
                                    value={selectedPageId}
                                    options={pages.map((p) => ({ label: p.name, value: p.id }))}
                                    placeholder="Select a Page"
                                    onChange={setSelectedPageId}
                                />
                            </div>
                            <ConnectButton onClick={selectPage} disabled={!selectedPageId || saving}>
                                {saving ? 'Saving…' : 'Use This Page'}
                            </ConnectButton>
                        </div>
                    )}
                </>
            )}
        </FieldWrapper>
    )
}
