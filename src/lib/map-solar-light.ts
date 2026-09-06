import type { CustomLayerInterface, CustomRenderMethodInput, Map as LibreMap } from 'maplibre-gl';

const vertexSource = `#version 300 es
in vec2 a_position;
uniform mat4 u_matrix;
out vec2 v_mercator;
void main() {
  v_mercator = a_position;
  gl_Position = u_matrix * vec4(a_position, 0.0, 1.0);
}`;

// Evaluate the sun at every map coordinate: the terminator stays attached to
// geography through pan, zoom and rotation, rather than to the screen edges.
const fragmentSource = `#version 300 es
precision highp float;
in vec2 v_mercator;
uniform vec3 u_sun;
uniform float u_spatial;
out vec4 fragColor;
void main() {
  float longitude = (v_mercator.x * 2.0 - 1.0) * 3.14159265359;
  float latitude = atan(sinh((1.0 - v_mercator.y * 2.0) * 3.14159265359));
  vec3 ground = vec3(cos(latitude) * cos(longitude), cos(latitude) * sin(longitude), sin(latitude));
  float elevation = degrees(asin(clamp(dot(ground, normalize(u_sun)), -1.0, 1.0)));
  float night = 1.0 - smoothstep(-8.0, 6.0, elevation);
  float lowSun = smoothstep(-12.0, -2.0, elevation) * (1.0 - smoothstep(5.0, 22.0, elevation));
  float morning = smoothstep(-0.15, 0.15, dot(vec3(-sin(longitude), cos(longitude), 0.0), u_sun));
  vec3 warmColor = mix(vec3(0.91, 0.43, 0.20), vec3(1.0, 0.73, 0.49), morning);
  float warmAlpha = lowSun * (0.16 + 0.17 * u_spatial);
  float nightAlpha = night * 0.76 * u_spatial;
  vec3 nightColor = vec3(0.045, 0.10, 0.18);
  float alpha = warmAlpha + nightAlpha * (1.0 - warmAlpha);
  vec3 premultiplied = warmColor * warmAlpha + nightColor * nightAlpha * (1.0 - warmAlpha);
  fragColor = vec4(premultiplied, alpha);
}`;

/** Blend into the local city lighting gradually; the country view is geographic. */
export function spatialLightingAmount(zoom: number) {
  const t = Math.max(0, Math.min(1, (zoom - 5.5) / 3.5));
  return 1 - t * t * (3 - 2 * t);
}

/** One GPU pass, two triangles; no per-region color steps or continuously running timer. */
export class SolarLightLayer implements CustomLayerInterface {
  readonly id = 'atlas-solar-light';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uniforms: { matrix: WebGLUniformLocation | null; sun: WebGLUniformLocation | null; spatial: WebGLUniformLocation | null } | null = null;
  private map: LibreMap | null = null;
  private sun: [number, number, number] = [1, 0, 0];

  setSun(sun: [number, number, number]) { this.sun = sun; }

  onAdd(map: LibreMap, gl: WebGL2RenderingContext) {
    this.map = map;
    const shaders: WebGLShader[] = [];
    try {
      for (const [kind, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
        const shader = gl.createShader(kind);
        if (!shader) throw new Error('Cannot allocate solar shader');
        shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || 'Solar shader compilation failed');
      }
      this.program = gl.createProgram();
      if (!this.program) throw new Error('Cannot allocate solar program');
      for (const shader of shaders) gl.attachShader(this.program, shader);
      gl.linkProgram(this.program);
      if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(this.program) || 'Solar shader link failed');
      this.uniforms = { matrix: gl.getUniformLocation(this.program, 'u_matrix'), sun: gl.getUniformLocation(this.program, 'u_sun'), spatial: gl.getUniformLocation(this.program, 'u_spatial') };
      this.buffer = gl.createBuffer(); this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao); gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
      // Include the unwrapped eastern edge of Russia across the antimeridian.
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 2, 0, 0, 1, 0, 1, 2, 0, 2, 1]), gl.STATIC_DRAW);
      const position = gl.getAttribLocation(this.program, 'a_position');
      gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null); gl.bindBuffer(gl.ARRAY_BUFFER, null);
    } catch (error) { this.onRemove(map, gl); throw error; }
    finally { for (const shader of shaders) gl.deleteShader(shader); }
  }

  render(gl: WebGL2RenderingContext, args: CustomRenderMethodInput) {
    if (!this.program || !this.uniforms || !this.map) return;
    gl.useProgram(this.program); gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(this.uniforms.matrix, false, args.defaultProjectionData.mainMatrix);
    gl.uniform3fv(this.uniforms.sun, this.sun);
    gl.uniform1f(this.uniforms.spatial, spatialLightingAmount(this.map.getZoom()));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  onRemove(_map: LibreMap, gl: WebGL2RenderingContext) {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.program = null; this.buffer = null; this.vao = null; this.uniforms = null; this.map = null;
  }
}
