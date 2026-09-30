"use client";

/**
 * Condensate vapor, forked: a double domain warp, self-shadowed vapor and condensation beads,
 * whose steered lane splits in two, a fork of chain state. The seam colour lives only at the
 * split. The noise underneath is third-party (webgl-noise, MIT); see the notice above FRAG.
 *
 * Ported from the Condensate forkit page draft (forkit-fable-2026-09-29) as a React client
 * component, behaviour intact: a 30 fps cap, half resolution on phones, paused offscreen or when
 * the tab is hidden, one static frame for reduced motion, and a CSS gradient when WebGL is
 * missing. Two tint sets, light and dark (`uDark`), follow the site's colour scheme live: Vocs
 * sets data-vocs-theme on <html>, falling back to prefers-color-scheme.
 */
import { useEffect, useRef } from "react";

/*
 * mod289, permute and snoise below are the 2D simplex noise from webgl-noise (src/noise2D.glsl),
 * reformatted onto single lines:
 *
 *   Description : Array and textureless GLSL 2D simplex noise function.
 *        Author : Ian McEwan, Ashima Arts.
 *       License : Copyright (C) 2011 by Ashima Arts (Simplex noise)
 *                 Copyright (C) 2011-2016 by Stefan Gustavson (Classic noise and others)
 *                 Distributed under the MIT License.
 *                 https://github.com/ashima/webgl-noise
 *                 https://github.com/stegu/webgl-noise
 *
 * The full MIT licence text is in site/public/THIRD_PARTY_NOTICES.txt, which the build ships as
 * /forkit/THIRD_PARTY_NOTICES.txt. The notice is also kept inside the shader source, a string
 * that survives minification, so it travels with the bundled copy. fbm and everything after it
 * are forkit's own.
 */
const FRAG =
  "precision mediump float;uniform vec2 uRes;uniform float uT;uniform float uFork;uniform float uAlpha;uniform float uY;uniform float uDark;" +
  "/* 2D simplex noise (mod289, permute, snoise): webgl-noise, Copyright (C) 2011 Ashima Arts, Copyright (C) 2011-2016 Stefan Gustavson. MIT License. https://github.com/stegu/webgl-noise */" +
  "vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}" +
  "vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}" +
  "float snoise(vec2 v){const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);" +
  "vec2 i=floor(v+dot(v,C.yy));vec2 x0=v-i+dot(i,C.xx);vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);" +
  "vec4 x12=x0.xyxy+C.xxzz;x12.xy-=i1;i=mod289(i);vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));" +
  "vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0);m=m*m;m=m*m;" +
  "vec3 x=2.0*fract(p*C.www)-1.0;vec3 h=abs(x)-0.5;vec3 ox=floor(x+0.5);vec3 a0=x-ox;" +
  "m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);vec3 g;g.x=a0.x*x0.x+h.x*x0.y;g.yz=a0.yz*x12.xz+h.yz*x12.yw;return 130.0*dot(m,g);}" +
  "float fbm(vec2 p){float f=0.0,a=0.5;for(int i=0;i<5;i++){f+=a*snoise(p);p=p*2.03+vec2(11.7,-7.3);a*=0.5;}return f;}" +
  "void main(){vec2 uv=gl_FragCoord.xy/uRes;float asp=uRes.x/uRes.y;vec2 s=uv*vec2(asp,1.0);vec2 p=s*1.5;float t=uT*0.045;" +
  // condensation: vapor rises on a double domain warp, cools, and beads along the stream
  "vec2 rise=vec2(t*0.35,-t*0.7);vec2 q=vec2(fbm(p+rise),fbm(p+rise+vec2(5.2,1.3)));" +
  "vec2 r=vec2(fbm(p+1.6*q+vec2(1.7,9.2)-t*0.3),fbm(p+1.6*q+vec2(8.3,2.8)+t*0.2));" +
  "float drift=fbm(p+1.9*r+rise*0.6);float v=drift*0.5+0.5;" +
  "v+=0.06*(1.0-abs(2.0*v-1.0))*smoothstep(0.4,0.7,v);" +
  "float wisp=snoise(p*2.6+4.0*r-rise*1.4)*0.5+0.5;v=v+0.06*(wisp-0.5)*smoothstep(0.45,0.85,v);" +
  "float dl=fbm(p+1.9*r+rise*0.6+vec2(-0.22,0.30));float shade=clamp((drift-dl)*2.2,-1.0,1.0);" +
  // the fork: one stream from the left, splitting at xs into two branches
  "float xs=0.58*asp;float y0=uY+0.035*r.y+0.015*q.x;float open=smoothstep(xs,xs+0.40*asp,s.x);" +
  "float spread=0.19*open*open*(3.0-2.0*open)+0.01*r.x*open;" +
  "float dA=abs(s.y-(y0+spread));float dB=abs(s.y-(y0-spread));float dist=min(dA,dB);" +
  "float enter=smoothstep(0.24*asp,0.50*asp,s.x);" +
  "float lane=exp(-dist*dist*2600.0)*enter*uFork;float halo=exp(-dist*dist*220.0)*enter*uFork;float cloud=exp(-dist*dist*14.0)*enter;" +
  "float beadField=snoise(vec2(s.x*16.0-t*2.2+2.0*r.x,dist*60.0));" +
  "float bead=smoothstep(0.45,0.9,beadField)*lane*smoothstep(0.35,0.7,v);" +
  "float xg=xs+0.08*asp;float split=exp(-((s.x-xg)*(s.x-xg)*120.0+(s.y-y0)*(s.y-y0)*1100.0))*uFork;" +
  "float gather=mix(mix(0.30,0.55,uDark),1.0,cloud*uFork+(1.0-uFork));float n=smoothstep(0.62,1.05,v)*gather*0.7;float vapor=clamp(smoothstep(0.34,0.82,v)*gather+halo*0.30+lane*0.20,0.0,1.0);" +
  // the condensate palette: page ground, band, line, leaf
  "vec3 g=mix(vec3(1.0),vec3(0.047,0.055,0.067),uDark);vec3 t1=mix(vec3(0.91,0.92,0.94),vec3(0.13,0.15,0.21),uDark);vec3 t2=mix(vec3(0.78,0.80,0.84),vec3(0.21,0.25,0.33),uDark);vec3 th=mix(vec3(0.50,0.53,0.60),vec3(0.36,0.42,0.56),uDark);vec3 tl=mix(vec3(0.20,0.23,0.29),vec3(0.66,0.73,0.88),uDark);vec3 tb=mix(vec3(0.10,0.12,0.16),vec3(0.82,0.86,0.96),uDark);vec3 col=g;col=mix(col,t1,vapor);col=mix(col,t2,n);" +
  "col+=shade*vapor*mix(vec3(0.05,0.05,0.06),vec3(0.05,0.055,0.07),uDark);col-=max(-shade,0.0)*vapor*mix(vec3(0.04,0.04,0.05),vec3(0.02,0.02,0.03),uDark)*0.8;" +
  "col=mix(col,th,halo*0.6);col=mix(col,tl,lane*0.75);col=mix(col,tb,bead*0.7);" +
  // the seam, only where the stream splits: violet into cyan along the branch
  "float hue=clamp((s.x-xg)/(0.16*asp)+0.5,0.0,1.0);" +
  "vec3 seam=mix(vec3(0.647,0.227,0.992),vec3(0.071,0.518,0.988),hue);seam=mix(seam,vec3(0.0,0.929,0.988),smoothstep(0.55,1.0,hue));" +
  "col=mix(col,seam,clamp(split*(lane*1.1+halo*0.35),0.0,1.0));" +
  "float alpha=clamp(max(vapor,n)+halo*0.3+lane*0.5+bead*0.3,0.0,1.0)*0.9*uAlpha;gl_FragColor=vec4(col*alpha,alpha);}";

