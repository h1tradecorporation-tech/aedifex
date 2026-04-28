import {
  type CeilingNode,
  type LevelNode,
  sceneRegistry,
  useScene,
  type WallNode,
} from '@aedifex/core'

export const DEFAULT_LEVEL_HEIGHT = 2.5

// Cache: levelId → computed height. Invalidated when the nodes reference changes.
// Zustand produces a new `nodes` object on every mutation, so reference equality
// is a zero-cost way to detect stale data without any subscription overhead.
const heightCache = new Map<string, number>()
let lastNodesRef: object | null = null

export function getLevelHeight(
  levelId: string,
  nodes: ReturnType<typeof useScene.getState>['nodes'],
): number {
  if (nodes !== lastNodesRef) {
    heightCache.clear()
    lastNodesRef = nodes
  }

  if (heightCache.has(levelId)) return heightCache.get(levelId)!

  const level = nodes[levelId as LevelNode['id']] as LevelNode | undefined
  if (!level) return 0

  let maxTop = 0
  let hasContributingChild = false

  for (const childId of level.children) {
    const child = nodes[childId as keyof typeof nodes]
    if (!child) continue
    if (child.type === 'ceiling') {
      hasContributingChild = true
      const ch = (child as CeilingNode).height ?? DEFAULT_LEVEL_HEIGHT
      if (ch > maxTop) maxTop = ch
    } else if (child.type === 'wall') {
      hasContributingChild = true
      let meshY = sceneRegistry.nodes.get(childId as any)?.position.y ?? 0
      if (meshY < 0) meshY = 0
      const top = meshY + ((child as WallNode).height ?? DEFAULT_LEVEL_HEIGHT)
      if (top > maxTop) maxTop = top
    }
  }

  // Empty levels (no walls/ceilings) contribute zero height — they should not
  // create phantom gaps when stacking. Levels with children but zero numeric
  // height (e.g. unset values) still fall back to DEFAULT_LEVEL_HEIGHT so the
  // user-authored level remains visible.
  let height: number
  if (!hasContributingChild) {
    height = 0
  } else if (maxTop > 0) {
    height = maxTop
  } else {
    height = DEFAULT_LEVEL_HEIGHT
  }
  heightCache.set(levelId, height)
  return height
}

/**
 * Instantly snaps all level Objects3D to their true stacked Y positions
 * (ignores levelMode — always uses stacked, no exploded gap).
 *
 * Returns a restore function that reverts each level's Y to what it was
 * before the snap, so lerp animations in LevelSystem can continue undisturbed.
 *
 * Usage:
 *   const restore = snapLevelsToTruePositions()
 *   renderer.render(scene, camera)
 *   restore()
 */
export function snapLevelsToTruePositions(): () => void {
  const nodes = useScene.getState().nodes

  type LevelEntry = {
    obj: NonNullable<ReturnType<typeof sceneRegistry.nodes.get>>
    levelId: string
    index: number
  }

  // Group by parentId so each building stacks independently — mirrors
  // LevelSystem's grouping logic to keep render snapshots consistent.
  const groups = new Map<string | null, LevelEntry[]>()
  sceneRegistry.byType.level.forEach((levelId) => {
    const obj = sceneRegistry.nodes.get(levelId)
    const level = nodes[levelId as LevelNode['id']]
    if (!obj || !level) return
    const groupKey = level.parentId ?? null
    const entry: LevelEntry = { levelId, index: (level as any).level ?? 0, obj }
    const bucket = groups.get(groupKey)
    if (bucket) bucket.push(entry)
    else groups.set(groupKey, [entry])
  })

  const allEntries: LevelEntry[] = []
  for (const entries of groups.values()) {
    entries.sort((a, b) => a.index - b.index)
    allEntries.push(...entries)
  }

  // Snapshot current Y and visibility so we can restore them after the render
  const snapshot = new Map(
    allEntries.map(({ levelId, obj }) => [levelId, { y: obj.position.y, visible: obj.visible }]),
  )

  // Snap each group to true stacked positions starting from Y=0
  for (const entries of groups.values()) {
    let cumulativeY = 0
    for (const { levelId, obj } of entries) {
      obj.position.y = cumulativeY
      obj.visible = true
      cumulativeY += getLevelHeight(levelId, nodes)
    }
  }

  return () => {
    for (const { levelId, obj } of allEntries) {
      const saved = snapshot.get(levelId)
      if (saved !== undefined) {
        obj.position.y = saved.y
        obj.visible = saved.visible
      }
    }
  }
}
