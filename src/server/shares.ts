import { site } from '#/config/site'
import { sniffImageType } from './media'
import { getModerationProvider } from './moderation'
import { outputExpiresAt } from './retention'
import type { GenerationRow } from './types'
import { ApiError, nowIso, randomToken } from './util'

// 公开分享链接 /v/<shareId>：randomToken(12) 的 16 位 base64url。不可枚举，停止分享后旧串作废
export const SHARE_ID = /^[A-Za-z0-9_-]{16}$/
// 分享页路径（可带语言前缀），src/server.ts 据此在渲染前查好分享数据
export const SHARE_PAGE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?v\/([^/]+)$/i
// 封面：浏览器截帧生成的 1200×630 JPEG，正常 60–200 KB
export const SHARE_POSTER_MAX_BYTES = 512 * 1024

// 分享页和 /api/shares/:id 返回的数据。不含 generation id、用户信息和原图
export type ShareView =
  | {
      state: 'ok'
      id: string
      videoUrl: string
      posterUrl: string | null
      durationSeconds: number
      createdAt: string
      expiresAt: string | null
    }
  | { state: 'missing' | 'expired' | 'removed' }

// missing：链接不存在、已停止分享或站点关闭了分享（404）；expired、removed：成片已到期删除或被下架（410）
export function shareHttpStatus(view: ShareView) {
  return view.state === 'ok' ? 200 : view.state === 'missing' ? 404 : 410
}

export function shareVideoPath(shareId: string) {
  return `/media/shares/${shareId}/video`
}

export function sharePosterPath(shareId: string) {
  return `/media/shares/${shareId}/poster.jpg`
}

export async function findSharedGeneration(env: Env, shareId: string) {
  if (!site.share.enabled || !SHARE_ID.test(shareId)) return null
  return env.DB.prepare('SELECT * FROM arv_generations WHERE share_id = ?').bind(shareId).first<GenerationRow>()
}

export function shareView(row: GenerationRow | null): ShareView {
  if (!row?.share_id) return { state: 'missing' }
  if (row.removed_at) return { state: 'removed' }
  if (row.expired_at || !row.output_r2_key || row.status !== 'succeeded') return { state: 'expired' }
  return {
    state: 'ok',
    id: row.share_id,
    videoUrl: shareVideoPath(row.share_id),
    posterUrl: row.share_poster_key ? sharePosterPath(row.share_id) : null,
    durationSeconds: row.duration_seconds,
    createdAt: row.completed_at ?? row.created_at,
    expiresAt: outputExpiresAt(row.completed_at),
  }
}

export async function loadShare(env: Env, shareId: string) {
  return shareView(await findSharedGeneration(env, shareId))
}

// 只有自己的、已成功且成片还在的视频能分享
export function assertShareable(row: GenerationRow) {
  if (!site.share.enabled) throw new ApiError(404, 'not_found')
  if (row.removed_at) throw new ApiError(410, 'media_removed')
  if (row.expired_at) throw new ApiError(410, 'media_expired')
  if (row.status !== 'succeeded' || !row.output_r2_key) throw new ApiError(409, 'not_ready')
}

// 读取并检查封面：没有请求体时返回 null（不带封面，分享页用站点默认 OG 图）。
// 封面是公开图片，和上传原图一样过内容审核，否则这里能被当成任意图床
export async function readSharePoster(env: Env, request: Request) {
  const header = request.headers.get('content-length')
  if (header === '0' || (!header && !request.body)) return null
  if (!header || !/^\d+$/.test(header)) throw new ApiError(411, 'length_required')
  if (Number(header) > SHARE_POSTER_MAX_BYTES) throw new ApiError(413, 'file_too_large')
  const bytes = new Uint8Array(await request.arrayBuffer())
  if (!bytes.length) return null
  if (bytes.length > SHARE_POSTER_MAX_BYTES) throw new ApiError(413, 'file_too_large')
  if (sniffImageType(bytes) !== 'image/jpeg') throw new ApiError(415, 'unsupported_file_type')
  const verdict = await getModerationProvider(env).checkImage({
    bytes,
    contentType: 'image/jpeg',
    mockOutcome: request.headers.get('x-mock-moderation'),
  })
  if (!verdict.allowed) {
    console.warn('share poster rejected by moderation', verdict.reason)
    throw new ApiError(422, 'share_rejected')
  }
  return bytes
}

// 开始分享：已在分享的保留原链接（只换封面）；新分享生成新的 share_id
export async function startShare(env: Env, row: GenerationRow, poster: Uint8Array | null) {
  const shareId = row.share_id ?? randomToken(12)
  let posterKey = row.share_poster_key
  if (poster) {
    posterKey = `outputs/${row.user_id}/${row.id}-share.jpg`
    await env.MEDIA.put(posterKey, poster, { httpMetadata: { contentType: 'image/jpeg' } })
  }
  const now = nowIso()
  await env.DB.prepare('UPDATE arv_generations SET share_id = ?, share_poster_key = ?, shared_at = COALESCE(shared_at, ?), updated_at = ? WHERE id = ?')
    .bind(shareId, posterKey, now, now, row.id)
    .run()
  return shareId
}

// 停止分享：删封面、清空 share_id，旧链接从此 404
export async function stopShare(env: Env, row: GenerationRow) {
  if (row.share_poster_key) await env.MEDIA.delete(row.share_poster_key)
  await env.DB.prepare('UPDATE arv_generations SET share_id = NULL, share_poster_key = NULL, shared_at = NULL, updated_at = ? WHERE id = ?')
    .bind(nowIso(), row.id)
    .run()
}
