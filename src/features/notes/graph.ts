/** Places notes for the graph view: linked notes pull together, all notes push apart. A plain
 *  force layout, run a fixed number of steps from a circle so the picture is the same each time. */
export function layoutGraph(ids: string[], edges: Array<[string, string]>, width: number, height: number, steps = 300) {
  const n = ids.length
  const index = new Map(ids.map((id, i) => [id, i]))
  const pos = ids.map((_, i) => {
    const angle = (i / Math.max(1, n)) * Math.PI * 2
    const r = Math.min(width, height) * 0.35
    return { x: width / 2 + Math.cos(angle) * r, y: height / 2 + Math.sin(angle) * r }
  })
  const links = edges.map(([a, b]) => [index.get(a), index.get(b)]).filter((e): e is [number, number] => e[0] !== undefined && e[1] !== undefined)
  const ideal = Math.max(40, Math.sqrt((width * height) / Math.max(1, n)) * 0.6)
  for (let step = 0; step < steps; step++) {
    const cool = 1 - step / steps
    const move = pos.map(() => ({ x: 0, y: 0 }))
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x || 0.01
        const dy = pos[i].y - pos[j].y || 0.01
        const d2 = dx * dx + dy * dy
        const force = (ideal * ideal) / Math.max(d2, 1)
        move[i].x += dx * force * 0.05; move[i].y += dy * force * 0.05
        move[j].x -= dx * force * 0.05; move[j].y -= dy * force * 0.05
      }
    }
    for (const [a, b] of links) {
      const dx = pos[b].x - pos[a].x
      const dy = pos[b].y - pos[a].y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const pull = (d - ideal) / d * 0.1
      move[a].x += dx * pull; move[a].y += dy * pull
      move[b].x -= dx * pull; move[b].y -= dy * pull
    }
    for (let i = 0; i < n; i++) {
      // Unlinked notes drift gently to the middle so they don't fly off.
      move[i].x += (width / 2 - pos[i].x) * 0.01
      move[i].y += (height / 2 - pos[i].y) * 0.01
      const len = Math.sqrt(move[i].x ** 2 + move[i].y ** 2)
      const limit = 20 * cool + 1
      const scale = len > limit ? limit / len : 1
      pos[i].x = Math.min(width - 20, Math.max(20, pos[i].x + move[i].x * scale))
      pos[i].y = Math.min(height - 20, Math.max(20, pos[i].y + move[i].y * scale))
    }
  }
  return new Map(ids.map((id, i) => [id, pos[i]]))
}
