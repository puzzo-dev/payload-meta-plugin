'use client'

import React, { useCallback, useEffect, useRef } from 'react'
import { useAuth, useDocumentInfo, useForm, useFormFields } from '@payloadcms/ui'

function relationId(value: unknown): string | number | null {
    if (value == null || value === '') return null
    if (typeof value === 'object') {
        const id = (value as { id?: unknown }).id
        if (typeof id === 'string' || typeof id === 'number') return id
        return null
    }
    if (typeof value === 'string' || typeof value === 'number') return value
    return null
}

/**
 * Fills the Organization and Site dropdowns from the person who is signed in.
 * An editor has one site. An organization admin with one site gets that site.
 * The organization is chosen first. Changing it clears a site that belongs to
 * another organization. Choosing a site still confirms the organization that
 * owns that site.
 */
export const MetaTenantDefaults: React.FC = () => {
    const { user } = useAuth()
    const { id } = useDocumentInfo()
    const { dispatchFields } = useForm()
    // useField reads the admin config. Payload renders this field while it is
    // still building the form, before that config exists, and the create
    // screen crashes. The site and organization values are already on the form.
    const siteValue = useFormFields(([fields]) => fields?.site?.value)
    const organizationValue = useFormFields(([fields]) => fields?.organization?.value)
    const seeded = useRef(false)
    const lastSite = useRef<string | number | null>(null)
    const lastOrg = useRef<string | number | null>(null)

    const setSite = useCallback((value: string | number) => {
        dispatchFields({ type: 'UPDATE', path: 'site', value })
    }, [dispatchFields])
    const setOrganization = useCallback((value: string | number) => {
        dispatchFields({ type: 'UPDATE', path: 'organization', value })
    }, [dispatchFields])

    useEffect(() => {
        if (id || seeded.current) return
        const account = user as { role?: string; site?: unknown; organization?: unknown } | null
        if (!account) return
        const ownSite = relationId(account.site)
        const ownOrg = relationId(account.organization)

        if (relationId(organizationValue) == null && ownOrg != null) setOrganization(ownOrg)
        if (relationId(siteValue) == null && ownSite != null) {
            setSite(ownSite)
            seeded.current = true
            return
        }
        if (relationId(siteValue) != null || ownOrg == null || account.role === 'super-admin') {
            seeded.current = true
            return
        }

        let cancelled = false
        fetch(`/api/sites?where[organization][equals]=${encodeURIComponent(String(ownOrg))}&limit=2&depth=0`)
            .then((res) => res.json())
            .then((body: { docs?: Array<{ id?: string | number; organization?: unknown }> }) => {
                if (cancelled) return
                const docs = body?.docs ?? []
                if (docs.length === 1 && docs[0]?.id != null) {
                    setSite(docs[0].id)
                    const siteOrg = relationId(docs[0].organization) ?? ownOrg
                    setOrganization(siteOrg)
                }
            })
            .catch(() => { /* the dropdown stays open so they can choose */ })
            .finally(() => { seeded.current = true })
        return () => { cancelled = true }
    }, [id, user, siteValue, organizationValue, setSite, setOrganization])

    useEffect(() => {
        const siteId = relationId(siteValue)
        if (siteId == null || lastSite.current === siteId) return
        lastSite.current = siteId
        let cancelled = false
        fetch(`/api/sites/${encodeURIComponent(String(siteId))}?depth=0`)
            .then((res) => res.json())
            .then((doc: { organization?: unknown }) => {
                const orgId = relationId(doc?.organization)
                if (!cancelled && orgId != null) setOrganization(orgId)
            })
            .catch(() => { /* leave the organization already shown */ })
        return () => { cancelled = true }
    }, [siteValue, setOrganization])

    useEffect(() => {
        const orgId = relationId(organizationValue)
        if (orgId == null) return
        if (lastOrg.current == null) {
            lastOrg.current = orgId
            return
        }
        if (String(lastOrg.current) === String(orgId)) return
        lastOrg.current = orgId
        const siteId = relationId(siteValue)
        if (siteId == null) return
        let cancelled = false
        fetch(`/api/sites/${encodeURIComponent(String(siteId))}?depth=0`)
            .then((res) => res.json())
            .then((doc: { organization?: unknown }) => {
                const siteOrg = relationId(doc?.organization)
                if (cancelled || siteOrg == null || String(siteOrg) === String(orgId)) return
                lastSite.current = null
                dispatchFields({ type: 'UPDATE', path: 'site', value: null })
            })
            .catch(() => { /* leave the site so they can change it */ })
        return () => { cancelled = true }
    }, [organizationValue, siteValue, dispatchFields])

    return null
}
