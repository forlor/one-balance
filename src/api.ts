import * as keyService from './service/key'
import * as util from './util'
import type * as schema from './service/d1/schema'

const PROVIDER_CUSTOM_AUTH_HEADER: Record<string, string> = {
    'google-ai-studio': 'x-goog-api-key',
    anthropic: 'x-api-key',
    elevenlabs: 'x-api-key',
    'azure-openai': 'api-key',
    cartesia: 'X-API-Key'
}

function getAuthHeaderName(provider: string, restResource?: string): string {
    if (provider === 'google-ai-studio' && restResource?.includes('/openai/')) {
        return 'Authorization'
    }
    return PROVIDER_CUSTOM_AUTH_HEADER[provider] || 'Authorization'
}

export async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    const restResource = url.pathname.substring('/api/'.length) + url.search

    const provider = restResource.split('/')[0]
    const authKey = getAuthKey(request, provider, url, restResource)
    const realProviderAndModel = await extractRealProviderAndModel(request, restResource, provider)
    if (!realProviderAndModel) {
        return new Response('Not supported request: valid provider or model not found', { status: 400 })
    }

    if (!util.isApiRequestAllowed(authKey, env.AUTH_KEY, realProviderAndModel.provider, realProviderAndModel.model)) {
        return new Response('Invalid auth key', { status: 403 })
    }

    return await forward(request, env, ctx, restResource, realProviderAndModel.provider, realProviderAndModel.model)
}

async function extractRealProviderAndModel(
    request: Request,
    restResource: string,
    provider: string
): Promise<{ provider: string; model: string } | null> {
    const model = await extractModel(request, restResource)
    if (!model) {
        return null
    }
    if (provider !== 'compat') {
        return { provider, model }
    }

    // find the real provider from model (e.g. google-ai-studio/gemini-2.0-flash)
    // see https://developers.cloudflare.com/ai-gateway/chat-completion/#curl
    const realProvider = model.split('/')[0]
    if (!realProvider) {
        // bad request
        return null
    }
    const realModel = model.split('/')[1]
    if (!realModel) {
        // bad request
        return null
    }

    return { provider: realProvider, model: realModel }
}

async function extractModel(request: Request, restResource: string): Promise<string | null> {
    const pathModel = extractModelFromPath(restResource)
    if (pathModel) {
        return util.sanitizeModelName(pathModel)
    }

    if (request.method === 'POST' && request.body) {
        const model = await extractModelFromBody(request)
        if (model) return util.sanitizeModelName(model)
    }

    return null
}

function maskKey(key: string): string {
    if (!key) return ''
    if (key.length <= 10) return '***'
    return `${key.substring(0, 6)}...${key.substring(key.length - 4)}`
}

async function extractModelFromBody(request: Request): Promise<string | null> {
    try {
        const body = (await request.clone().json()) as { model: string }
        return body.model || null
    } catch {
        return null
    }
}

function extractModelFromPath(restResource: string): string | null {
    const parts = restResource.split('/models/')
    if (parts.length > 1) {
        return parts[1].split(':')[0]
    }

    return null
}

