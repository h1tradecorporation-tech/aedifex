'use client'

import { emitter, sceneRegistry, useScene } from '@aedifex/core'
import {
  clearScreenshotRenderer,
  setScreenshotRenderer,
  snapLevelsToTruePositions,
} from '@aedifex/viewer'
import { useThree } from '@react-three/fiber'
import { useCallback, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { EDITOR_LAYER } from '../../lib/constants'

const THUMBNAIL_WIDTH = 640
const THUMBNAIL_HEIGHT = 360
const AUTO_SAVE_DELAY = 10_000

/** Minimum number of meaningful scene nodes (walls/items/doors/windows) to justify a thumbnail */
const MIN_SCENE_NODES = 1

/** Sampling grid size for canvas validity check */
const SAMPLE_GRID = 8

/**
 * Check if a rendered canvas contains a meaningful image.
 * Samples pixels on a grid and rejects images that are nearly uniform
 * (all black, all white, or single-color), which indicates a render failure.
 */
function isCanvasContentValid(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false

  const { width, height } = canvas
  const stepX = Math.floor(width / SAMPLE_GRID)
  const stepY = Math.floor(height / SAMPLE_GRID)
  const samples: number[] = []

  for (let y = 0; y < SAMPLE_GRID; y++) {
    for (let x = 0; x < SAMPLE_GRID; x++) {
      const pixel = ctx.getImageData(x * stepX, y * stepY, 1, 1).data
      // Luminance approximation (Uint8ClampedArray always has RGBA for 1×1 pixel)
      const r = pixel[0] ?? 0
      const g = pixel[1] ?? 0
      const b = pixel[2] ?? 0
      samples.push(r * 0.299 + g * 0.587 + b * 0.114)
    }
  }

  // Check variance: if all samples are nearly identical, the image is uniform
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length
  const variance = samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length

  // A meaningful 3D scene should have some color variation (walls, shadows, etc.)
  // Variance < 5 means essentially a flat color (failed render)
  return variance > 5
}

// Re-export captureScreenshot from viewer with editor-specific defaults
export { captureScreenshot } from '@aedifex/viewer'

// ============================================================================
// ThumbnailGenerator Component
// ============================================================================

interface ThumbnailGeneratorProps {
  onThumbnailCapture?: (blob: Blob) => void
}

export const ThumbnailGenerator = ({ onThumbnailCapture }: ThumbnailGeneratorProps) => {
  const gl = useThree((state) => state.gl)
  const scene = useThree((state) => state.scene)
  const isGenerating = useRef(false)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingAutoRef = useRef(false)
  const onThumbnailCaptureRef = useRef(onThumbnailCapture)

  // Register renderer context for screenshot API (now in @aedifex/viewer)
  useEffect(() => {
    setScreenshotRenderer(gl, scene)
    return () => {
      clearScreenshotRenderer()
    }
  }, [gl, scene])

  useEffect(() => {
    onThumbnailCaptureRef.current = onThumbnailCapture
  }, [onThumbnailCapture])

  const generate = useCallback(async () => {
    if (isGenerating.current) return
    if (!onThumbnailCaptureRef.current) return

    isGenerating.current = true

    try {
      // Skip thumbnail generation if the scene has no meaningful content
      const nodes = useScene.getState().nodes
      const meaningfulTypes = new Set(['wall', 'item', 'door', 'window', 'slab', 'ceiling', 'roof', 'stair'])
      const meaningfulCount = Object.values(nodes).filter((n) => meaningfulTypes.has(n.type)).length
      if (meaningfulCount < MIN_SCENE_NODES) {
        isGenerating.current = false
        return
      }

      const thumbnailCamera = new THREE.PerspectiveCamera(
        60,
        THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT,
        0.1,
        1000,
      )

      const siteNode = Object.values(nodes).find((n) => n.type === 'site')

      if (siteNode?.camera) {
        const { position, target } = siteNode.camera
        thumbnailCamera.position.set(position[0], position[1], position[2])
        thumbnailCamera.lookAt(target[0], target[1], target[2])
      } else {
        thumbnailCamera.position.set(8, 8, 8)
        thumbnailCamera.lookAt(0, 0, 0)
      }
      thumbnailCamera.layers.disable(EDITOR_LAYER)

      const { width, height } = gl.domElement
      thumbnailCamera.aspect = width / height
      thumbnailCamera.updateProjectionMatrix()

      const restoreLevels = snapLevelsToTruePositions()

      // Force opaque white background — see capture-screenshot.ts for rationale.
      const prevBackground = scene.background
      const prevClearAlpha = (gl as any).getClearAlpha?.() ?? 1
      scene.background = new THREE.Color('#ffffff')
      if ((gl as any).setClearAlpha) {
        ;(gl as any).setClearAlpha(1)
      }

      const visibilitySnapshot = new Map<string, boolean>()
      for (const type of ['scan', 'guide'] as const) {
        sceneRegistry.byType[type].forEach((id) => {
          const obj = sceneRegistry.nodes.get(id)
          if (obj) {
            visibilitySnapshot.set(id, obj.visible)
            obj.visible = false
          }
        })
      }

      gl.render(scene, thumbnailCamera)

      // Restore original background and clear alpha
      scene.background = prevBackground
      if ((gl as any).setClearAlpha) {
        ;(gl as any).setClearAlpha(prevClearAlpha)
      }

      restoreLevels()
      visibilitySnapshot.forEach((wasVisible, id) => {
        const obj = sceneRegistry.nodes.get(id)
        if (obj) obj.visible = wasVisible
      })

      const srcAspect = width / height
      const dstAspect = THUMBNAIL_WIDTH / THUMBNAIL_HEIGHT
      let sx = 0,
        sy = 0,
        sWidth = width,
        sHeight = height
      if (srcAspect > dstAspect) {
        sWidth = Math.round(height * dstAspect)
        sx = Math.round((width - sWidth) / 2)
      } else if (srcAspect < dstAspect) {
        sHeight = Math.round(width / dstAspect)
        sy = Math.round((height - sHeight) / 2)
      }

      const offscreen = document.createElement('canvas')
      offscreen.width = THUMBNAIL_WIDTH
      offscreen.height = THUMBNAIL_HEIGHT
      const ctx = offscreen.getContext('2d')!
      ctx.drawImage(gl.domElement, sx, sy, sWidth, sHeight, 0, 0, THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT)

      // Validate rendered image: reject flat/corrupt renders (all black, all white, etc.)
      if (!isCanvasContentValid(offscreen)) {
        isGenerating.current = false
        return
      }

      offscreen.toBlob((blob) => {
        if (blob) {
          onThumbnailCaptureRef.current?.(blob)
        } else {
          console.error('❌ Failed to create blob from canvas')
        }
        isGenerating.current = false
      }, 'image/jpeg', 0.8)
    } catch (error) {
      console.error('❌ Failed to generate thumbnail:', error)
      isGenerating.current = false
    }
  }, [gl, scene])

  // Manual trigger via emitter
  useEffect(() => {
    const handleGenerateThumbnail = async () => {
      await generate()
    }

    emitter.on('camera-controls:generate-thumbnail', handleGenerateThumbnail)
    return () => emitter.off('camera-controls:generate-thumbnail', handleGenerateThumbnail)
  }, [generate])

  // Auto-trigger: debounced on scene changes, deferred if tab is hidden
  useEffect(() => {
    if (!onThumbnailCapture) return

    const triggerNow = () => generate()

    const scheduleOrDefer = () => {
      if (document.visibilityState === 'visible') {
        triggerNow()
      } else {
        pendingAutoRef.current = true
      }
    }

    const onSceneChange = () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = setTimeout(scheduleOrDefer, AUTO_SAVE_DELAY)
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && pendingAutoRef.current) {
        pendingAutoRef.current = false
        triggerNow()
      }
    }

    const unsubscribe = useScene.subscribe((state, prevState) => {
      if (state.nodes !== prevState.nodes) onSceneChange()
    })

    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [onThumbnailCapture, generate])

  return null
}
