export const META_OAUTH_MESSAGE_SOURCE = 'payload-meta-oauth'

/**
 * The Facebook window is a popup. This page tells the admin tab the result
 * and closes itself. If the browser blocked the popup and the login ran in
 * the same tab, there is no opener, so it continues to the admin document.
 */
export function oauthPopupResponse(args: { ok: boolean; error: string | null; nextUrl: string }): Response {
    const message = JSON.stringify({
        source: META_OAUTH_MESSAGE_SOURCE,
        ok: args.ok,
        error: args.error,
    }).replace(/</g, '\\u003c')
    const nextUrl = JSON.stringify(args.nextUrl).replace(/</g, '\\u003c')
    const heading = args.ok ? 'Facebook login finished.' : 'Facebook login did not finish.'
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>Meta</title></head><body><p>${heading} You can close this window.</p><script>(function(){var message=${message};var nextUrl=${nextUrl};try{if(window.opener&&!window.opener.closed){window.opener.postMessage(message,window.location.origin);window.close();return;}}catch(e){}window.location.replace(nextUrl);})();</script></body></html>`
    return new Response(html, {
        status: 200,
        headers: {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
        },
    })
}