async function forward(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
    restResource: string,
    provider: string,
    model: string
): Promise<Response> {
    const cachedKeys = await keyService.listActiveKeysViaCache(env, provider)
    if (cachedKeys.length === 0) {
        return new Response('No active keys available', { status: 503 })
    }

    // Shallow copy the array so we can safely splice/remove items locally during retries
    // without altering the cached list structure for other requests.
    const activeKeys = [...cachedKeys]

    let body = request.body ? await request.arrayBuffer() : null

    // For all Gemini 3.x models from Google AI Studio, strip temperature, top_p, and top_k to let Gemini 3's reasoning engine run with optimized defaults.
    const isGemini3 = provider === 'google-ai-studio' && model.toLowerCase().includes('gemini-3')
    if (isGemini3 && body) {
        try {
            const bodyStr = new TextDecoder().decode(body)
            const data = JSON.parse(bodyStr) as any

            if (data && typeof data === 'object' && !Array.isArray(data)) {
                // 1. Native Format (generationConfig)
                if (data.generationConfig && typeof data.generationConfig === 'object') {
                    delete data.generationConfig.temperature
                    delete data.generationConfig.topP
                    delete data.generationConfig.topK
                    if (Object.keys(data.generationConfig).length === 0) {
                        delete data.generationConfig
                    }
                }

                // 2. OpenAI Compatible / Common top-level properties
                if ('temperature' in data) delete data.temperature
                if ('top_p' in data) delete data.top_p
                if ('top_k' in data) delete data.top_k

                body = new TextEncoder().encode(JSON.stringify(data))
                console.info(
                    `[Gemini 3 Param Stripper] Successfully removed temperature/top_p/top_k from model ${model} request body to optimize reasoning.`
                )
            }
        } catch (e) {
            console.error(
                `[Gemini 3 Param Stripper] Failed to parse or modify Gemini 3 request body for model ${model}`,
                e
            )
        }
    }
    const MAX_RETRIES = Number(env.MAX_RETRIES) || 4
    for (let i = 0; i < MAX_RETRIES; i++) {
        if (activeKeys.length === 0) {
            return new Response('No active keys available', { status: 503 })
        }

        const selectedKey = await selectKey(activeKeys, model)
        const controller = new AbortController()
        const reqToGateway = await makeGatewayRequest(
            request.method,
            request.headers,
            body,
            env,
            restResource,
            selectedKey.key,
            controller.signal
        )
        const respFromGateway = await fetch(reqToGateway)
        const status = respFromGateway.status
        switch (status) {
            // try block
            case 400:
                if (!(await keyIsInvalid(respFromGateway, provider))) {
                    return respFromGateway // user error
                }

            // key is invalid, then continue to block and next key
            case 401:
            case 403:
                const errorText = await respFromGateway.text().catch(() => '')
                const isLocationError =
                    errorText.toLowerCase().includes('location') || errorText.toLowerCase().includes('supported')

                if (isLocationError) {
                    console.warn(
                        `key ${maskKey(selectedKey.key)} (Remark: ${selectedKey.remark || 'none'}, ID: ${selectedKey.id}) got 403 location error (unsupported region in Cloudflare egress node), skipping database block.`
                    )
                } else {
                    ctx.waitUntil(keyService.setKeyStatus(env, provider, selectedKey.id, 'blocked'))
                    console.error(
                        `key ${maskKey(selectedKey.key)} (Remark: ${selectedKey.remark || 'none'}, ID: ${selectedKey.id}) is blocked due to ${respFromGateway.status} ${errorText}`
                    )
                }

                const blockedIndex = activeKeys.indexOf(selectedKey)
                if (blockedIndex !== -1) {
                    activeKeys.splice(blockedIndex, 1)
                }
                continue

            // try cooling down
            case 429:
                const sec = await analyze429CooldownSeconds(env, respFromGateway, provider, selectedKey.key)
                ctx.waitUntil(keyService.setKeyModelCooldownIfAvailable(env, selectedKey.id, provider, model, sec))

                // Update the shared key's cooldown state in memory so other concurrent requests hitting the cache see it instantly
                const now = Date.now() / 1000
                if (!selectedKey.modelCoolings) {
                    selectedKey.modelCoolings = {}
                }
                selectedKey.modelCoolings[model] = {
                    end_at: Math.round(now + sec),
                    total_seconds: (selectedKey.modelCoolings[model]?.total_seconds || 0) + sec
                }

                // next key (remove from current local retry attempt list)
                const errBodyText = await respFromGateway.text().catch(() => '')
                console.warn(
                    `key ${maskKey(selectedKey.key)} (Remark: ${selectedKey.remark || 'none'}, ID: ${selectedKey.id}) is cooling down for model ${model} due to 429: ${errBodyText}`
                )
                const coolingIndex = activeKeys.indexOf(selectedKey)
                if (coolingIndex !== -1) {
                    activeKeys.splice(coolingIndex, 1)
                }

                // Only back off when another retry will actually follow. On the final
                // attempt the loop exits and returns 500 to the caller, so sleeping just
                // adds pointless latency for no benefit.
                if (i < MAX_RETRIES - 1) {
                    const backoffMs = Math.min(1500 * Math.pow(2, i), 20000)
                    await new Promise(resolve => setTimeout(resolve, backoffMs))
                }

                continue

            case 500:
            case 502:
            case 503:
            case 504:
                let timerId: any
                const timeoutPromise = new Promise<string>(resolve => {
                    timerId = setTimeout(() => {
                        controller.abort() // Instantly cancels the response text stream and network request
                        resolve('<timeout reading body>')
                    }, 1000)
                })

                const serverErrorText = await Promise.race([respFromGateway.text(), timeoutPromise]).catch(() => '')

                clearTimeout(timerId)

                console.error(`gateway returned ${status} ${serverErrorText}`)

                // 剔除当前故障 Key，确保下一次重试尝试其他 Key
                const errorIndex = activeKeys.indexOf(selectedKey)
                if (errorIndex !== -1) {
                    activeKeys.splice(errorIndex, 1)
                }

                // Only back off when another retry will actually follow (see the 429 case
                // above for rationale).
                if (i < MAX_RETRIES - 1) {
                    const serverErrorBackoffMs = Math.min(1500 * Math.pow(2, i), 20000)
                    await new Promise(resolve => setTimeout(resolve, serverErrorBackoffMs))
                }

                continue
        }

        if (respFromGateway.ok) {
            consecutive429Count.delete(selectedKey.key)
        } else {
            console.error(`gateway returned ${status}`)
        }
        return respFromGateway
    }

    return new Response('Internal server error after retries', { status: 500 })
}

