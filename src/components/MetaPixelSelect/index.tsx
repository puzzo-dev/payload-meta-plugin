'use client'

import React, { useState } from 'react'
import { useDocumentInfo, TextInput } from '@payloadcms/ui'
import { FieldWrapper, LoadingState, EmptyState, ErrorState, ConnectButton, StyledSelect } from '../shared'

interface PixelOption {
    id: string
    name: string
}

/**
 * Custom Field component: "Select / Create Pixel" — lists Pixels owned by the
 * Business Manager ID set on the Connection tab, or creates a new one. Sets
 * pixelId on save; the plain pixelId text field above stays directly editable
 * too — this is a convenience picker, not a replacement for manual entry.
 */
export const MetaPixelSelectField: React.FC = () => {
    const { id } = useDocumentInfo()
    const [pixels, setPixels] = useState<PixelOption[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [selectedPixelId, setSelectedPixelId] = useState('')
    const [newPixelName, setNewPixelName] = useState('')
    const [creating, setCreating] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [savedMessage, setSavedMessage] = useState<string | null>(null)

    if (!id) {
        return (
            <FieldWrapper path="metaPixelSelectPanel" label="Select / Create Pixel">
                <EmptyState message="Save the document first, then this will be available." />
            </FieldWrapper>
        )
    }

    const loadPixels = () => {
        setLoading(true)
        setError(null)
        setSavedMessage(null)
        fetch(`/api/meta-oauth/pixels?configId=${id}`)
            .then((res) => res.json())
            .then((data) => {
                if (data.error) { setError(data.error); return }
                setPixels(data.pixels ?? [])
            })
            .catch(() => setError('Failed to load Pixels'))
            .finally(() => setLoading(false))
    }

    const applySelectedPixel = () => {
        if (!selectedPixelId) return
        const chosen = pixels?.find((p) => p.id === selectedPixelId)
        setSavedMessage(`Reload the page to see "${chosen?.name}" (${selectedPixelId}) in the Pixel ID field above — this picker doesn't write directly to form state; copy the ID or use Create below to save it automatically.`)
    }

    const createPixel = () => {
        if (!newPixelName.trim()) return
        setCreating(true)
        setError(null)
        setSavedMessage(null)
        fetch('/api/meta-oauth/pixels', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configId: id, name: newPixelName.trim() }),
        })
            .then((res) => res.json())
            .then((data) => {
                if (data.error) { setError(data.error); return }
                setSavedMessage(`Created and saved Pixel "${newPixelName}" (${data.pixelId}). Reload this page to see it reflected in the Pixel ID field above.`)
                setNewPixelName('')
            })
            .catch(() => setError('Failed to create Pixel'))
            .finally(() => setCreating(false))
    }

    return (
        <FieldWrapper path="metaPixelSelectPanel" label="Select / Create Pixel" description="Requires Business Manager ID and a completed Meta Business Login connection (Connection tab).">
            {error && <ErrorState message={error} />}
            {savedMessage && <EmptyState message={savedMessage} />}

            {pixels === null ? (
                <ConnectButton onClick={loadPixels} disabled={loading}>
                    {loading ? 'Loading…' : 'Load Existing Pixels'}
                </ConnectButton>
            ) : (
                <>
                    {loading ? (
                        <LoadingState message="Loading Pixels…" />
                    ) : pixels.length > 0 ? (
                        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1rem' }}>
                            <div style={{ flex: 1 }}>
                                <StyledSelect
                                    path="metaPixelSelectPanel_pixelSelect"
                                    value={selectedPixelId}
                                    options={pixels.map((p) => ({ label: `${p.name} (${p.id})`, value: p.id }))}
                                    placeholder="Select a Pixel"
                                    onChange={setSelectedPixelId}
                                />
                            </div>
                            <ConnectButton onClick={applySelectedPixel} disabled={!selectedPixelId}>
                                Use This Pixel
                            </ConnectButton>
                        </div>
                    ) : (
                        <EmptyState message="No existing Pixels found for this Business Manager." />
                    )}

                    <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end' }}>
                        <div style={{ flex: 1 }}>
                            <TextInput
                                path="metaPixelSelectPanel_newPixelName"
                                value={newPixelName}
                                onChange={(e: { target: { value: string } }) => setNewPixelName(e.target.value)}
                                placeholder="New Pixel name, e.g. &quot;That Ofada Girl&quot;"
                            />
                        </div>
                        <ConnectButton onClick={createPixel} disabled={!newPixelName.trim() || creating}>
                            {creating ? 'Creating…' : 'Create New Pixel'}
                        </ConnectButton>
                    </div>
                </>
            )}
        </FieldWrapper>
    )
}
