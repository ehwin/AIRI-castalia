import { describe, expect, it } from 'vitest'

import { downscaleForVision, VISION_MAX_WIDTH } from './image-downscale'

/** 造一张纯色 PNG：尺寸是真值，内容无所谓——这里只验缩放，不验画面。 */
function pngOf(width: number, height: number): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context)
    throw new Error('no 2d context')
  context.fillStyle = '#123456'
  context.fillRect(0, 0, width, height)
  return canvas.toDataURL('image/png')
}

async function sizeOf(dataUrl: string): Promise<{ width: number, height: number }> {
  const blob = await (await fetch(dataUrl)).blob()
  const bitmap = await createImageBitmap(blob)
  return { width: bitmap.width, height: bitmap.height }
}

describe('downscaleForVision', () => {
  it('fits a 4K capture into the width a verdict needs', async () => {
    const original = pngOf(3840, 2160)
    const scaled = await downscaleForVision(original)

    expect(scaled.startsWith('data:image/jpeg')).toBe(true)
    expect(scaled.length).toBeLessThan(original.length)
    // 16:9 保比例：1280 × 720。
    await expect(sizeOf(scaled)).resolves.toEqual({ width: VISION_MAX_WIDTH, height: 720 })
  })

  it('leaves an image that already fits untouched', async () => {
    const original = pngOf(800, 600)
    await expect(downscaleForVision(original)).resolves.toBe(original)
  })

  it('falls back to the original when the payload is not decodable', async () => {
    // 坏图不能让感知整条断掉：宁可多花 token，也要让她还有画面可看。
    const broken = 'data:image/png;base64,AAAA'
    await expect(downscaleForVision(broken)).resolves.toBe(broken)
  })
})