function getAuthKey(request: Request, provider: string, url: URL, restResource?: string): string {
    if (provider === 'google-ai-studio') {
        // try to get auth key from query params
        const key = url.searchParams.get('key')
        if (key) {
            return key
        }
    }

    return getAuthKeyFromHeader(request, provider, restResource)
}

function getAuthKeyFromHeader(request: Request, provider: string, restResource?: string): string {
    const h = getAuthHeaderName(provider, restResource)
    let v = request.headers.get(h)

    // 如果自定义头部没有值，且自定义头部不是 'Authorization'，则尝试从 'Authorization' 头部获取
    if (!v && h !== 'Authorization') {
        v = request.headers.get('Authorization')
    }

    if (!v) {
        return ''
    }

    // 如果值是以 Bearer 开头，去掉 Bearer 前缀
    if (v.startsWith('Bearer ')) {
        return v.substring(7)
    }

    return v
}

// Round-robin cursor per provider+model. The cursor is meaningful WITHIN a single
// cache window: the cached array order is frozen between refreshes, so an index maps
// to the same key for the window's lifetime and the cursor rotates requests evenly
// (preventing concurrent requests on one instance from all hitting the head key).
// Across refreshes the array is reshuffled by RANDOM() in listActiveKeysViaCache, so
// the cursor's cross-refresh continuity is intentionally lost — that's fine, the whole
// array was just reshuffled. If the cursor is stale (>= length after a refresh with a
// different key count), it simply wraps around.
const roundRobinIndexByModel: Map<string, number> = new Map()

async function selectKey(keys: schema.Key[], model: string): Promise<schema.Key> {
    const now = Date.now() / 1000
    const len = keys.length

    const cursorKey = model
    let cursor = roundRobinIndexByModel.get(cursorKey) ?? 0
    if (cursor >= len) cursor = 0

    // A key is "cooling" for this model if its cooldown end_at is still in the future.
    // Cooldown lookups are normalized (no "models/" prefix) via util.sanitizeModelName,
    // so they can't be missed due to spelling drift.
    const isCooling = (k: schema.Key) => {
        const end = k.modelCoolings?.[model]?.end_at
        return !!end && end >= now
    }

    // Pure round-robin: walk up to `len` steps from the cursor and pick the first key
    // that isn't currently cooling down for this model. Advancing the cursor on every
    // pick spreads load evenly across all available keys — this is the main lever for
    // keeping 429s low on Google AI Studio, where each free key has tight per-day quotas.
    // We intentionally do NOT weight by totalCoolingSeconds here: that value is
    // monotonically increasing (never decays), so weighting by it permanently sidelines
    // any key that ever hit a daily quota, concentrating load on the remaining few and
    // *causing* more 429s rather than preventing them.
    for (let i = 0; i < len; i++) {
        const idx = (cursor + i) % len
        const candidate = keys[idx]
        if (!isCooling(candidate)) {
            roundRobinIndexByModel.set(cursorKey, (idx + 1) % len)
            console.info(
                `selected key via round-robin: ${maskKey(candidate.key)} (Remark: ${candidate.remark || 'none'}, ID: ${candidate.id})`
            )
            return candidate
        }
    }

    // Fallback: all keys are cooling for this model — pick the one that recovers
    // earliest so the next request resumes soonest. Don't advance the cursor here,
    // because no normal pick happened.
    let bestCoolingKey: schema.Key = keys[0]
    let earliestCooldownEnd = Infinity
    for (const key of keys) {
        const coolingEnd = key.modelCoolings?.[model]?.end_at || 0
        if (coolingEnd < earliestCooldownEnd) {
            earliestCooldownEnd = coolingEnd
            bestCoolingKey = key
        }
    }
    console.warn(
        `all keys cooling down for ${model}, selected earliest-recovery key: ${maskKey(bestCoolingKey.key)} (Remark: ${bestCoolingKey.remark || 'none'}, ID: ${bestCoolingKey.id})`
    )
    return bestCoolingKey
}

