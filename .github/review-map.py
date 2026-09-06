from pathlib import Path
import re
root = Path.cwd()
def replace(path, old, new, count=1):
    p = root / path
    text = p.read_text()
    assert text.count(old) == count, (path, old[:100], text.count(old), count)
    p.write_text(text.replace(old, new))

a='src/components/Atlas.tsx'
replace(a, 'import {nextMapMode} from "@/lib/map-camera-mode";', 'import {DEFAULT_MAP_3D, nextMapMode} from "@/lib/map-camera-mode";')
replace(a, '[is3D, set3D] = useState(true)', '[is3D, set3D] = useState(DEFAULT_MAP_3D)')
replace(a, '  const visible3D=is3D&&(mapStatus.pitch??0)>5;\n', '')
replace(a, 'nextMapMode(is3D,mapStatus.pitch??0,mapStatus.zoom)', 'nextMapMode(is3D,mapStatus.zoom)')
replace(a, '      data-map-zoom={mapStatus.zoom}', '      data-map-mode={is3D ? "3d" : "2d"}\n      data-map-zoom={mapStatus.zoom}')
replace(a, 'label={visible3D ? "Перейти в 2D" : "Перейти в 3D"}', 'label={is3D ? "Перейти в 2D" : "Перейти в 3D"}\n          aria-pressed={is3D}')
replace(a, '<b>{visible3D ? "3D" : "2D"}</b>', '<b>{is3D ? "3D" : "2D"}</b>')
replace(a, ': "Объекты · объёмная архитектура"}', ': is3D ? "Объекты · объёмная архитектура" : "Объекты · контуры зданий"}')
replace(a, '      {appearance.life && (', '      {is3D && appearance.life && (')

m='src/components/AtlasMap.tsx'
replace(m, "import {naturalMapPitch} from '../lib/map-camera-mode';", "import {applyMapViewMode, naturalMapPitch} from '../lib/map-camera-mode';")
replace(m, """  setVisibility(map, ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs'], layers.buildings && props.is3D);
  setVisibility(map, ['atlas-building-flat'], layers.buildings && !props.is3D);
  setVisibility(map, ['atlas-building-purpose'], layers.buildings && !props.bankFocus);
  for (const id of ['atlas-building-3d', 'atlas-building-parts-3d', 'atlas-building-roofs', 'atlas-building-part-roofs']) if(map.getLayer(id)) map.setPaintProperty(id,'fill-extrusion-opacity',props.bankFocus ? 0.18 : 1);
  if(map.getLayer('atlas-building-flat')) map.setPaintProperty('atlas-building-flat','fill-opacity',props.bankFocus ? 0.16 : 0.9);""", """  applyMapViewMode(map, props.is3D, {
    buildings: layers.buildings, bankFocus: Boolean(props.bankFocus),
    maxPitch: map.getCanvas().clientWidth <= 760 || window.matchMedia('(pointer: coarse)').matches ? 60 : 75,
  });
  setVisibility(map, ['atlas-building-purpose'], layers.buildings && !props.bankFocus);""")
replace(m, 'maxPitch: mobile ? 60 : 75, minZoom:', 'maxPitch: latest.current.is3D ? mobile ? 60 : 75 : 0, minZoom:')
replace(m, 'touchPitch: true });', 'touchPitch: latest.current.is3D });')
replace(m, "      if (bounds) detailsRef.current?.setMobile(bounds.width <= 760 || window.matchMedia('(pointer: coarse)').matches);", """      if (bounds) {
        const compact = bounds.width <= 760 || window.matchMedia('(pointer: coarse)').matches;
        detailsRef.current?.setMobile(compact);
        if (loaded.current) applyMapViewMode(map, latest.current.is3D, {
          buildings: latest.current.layers.buildings, bankFocus: Boolean(latest.current.bankFocus), maxPitch: compact ? 60 : 75,
        });
      }""")

b='src/lib/building-materials.ts'
replace(b, '  const sunColor = `rgb(255,${mix(246, 191)},${mix(226, 130)})`;', """  // A warm directional highlight, not orange albedo. Neutral ambient fill
  // preserves white plaster, grey roofs and the source material distinctions.
  const sunColor = `rgb(255,${mix(251, 237)},${mix(246, 216)})`;
  // MapLibre has one global light rather than Three's separate sun/ambient.
  // Its tint affects even shaded faces, so use a softer mixed-light colour.
  const mapColor = `rgb(255,${mix(253, 246)},${mix(249, 237)})`;""")
