import { useEffect, useRef } from "react";
import * as THREE from "three";

// ── Colour palette matching app theme ────────────────────────────────
//   #424874  →  [0.259, 0.282, 0.455]  deep purple
//   #A6B1E1  →  [0.651, 0.694, 0.882]  medium lavender
//   #DCD6F7  →  [0.863, 0.839, 0.969]  light lavender
const PALETTE = [
  [0.259, 0.282, 0.455],  // #424874 deep purple
  [0.651, 0.694, 0.882],  // #A6B1E1 lavender
  [0.863, 0.839, 0.969],  // #DCD6F7 light lavender
  [1.000, 1.000, 1.000],  // white
  [1.000, 1.000, 1.000],  // white (duplicate for higher probability)
  [0.388, 0.400, 0.945],  // #6366f1 indigo
  [0.545, 0.361, 0.965],  // #8b5cf6 violet
  [1.000, 1.000, 1.000],  // white
];

export default function ParticleBackground() {
  const mountRef = useRef(null);

  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;

    const W = window.innerWidth;
    const H = window.innerHeight;
    const isMobile = W < 768;
    // Fewer particles — visible but not distracting
    const COUNT = isMobile ? 400 : 1200;

    // ── Renderer ─────────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:1;";
    el.appendChild(renderer.domElement);

    // ── Scene / Camera ────────────────────────────────────────────
    const scene  = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, W / H, 0.1, 100);
    camera.position.z = 5;

    // ── Buffers ───────────────────────────────────────────────────
    const positions = new Float32Array(COUNT * 3);
    const aSize     = new Float32Array(COUNT);
    const aRandom   = new Float32Array(COUNT);
    const aColor    = new Float32Array(COUNT * 3);

    for (let i = 0; i < COUNT; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 20;
      positions[i * 3 + 1] = (Math.random() - 0.5) * 16;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 4;
      aSize[i]             = Math.random() * 2.0 + 1.8; // 1.8–3.8px visible dots
      aRandom[i]           = Math.random();
      const c              = PALETTE[Math.floor(Math.random() * PALETTE.length)];
      aColor[i * 3]        = c[0];
      aColor[i * 3 + 1]    = c[1];
      aColor[i * 3 + 2]    = c[2];
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aSize",    new THREE.BufferAttribute(aSize,     1));
    geo.setAttribute("aRandom",  new THREE.BufferAttribute(aRandom,   1));
    geo.setAttribute("aColor",   new THREE.BufferAttribute(aColor,    3));

    // ── Vertex shader ─────────────────────────────────────────────
    const vertexShader = /* glsl */`
      uniform float uTime;
      uniform vec2  uMouse;
      uniform float uRepel;

      attribute float aSize;
      attribute float aRandom;
      attribute vec3  aColor;

      varying float vAlpha;
      varying vec3  vColor;

      /* ── Simplex 3D noise (inline) ────────────────────────── */
      vec3 _m3(vec3 x){return x-floor(x*(1./289.))*289.;}
      vec4 _m4(vec4 x){return x-floor(x*(1./289.))*289.;}
      vec4 _p(vec4 x){return _m4(((x*34.)+1.)*x);}
      vec4 _ti(vec4 r){return 1.79284291400159-0.85373472095314*r;}
      float snoise(vec3 v){
        const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
        vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
        vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;
        vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
        vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
        i=_m3(i);
        vec4 p=_p(_p(_p(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
        float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
        vec4 j=p-49.*floor(p*ns.z*ns.z);
        vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
        vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
        vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
        vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
        vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
        vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
        vec4 nm=_ti(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
        p0*=nm.x;p1*=nm.y;p2*=nm.z;p3*=nm.w;
        vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
        return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
      }
      /* ──────────────────────────────────────────────────────── */

      void main() {
        vec3  pos = position;
        float t   = uTime * 0.14;   // very slow drift

        // Gentle organic drift
        float f  = 0.16;
        pos.x   += snoise(vec3(pos.x*f, pos.y*f, t + aRandom*6.28)) * 0.40;
        pos.y   += snoise(vec3(pos.x*f+18.5, pos.y*f, t+aRandom*6.28)) * 0.40;

        // Cursor repulsion
        vec4  clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
        vec2  ndc  = clip.xy / clip.w;
        vec2  diff = ndc - uMouse;
        float dist = length(diff);
        float radius = 0.50;
        if (dist < radius && dist > 0.001) {
          float force = pow(1.0 - dist/radius, 2.2) * uRepel * 1.4;
          pos.xy += normalize(diff) * force * 0.9;
        }
        // Gentle idle gravity (stronger pull back to origin)
        pos.xy += normalize(-pos.xy+0.001) * (1.0-uRepel) * 0.08;

        // Point size
        vec4  mv   = modelViewMatrix * vec4(pos, 1.0);
        float dep  = clamp(1.3 + (-mv.z/8.0), 0.6, 2.0);
        float pulse = 1.0 + 0.18 * snoise(vec3(aRandom*6.0, 0., t*0.7));
        gl_PointSize = aSize * dep * pulse;
        gl_Position  = projectionMatrix * mv;

        // Higher base alpha — clearly visible on light background
        vAlpha = 0.52 + 0.28 * (0.5 + 0.5*snoise(vec3(aRandom*4.5, 0., t*0.9)));
        vColor = aColor;
      }
    `;

    // ── Fragment shader ───────────────────────────────────────────
    const fragmentShader = /* glsl */`
      varying float vAlpha;
      varying vec3  vColor;

      void main() {
        vec2  uv = gl_PointCoord - 0.5;
        float r  = length(uv);
        if (r > 0.5) discard;

        // Crisp core + soft glow
        float core = exp(-r*r*12.0);
        float halo = exp(-r*r*3.5) * 0.22;
        gl_FragColor = vec4(vColor, (core + halo) * vAlpha);
      }
    `;

    const mat = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      uniforms: {
        uTime:  { value: 0 },
        uMouse: { value: new THREE.Vector2(9999, 9999) },
        uRepel: { value: 0 },
      },
      transparent: true,
      depthWrite:  false,
      blending:    THREE.NormalBlending,
    });

    scene.add(new THREE.Points(geo, mat));

    // ── Mouse / touch ─────────────────────────────────────────────
    let repelTarget = 0, repelSmooth = 0, idleTimer = null;

    function onMove(cx, cy) {
      mat.uniforms.uMouse.value.set(
        (cx / window.innerWidth)  *  2 - 1,
        (cy / window.innerHeight) * -2 + 1
      );
      repelTarget = 1;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { repelTarget = 0; }, 140);
    }
    const onMouse = e => onMove(e.clientX, e.clientY);
    const onTouch = e => e.touches[0] && onMove(e.touches[0].clientX, e.touches[0].clientY);
    window.addEventListener("mousemove", onMouse);
    window.addEventListener("touchmove", onTouch, { passive: true });

    // ── Resize ────────────────────────────────────────────────────
    function onResize() {
      const w = window.innerWidth, h = window.innerHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    window.addEventListener("resize", onResize);

    // ── Render loop ───────────────────────────────────────────────
    let rafId;
    const clock = new THREE.Clock();
    function animate() {
      rafId = requestAnimationFrame(animate);
      mat.uniforms.uTime.value  = clock.getElapsedTime();
      repelSmooth += (repelTarget - repelSmooth) * 0.09;
      mat.uniforms.uRepel.value = repelSmooth;
      renderer.render(scene, camera);
    }
    animate();

    // ── Cleanup ───────────────────────────────────────────────────
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(idleTimer);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("touchmove", onTouch);
      window.removeEventListener("resize", onResize);
      renderer.dispose(); geo.dispose(); mat.dispose();
      if (el.contains(renderer.domElement)) el.removeChild(renderer.domElement);
    };
  }, []);

  return <div ref={mountRef} style={{ position:"fixed", inset:0, zIndex:1, pointerEvents:"none" }} />;
}
