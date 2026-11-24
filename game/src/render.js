// Handwritten WebGL 2 renderer — one shader program, three buffers
// (static city, dynamic cars, per-preset sky). No vendored engine.
import { STRIDE } from './mesh.js';

const VS = `
attribute vec3 aPos;
attribute vec3 aNor;
attribute vec3 aCol;
attribute vec3 aEmi;
attribute float aSpc;
attribute vec2 aUv;
attribute float aTex;
uniform mat4 uProj;
uniform mat4 uView;
varying vec3 vCol;
varying vec3 vEmi;
varying float vSpc;
varying vec3 vNor;
varying vec3 vWorld;
varying vec2 vUv;
varying float vTex;
void main() {
  vWorld = aPos;
  vCol = aCol;
  vEmi = aEmi;
  vSpc = aSpc;
  vNor = aNor;
  vUv = aUv;
  vTex = aTex;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}
`;

const FS = `
precision highp float;
varying vec3 vCol;
varying vec3 vEmi;
varying float vSpc;
varying vec3 vNor;
varying vec3 vWorld;
varying vec2 vUv;
varying float vTex;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uAmb;
uniform vec3 uFogCol;
uniform float uFogDen;
uniform float uEmisBoost;
uniform sampler2D uTex;
// headlight spotlight (the driven car): a warm cone that brightens the
// road and the car ahead. uHeadOn is the preset intensity (night 1.0,
// sunset 0.45, midday 0.12). uHeadCos is cos(half-angle of the cone).
uniform vec3 uHeadPos;
uniform vec3 uHeadDir;
uniform vec3 uHeadCol;
uniform float uHeadOn;
uniform float uHeadCos;
uniform float uHeadRange;
void main() {
  vec3 col;
  if (vSpc < -1.5) {
    // beam (spc -2): additive light volume. vEmi carries the
    // intensity-scaled colour; alpha is a smooth function of distance
    // along the beam (vUv.x = t, 0 at the car) and the lateral offset
    // (vUv.y = -1..1 across the ground pool), plus a fresnel term so
    // the cone's silhouette reads soft. No discrete rings anywhere.
    vec3 V = normalize(uCamPos - vWorld);
    float fres = pow(1.0 - abs(dot(normalize(vNor), V)), 2.0);
    float t = clamp(vUv.x, 0.0, 1.0);
    float lat = clamp(abs(vUv.y), 0.0, 1.0);
    float a = (1.0 - t) * (1.0 - t) * (1.0 - lat * lat) * (0.35 + 0.65 * fres);
    gl_FragColor = vec4(vEmi, a);
    return;
  }
  if (vSpc < -0.5) {
    // unlit: sky dome, sun, moon, stars — full colour, no fog
    col = vCol + vEmi;
  } else {
    vec3 N = normalize(vNor);
    float diff = max(dot(N, uSunDir), 0.0);
    vec3 V = normalize(uCamPos - vWorld);
    vec3 H = normalize(uSunDir + V + vec3(0.0001));
    float spec = pow(max(dot(N, H), 0.0), 28.0) * max(vSpc, 0.0);
    col = vCol * (uAmb + uSunCol * diff) + uSunCol * spec + vEmi * uEmisBoost;
    if (vTex > 0.5) {
      vec3 t = texture2D(uTex, vUv).rgb;
      col = mix(col, t * (0.45 + 0.55 * uEmisBoost), 0.85);
    }
    // headlight spotlight: brightens the road and the car ahead inside
    // the cone. The term is mostly additive (not a normal-dot diffuse)
    // so a grazing beam still reads on the asphalt. The 1.2 factor is
    // set so the lit asphalt reads +20 or more over the unlit road
    // (the Stage B pixel test) — strong enough to see by, not so
    // strong the road blows out.
    if (uHeadOn > 0.001) {
      vec3 L = vWorld - uHeadPos;
      float dist = length(L);
      if (dist < uHeadRange && dist > 0.01) {
        float ca = dot(L / dist, uHeadDir);
        if (ca > uHeadCos) {
          float angleF = smoothstep(uHeadCos, uHeadCos + 0.02, ca);
          float distF = 1.0 - dist / uHeadRange;
          distF *= distF;
          col += (vCol * 0.6 + vec3(1.0, 0.93, 0.72) * 0.4) * uHeadCol * uHeadOn * angleF * distF * 1.2;
        }
      }
    }
    float dist = distance(uCamPos, vWorld);
    float f = 1.0 - exp(-uFogDen * uFogDen * dist * dist);
    f = min(f, 0.72);
    col = mix(col, uFogCol, f);
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

function mat4Perspective(fovY, aspect, near, far) {
  const f = 1 / Math.tan(fovY / 2);
  const nf = 1 / (near - far);
  return new Float32Array([
    f / aspect, 0, 0, 0,
    0, f, 0, 0,
    0, 0, (far + near) * nf, -1,
    0, 0, 2 * far * near * nf, 0,
  ]);
}

function mat4LookAt(eye, target, up) {
  const zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let zl = Math.hypot(zx, zy, zz) || 1;
  const z = [zx / zl, zy / zl, zz / zl];
  let xx = up[1] * z[2] - up[2] * z[1];
  let xy = up[2] * z[0] - up[0] * z[2];
  let xz = up[0] * z[1] - up[1] * z[0];
  let xl = Math.hypot(xx, xy, xz) || 1;
  const x = [xx / xl, xy / xl, xz / xl];
  const y = [
    z[1] * x[2] - z[2] * x[1],
    z[2] * x[0] - z[0] * x[2],
    z[0] * x[1] - z[1] * x[0],
  ];
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]),
    -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
    -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]),
    1,
  ]);
}

function norm3(v) {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, antialias: true });
    if (!gl) throw new Error('WebGL2 not available');
    this.gl = gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, VS);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error('vertex shader: ' + gl.getShaderInfoLog(vs));
    }
    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, FS);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error('fragment shader: ' + gl.getShaderInfoLog(fs));
    }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('program link: ' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);
    this.prog = prog;
    this.attrib = {};
    for (const name of ['aPos', 'aNor', 'aCol', 'aEmi', 'aSpc', 'aUv', 'aTex']) {
      this.attrib[name] = gl.getAttribLocation(prog, name);
    }
    this.uniform = {};
    for (const name of ['uProj', 'uView', 'uCamPos', 'uSunDir', 'uSunCol', 'uAmb', 'uFogCol', 'uFogDen', 'uEmisBoost', 'uTex', 'uHeadPos', 'uHeadDir', 'uHeadCol', 'uHeadOn', 'uHeadCos', 'uHeadRange']) {
      this.uniform[name] = gl.getUniformLocation(prog, name);
    }
    this.buffers = {};
    this.counts = { static: 0, cars: 0, sky: 0, beam: 0, markers: 0, mara: 0 };
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0.1, 0.12, 0.2, 1);
    // default 1x1 white texture so textured draws never sample an empty unit
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.signTex = tex;
  }

  setSignTexture(tex) {
    this.signTex = tex;
  }

  _upload(key, mesh) {
    const gl = this.gl;
    if (!this.buffers[key]) this.buffers[key] = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
    this.counts[key] = mesh.count;
  }

  setStatic(mesh) { this._upload('static', mesh); }
  setCars(mesh) { this._upload('cars', mesh); }
  setSky(mesh) { this._upload('sky', mesh); }
  setBeam(mesh) { this._upload('beam', mesh); }
  setMarkers(mesh) { this._upload('markers', mesh); }
  setMara(mesh) { this._upload('mara', mesh); }

  _bind(key) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers[key]);
    const F = Float32Array.BYTES_PER_ELEMENT;
    const off = (i) => i * F;
    const stride = STRIDE * F;
    const a = this.attrib;
    gl.enableVertexAttribArray(a.aPos); gl.vertexAttribPointer(a.aPos, 3, gl.FLOAT, false, stride, off(0));
    gl.enableVertexAttribArray(a.aNor); gl.vertexAttribPointer(a.aNor, 3, gl.FLOAT, false, stride, off(3));
    gl.enableVertexAttribArray(a.aCol); gl.vertexAttribPointer(a.aCol, 3, gl.FLOAT, false, stride, off(6));
    gl.enableVertexAttribArray(a.aEmi); gl.vertexAttribPointer(a.aEmi, 3, gl.FLOAT, false, stride, off(9));
    gl.enableVertexAttribArray(a.aSpc); gl.vertexAttribPointer(a.aSpc, 1, gl.FLOAT, false, stride, off(12));
    gl.enableVertexAttribArray(a.aUv); gl.vertexAttribPointer(a.aUv, 2, gl.FLOAT, false, stride, off(13));
    gl.enableVertexAttribArray(a.aTex); gl.vertexAttribPointer(a.aTex, 1, gl.FLOAT, false, stride, off(15));
  }

  // head: null (no headlight) or {pos:[x,y,z], dir:[x,y,z], on:0..1}
  // — the driven car's spotlight. The beam/markers/mara buffers are
  // optional (count 0 = skipped).
  draw(cam, preset, head) {
    const gl = this.gl;
    const w = this.canvas.width, h = this.canvas.height;
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = mat4Perspective((60 * Math.PI) / 180, w / h, 0.5, 12000);
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
    const fwd = [Math.sin(cam.yaw) * cp, sp, -Math.cos(cam.yaw) * cp];
    const target = [cam.x + fwd[0], cam.y + fwd[1], cam.z + fwd[2]];
    const view = mat4LookAt([cam.x, cam.y, cam.z], target, [0, 1, 0]);
    const u = this.uniform;
    gl.uniformMatrix4fv(u.uProj, false, proj);
    gl.uniformMatrix4fv(u.uView, false, view);
    gl.uniform3fv(u.uCamPos, [cam.x, cam.y, cam.z]);
    gl.uniform3fv(u.uSunDir, norm3(preset.sunDir));
    gl.uniform3fv(u.uSunCol, preset.sunCol);
    gl.uniform3fv(u.uAmb, preset.amb);
    gl.uniform3fv(u.uFogCol, preset.fogCol);
    gl.uniform1f(u.uFogDen, preset.fogDen);
    gl.uniform1f(u.uEmisBoost, preset.emis);
    // headlight spotlight (off when no car is driven)
    if (head && head.on > 0.001) {
      gl.uniform3fv(u.uHeadPos, head.pos);
      gl.uniform3fv(u.uHeadDir, norm3(head.dir));
      gl.uniform3fv(u.uHeadCol, [1.0, 0.97, 0.85]);
      gl.uniform1f(u.uHeadOn, head.on);
      gl.uniform1f(u.uHeadCos, 0.975);
      gl.uniform1f(u.uHeadRange, 30);
    } else {
      gl.uniform1f(u.uHeadOn, 0);
      gl.uniform3fv(u.uHeadPos, [0, -100, 0]);
      gl.uniform3fv(u.uHeadDir, [0, 1, 0]);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.signTex);
    gl.uniform1i(u.uTex, 0);
    // sky first, no depth write/test
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    this._bind('sky');
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.sky);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    // city, then cars, Mara, markers (all opaque)
    this._bind('static');
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.static);
    this._bind('cars');
    gl.drawArrays(gl.TRIANGLES, 0, this.counts.cars);
    if (this.counts.mara > 0) {
      this._bind('mara');
      gl.drawArrays(gl.TRIANGLES, 0, this.counts.mara);
    }
    if (this.counts.markers > 0) {
      this._bind('markers');
      gl.drawArrays(gl.TRIANGLES, 0, this.counts.markers);
    }
    // beam last: additive, depth-tested (occluded by buildings/cars),
    // no depth write (never occludes anything itself)
    if (this.counts.beam > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.depthMask(false);
      this._bind('beam');
      gl.drawArrays(gl.TRIANGLES, 0, this.counts.beam);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }
}