replace(b, "return { sunColor, ambientColor: '#e8e8e2'", "return { sunColor, mapColor, ambientColor: '#e8e8e2'")
replace('src/lib/map-appearance.ts', 'color: light.sunColor, intensity: light.legacyIntensity', 'color: light.mapColor, intensity: light.legacyIntensity')

s='src/lib/map-solar-light.ts'
replace(s, 'const vertexSource = `#version 300 es', '// Geographic twilight is a subtle atmosphere, never a city-wide orange filter.\nexport const SOLAR_TWILIGHT_OPACITY = 0.04;\n\nconst vertexSource = `#version 300 es')
replace(s, """  float morning = smoothstep(-0.15, 0.15, dot(vec3(-sin(longitude), cos(longitude), 0.0), u_sun));
  vec3 warmColor = mix(vec3(0.91, 0.43, 0.20), vec3(1.0, 0.73, 0.49), morning);
  float warmAlpha = lowSun * (0.16 + 0.17 * u_spatial);""", """  vec3 warmColor = vec3(1.0, 0.91, 0.82);
  float warmAlpha = lowSun * u_spatial * ${SOLAR_TWILIGHT_OPACITY.toFixed(2)};""")
replace(s, '    gl.useProgram(this.program); gl.bindVertexArray(this.vao);', """    const spatial = spatialLightingAmount(this.map.getZoom());
    // City lighting is entirely material + sun + ambient. Do not composite a
    // second tint over roofs, water and roads (including the flat 2D view).
    if (spatial === 0) return;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);""")
replace(s, 'gl.uniform1f(this.uniforms.spatial, spatialLightingAmount(this.map.getZoom()));', 'gl.uniform1f(this.uniforms.spatial, spatial);')

for p in ['src/lib/map-landmarks.ts','src/lib/map-life.ts','src/lib/map-signal-scenes.ts']:
    replace(p,"import type { LightingState } from './solar';", "import type { LightingState } from './solar';\nimport { getBuildingLight } from './building-materials';")
replace('src/lib/map-landmarks.ts', '        if (lighting && entry.lighting !== lighting) {', '        if (lighting && entry.lighting !== lighting) {\n          const light = getBuildingLight(lighting);')
replace('src/lib/map-landmarks.ts', "sky.color.set(lighting.nightAmount > 0.5 ? '#7893b3' : '#eff7e8')", 'sky.color.set(light.ambientColor)')
replace('src/lib/map-landmarks.ts', "sun.color.set(lighting.sunElevation < 15 ? '#ffd0a0' : '#fff1d9')", 'sun.color.set(light.sunColor)')
replace('src/lib/map-landmarks.ts', "fill.color.set('#ffd5a2')", 'fill.color.set(light.ambientColor)')
life = (root/'src/lib/map-life.ts').read_text()
line = next(l for l in life.splitlines() if 'this.lastLighting = lighting;' in l and 'this.sun.color.set' in l)
line2 = line.replace('if (lighting !== this.lastLighting) {', 'if (lighting !== this.lastLighting) { const light = getBuildingLight(lighting);')
assert line2 != line
line2 = re.sub(r"this.sky.color.set\(lighting.nightAmount > 0.5 \? '[^']+' : '[^']+'\)", 'this.sky.color.set(light.ambientColor)', line2)
line2 = line2.replace("this.sun.color.set(lighting.sunElevation < 12 ? '#ffbd83' : '#ffefd9')", 'this.sun.color.set(light.sunColor)')
replace('src/lib/map-life.ts', line, line2)
scenes = (root/'src/lib/map-signal-scenes.ts').read_text()
line = next(l for l in scenes.splitlines() if 'entry.sun.color.set(lighting.sunElevation' in l)
line2 = '        const light = getBuildingLight(lighting);\n' + line
line2 = line2.replace("entry.sky.color.set(lighting.nightAmount > 0.5 ? '#9aaec5' : '#edf4e5')", 'entry.sky.color.set(light.ambientColor)')
line2 = line2.replace("entry.sun.color.set(lighting.sunElevation < 15 ? '#ffc997' : '#fff1db')", 'entry.sun.color.set(light.sunColor)')
line2 += '\n        entry.fill.color.set(light.ambientColor);'
replace('src/lib/map-signal-scenes.ts',line,line2)