const gatewayUrlCache = new Map<string, string>()

async function makeGatewayRequest(
    method: string,
    headers: Headers,
    body: ArrayBuffer | null,
    env: Env,
    restResource: string,
    key: string,
    signal?: AbortSignal
): Promise<Request> {
    const newHeaders = new Headers(headers)
    setAuthHeader(newHeaders, restResource, key)

    const selected = selectGateway(env)
    let base = gatewayUrlCache.get(selected)
    if (!base) {
        base = await env.AI.gateway(selected).getUrl()
        gatewayUrlCache.set(selected, base)
    }
    if (!base.endsWith('/')) {
        base += '/'
    }

    // Clean up the 'key' query parameter from restResource to avoid forwarding client/gateway auth key to Gemini
    let cleanResource = restResource
    if (restResource.includes('?')) {
        const [pathPart, searchPart] = restResource.split('?')
        const params = new URLSearchParams(searchPart)
        if (params.has('key')) {
            params.delete('key')
        }
        const newSearch = params.toString()
        cleanResource = newSearch ? `${pathPart}?${newSearch}` : pathPart
    }

    const url = `${base}${cleanResource}`

    return new Request(url, {
        method: method,
        headers: newHeaders,
        body: body,
        redirect: 'follow',
        signal: signal
    })
}

function selectGateway(env: Env): string {
    const gateways = env.AI_GATEWAY.split(',').map(s => s.trim())
    const selected = gateways[Math.floor(Math.random() * gateways.length)]
    console.info(`selected gateway ${selected}`)
    return selected
}

function setAuthHeader(headers: Headers, restResource: string, key: string) {
    const provider = restResource.split('/')[0]

    let v = key
    const h = getAuthHeaderName(provider, restResource)
    if (h == 'Authorization') {
        v = `Bearer ${key}`
    } else {
        // 如果上游提供商使用自定义头部，则必须删除原请求中的 Authorization 头部，避免干扰上游认证
        headers.delete('Authorization')
    }

    headers.set(h, v)
}

async function keyIsInvalid(respFromGateway: Response, provider: string): Promise<boolean> {
    if (provider !== 'google-ai-studio') {
        return false // TODO: support other providers
    }

    if (respFromGateway.status !== 400) {
        return false
    }

    try {
        const body = await respFromGateway.clone().json()
        const detail = getGoogleAiStudioErrorDetail(body, 'type.googleapis.com/google.rpc.ErrorInfo')
        return detail?.reason === 'API_KEY_INVALID' // may already deleted.
    } catch {
        return false
    }
}

// Using an in-memory Map to count consecutive 429s is a design choice to prioritize performance and minimize costs.
// - Why not use D1 (DB)? To avoid database writes on every 429 error, which would increase load and latency. We only write to the DB when a key needs to be cooled down.
// - Why not use KV? The free tier has low write quotas. Also, KV's eventual consistency makes it unsuitable for precise, real-time counting.
// Limitation: This counter is local to each worker instance and not shared globally. If requests for the same key are routed to different instances, the count may be inaccurate.
// However, for short-lived consecutive requests, Cloudflare often routes them to the same instance, making this a practical trade-off.
let consecutive429Count: Map<string, number> = new Map()

async function analyze429CooldownSeconds(
    env: Env,
    respFromGateway: Response,
    provider: string,
    key: string
): Promise<number> {
    const count = (consecutive429Count.get(key) || 0) + 1
    consecutive429Count.set(key, count)

    const threshold = Number(env.CONSECUTIVE_429_THRESHOLD) || 2
    if (count >= threshold) {
        consecutive429Count.delete(key)
        console.error(`key ${maskKey(key)} triggered long cooldown after ${threshold} consecutive 429s`)
        return untilResetForDay(provider)
    }

    return untilReset(respFromGateway, provider)
}

