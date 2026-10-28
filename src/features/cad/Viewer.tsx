import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { syncFaces, syncLines } from 'replicad-threejs-helper'
import type { MeshedPart } from './cad.worker'

/** The model in 3D: drag to turn it, scroll to zoom, right-drag to move. Z is up, as in CAD; the
 *  grid is in millimetres (10 mm squares). `fit` changes when the camera should frame the model. */
export function Viewer({ parts, fit }: { parts: MeshedPart[]; fit: number }) {
  const box = useRef<HTMLDivElement>(null)
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; model: THREE.Group; render: () => void } | null>(null)

  useEffect(() => {
    const el = box.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(window.devicePixelRatio)
    el.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    THREE.Object3D.DEFAULT_UP.set(0, 0, 1)
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100_000)
    camera.up.set(0, 0, 1)
    camera.position.set(120, -160, 110)
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.4)
    sun.position.set(200, -150, 300)
    scene.add(sun)
    const grid = new THREE.GridHelper(400, 40, 0x666677, 0x33333d)
    grid.rotation.x = Math.PI / 2
    scene.add(grid)
    const model = new THREE.Group()
    scene.add(model)
    const controls = new OrbitControls(camera, renderer.domElement)
    const render = () => renderer.render(scene, camera)
    controls.addEventListener('change', render)
    const resize = () => {
      const { width, height } = el.getBoundingClientRect()
      if (!width || !height) return
      renderer.setSize(width, height)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      render()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    three.current = { renderer, scene, camera, controls, model, render }
    return () => {
      observer.disconnect()
      controls.dispose()
      model.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.() })
      renderer.dispose()
      renderer.domElement.remove()
      three.current = null
    }
  }, [])

  // The parts, drawn again whenever they change.
  useEffect(() => {
    const t = three.current
    if (!t) return
    t.model.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); (m.material as THREE.Material | undefined)?.dispose?.() })
    t.model.clear()
    for (const p of parts) {
      const faces = new THREE.BufferGeometry()
      syncFaces(faces, p.faces)
      t.model.add(new THREE.Mesh(faces, new THREE.MeshStandardMaterial({ color: p.color, metalness: 0.1, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 1, side: THREE.DoubleSide })))
      const edges = new THREE.BufferGeometry()
      syncLines(edges, p.edges)
      t.model.add(new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x1a1b26 })))
    }
    t.render()
  }, [parts])

  // Framing the model: the camera backs off to see all of it, looking at its middle.
  useEffect(() => {
    const t = three.current
    if (!t || !parts.length) return
    const b = new THREE.Box3()
    for (const p of parts) b.union(new THREE.Box3(new THREE.Vector3(...p.box[0]), new THREE.Vector3(...p.box[1])))
    const centre = b.getCenter(new THREE.Vector3())
    const size = b.getSize(new THREE.Vector3()).length() || 50
    const dir = t.camera.position.clone().sub(t.controls.target).normalize()
    t.controls.target.copy(centre)
    t.camera.position.copy(centre.clone().add(dir.multiplyScalar(size * 1.6)))
    t.camera.near = size / 100
    t.camera.far = size * 100
    t.camera.updateProjectionMatrix()
    t.controls.update()
    t.render()
  }, [fit])

  return <div className="cad-viewer" ref={box} />
}