const VERT = "attribute vec2 a;void main(){gl_Position=vec4(a,0.,1.);}";

/** The page's colour scheme as Vocs sets it (data-vocs-theme on <html>), else the OS. */
function isDark(): boolean {
  const theme = document.documentElement.getAttribute("data-vocs-theme");
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

export interface VaporForkProps {
  /** 1 draws the forked stream, 0 plain vapor. */
  fork?: number;
  /** Overall opacity. */
  alpha?: number;
  /** Vertical position of the stream (0 bottom, 1 top), and on phones. */
  y?: number;
  yPhone?: number;
  className?: string;
}

export function VaporFork({
  fork = 1,
  alpha = 1,
  y = 0.5,
  yPhone = 0.13,
  className,
}: VaporForkProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (host === null || canvas === null) return;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phone = matchMedia("(max-width: 680px)").matches;
    const fallback = () => host.classList.add("is-static");

    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
    });
    if (gl === null) return fallback();
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type);
      if (s === null) return null;
      gl.shaderSource(s, source);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERT);
    const fs = shader(gl.FRAGMENT_SHADER, FRAG);
    const prog = gl.createProgram();
    if (vs === null || fs === null || prog === null) return fallback();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fallback();
    // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook.
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, "uRes");
    const uT = gl.getUniformLocation(prog, "uT");
    const uDark = gl.getUniformLocation(prog, "uDark");
    gl.uniform1f(gl.getUniformLocation(prog, "uFork"), fork);
    gl.uniform1f(gl.getUniformLocation(prog, "uAlpha"), alpha);
    gl.uniform1f(gl.getUniformLocation(prog, "uY"), phone ? yPhone : y);
    gl.uniform1f(uDark, isDark() ? 1 : 0);
    const seed = alpha * 37.0;
    let now = 0;

    const draw = (t: number) => {
      // Soft-masked fog: 1.25 dpr is enough on a desktop, half of that on a phone.
      const dpr = Math.min(devicePixelRatio || 1, 1.25) * (phone ? 0.5 : 1);
      const w = Math.round(canvas.clientWidth * dpr);
      const h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
      }
      gl.uniform2f(uRes, w, h);
      gl.uniform1f(uT, t + seed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };

    // Re-tint on a theme switch; with motion reduced, redraw the one static frame.
    const retint = () => {
      gl.uniform1f(uDark, isDark() ? 1 : 0);
      if (reduced) draw(0);
    };
    const themeObserver = new MutationObserver(retint);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-vocs-theme", "style"],
    });
    const schemeQuery = matchMedia("(prefers-color-scheme: dark)");
    schemeQuery.addEventListener("change", retint);
    const stopTheme = () => {
      themeObserver.disconnect();
      schemeQuery.removeEventListener("change", retint);
    };

    if (reduced) {
      draw(0);
      return stopTheme;
    }

    let visible = false;
    let last = 0;
    let raf = 0;
    const loop = (ms: number) => {
      raf = requestAnimationFrame(loop);
      if (ms - last < 33) return; // 30 fps
      last = ms;
      now = ms / 1000;
      draw(now);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (visible && !document.hidden) {
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    };
    const io = new IntersectionObserver((entries) => {
      visible = entries[0]?.isIntersecting ?? false;
      run();
    });
    io.observe(host);
    document.addEventListener("visibilitychange", run);
    return () => {
      stopTheme();
      io.disconnect();
      document.removeEventListener("visibilitychange", run);
      cancelAnimationFrame(raf);
    };
  }, [fork, alpha, y, yPhone]);

  return (
    <div ref={hostRef} className={`fk-vapor ${className ?? ""}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
