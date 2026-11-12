/**
 * 交给视觉模型之前先把截图缩小。
 *
 * 裁决要的是「哪个应用、在干什么」，不是可读的正文；4K 原图按面积计费，
 * 还会把一次 look 的耗时拖长到超时。缩小失败就用原图——宁可多花钱，
 * 也不要因为一次 canvas 报错让她彻底看不见。
 *
 * 独立成文件是为了能在浏览器工程里直接测：`screen-sense` 会把整条 AUV/视觉链路
 * 一起拉进来，隔离不出这一段。
 */
export const VISION_MAX_WIDTH = 1280

export async function downscaleForVision(imageDataUrl: string, maxWidth = VISION_MAX_WIDTH): Promise<string> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function')
    return imageDataUrl
  try {
    const blob = await (await fetch(imageDataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    if (bitmap.width <= maxWidth) {
      bitmap.close?.()
      return imageDataUrl
    }
    const canvas = document.createElement('canvas')
    canvas.width = maxWidth
    canvas.height = Math.max(1, Math.round(bitmap.height * (maxWidth / bitmap.width)))
    const context = canvas.getContext('2d')
    if (!context) {
      bitmap.close?.()
      return imageDataUrl
    }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    return canvas.toDataURL('image/jpeg', 0.85)
  }
  catch {
    return imageDataUrl
  }
}
