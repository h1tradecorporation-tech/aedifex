import { type LevelNode, sceneRegistry, useScene } from '@aedifex/core'
import { useFrame } from '@react-three/fiber'
import { lerp } from 'three/src/math/MathUtils.js'
import useViewer from '../../store/use-viewer'
import { getLevelHeight } from './level-utils'

const EXPLODED_GAP = 5

export const LevelSystem = () => {
  useFrame((_, delta) => {
    const nodes = useScene.getState().nodes
    const levelMode = useViewer.getState().levelMode
    const selectedLevel = useViewer.getState().selection.levelId

    // Group levels by parentId so each building (or orphan group) stacks
    // independently from Y=0. Without grouping, a stray level shared the
    // same cumulative Y axis as building children, producing phantom gaps
    // when sibling buildings or orphan levels existed.
    type LevelEntry = {
      levelId: string
      index: number
      obj: NonNullable<ReturnType<typeof sceneRegistry.nodes.get>>
    }
    const groups = new Map<string | null, LevelEntry[]>()
    sceneRegistry.byType.level.forEach((levelId) => {
      const obj = sceneRegistry.nodes.get(levelId)
      const level = nodes[levelId as LevelNode['id']]
      if (!obj || !level) return
      const groupKey = level.parentId ?? null
      const bucket = groups.get(groupKey)
      const entry: LevelEntry = { levelId, index: (level as any).level ?? 0, obj }
      if (bucket) bucket.push(entry)
      else groups.set(groupKey, [entry])
    })

    // Walk each group's sorted levels, accumulating base Y offsets locally
    for (const entries of groups.values()) {
      entries.sort((a, b) => a.index - b.index)
      let cumulativeY = 0
      for (const { levelId, index, obj } of entries) {
        const level = nodes[levelId as LevelNode['id']]
        const baseY = cumulativeY
        const explodedExtra = levelMode === 'exploded' ? index * EXPLODED_GAP : 0
        const targetY = baseY + explodedExtra

        obj.position.y = lerp(obj.position.y, targetY, delta * 12) // Smoothly animate to new Y position
        obj.visible = levelMode !== 'solo' || level?.id === selectedLevel || !selectedLevel

        cumulativeY += getLevelHeight(levelId, nodes)
      }
    }
  }, 5) // Using a lower priority so it runs after transforms from other systems have settled
  return null
}