function untilResetForDay(provider: string): number {
    if (provider === 'google-ai-studio') {
        return util.getSecondsUntilMidnightPT()
    }
    if (provider === 'openrouter') {
        return util.getSecondsUntilMidnightUTC()
    }

    return 24 * 60 * 60
}

async function untilReset(respFromGateway: Response, provider: string): Promise<number> {
    if (provider === 'google-ai-studio') {
        return untilResetForGoogleAiStudio(respFromGateway)
    }
    if (provider === 'openrouter') {
        return untilResetForOpenrouter(respFromGateway)
    }

    return 65
}

async function untilResetForGoogleAiStudio(respFromGateway: Response): Promise<number> {
    try {
        const errorBody = (await respFromGateway.clone().json()) as any

        // 1. 优先提取并判断精确的结构化 QuotaFailure 详情
        const quotaFailureDetail = getGoogleAiStudioErrorDetail(
            errorBody,
            'type.googleapis.com/google.rpc.QuotaFailure'
        )
        if (quotaFailureDetail) {
            const violations = quotaFailureDetail.violations || []
            for (const violation of violations) {
                if (
                    violation.quotaId &&
                    (violation.quotaId === 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' ||
                        violation.quotaId.includes('PerDay') ||
                        violation.quotaId.toLowerCase().includes('day'))
                ) {
                    return util.getSecondsUntilMidnightPT() // Requests per day (RPD) quotas reset at midnight Pacific time
                }
            }
        }

        // 2. 优先提取 RetryInfo 详情
        const retryInfoDetail = getGoogleAiStudioErrorDetail(errorBody, 'type.googleapis.com/google.rpc.RetryInfo')
        if (retryInfoDetail && retryInfoDetail.retryDelay) {
            const retrySeconds = parseInt(retryInfoDetail.retryDelay.replace('s', ''))
            return retrySeconds + 2 // 2 seconds buffer
        }

        // 3. 兜底逻辑：若无结构化详情，再通过 message 字符串做临时 IP 限流或分钟限流判断
        const errorMessage = errorBody?.error?.message || ''
        const errorStatus = errorBody?.error?.status || ''
        if (errorStatus === 'RESOURCE_EXHAUSTED') {
            const msgLower = errorMessage.toLowerCase()
            if (msgLower.includes('minute') || msgLower.includes('tpm') || msgLower.includes('rpm')) {
                return 65 // Minute rate limit
            }
            if (msgLower.includes('exhausted') || msgLower.includes('quota') || msgLower.includes('day')) {
                // 如果没有详细的 QuotaFailure 结构，这非常有可能是 Cloudflare 共享出口 IP 触发的临时 IP 限流（即 Key 本身没用完）。
                // 此时如果直接冷却一整天（直到午夜）会导致正常 Key 被误封一整天，造成严重误判。
                // 因此，我们对这种简易报错只进行 120 秒的临时冷却，避开当前的临时 IP 频控。
                console.warn(
                    `Google AI Studio 429 detected from error message: "${errorMessage}". Cooling down for 120s to bypass temporary IP-rate limit.`
                )
                return 120
            }
        }
    } catch (error) {
        console.error('failed to parse google-ai-studio 429 response, fallback to 65 seconds', error)
    }
    return 65
}

async function untilResetForOpenrouter(respFromGateway: Response): Promise<number> {
    try {
        const resetHeader = respFromGateway.headers.get('X-RateLimit-Reset')
        if (resetHeader) {
            const resetTime = parseInt(resetHeader)
            const now = Date.now()
            if (resetTime > now) {
                const cooldownSeconds = Math.floor((resetTime - now) / 1000) + 5
                return cooldownSeconds
            }
        }
    } catch (error) {
        console.error('failed to parse openrouter 429 response, fallback to 65 seconds', error)
    }
    return 65
}

function getGoogleAiStudioErrorDetail(body: any, type: string): any | null {
    let errorBody = body
    if (Array.isArray(body) && body.length > 0) {
        errorBody = body[0]
    }

    const details = errorBody?.error?.details || []
    for (const detail of details) {
        if (detail['@type'] === type) {
            return detail
        }
    }

    return null
}
