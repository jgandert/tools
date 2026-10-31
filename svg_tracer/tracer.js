// Copyright 2026 Joschua Gandert - SPDX-License-Identifier: Apache-2.0
/* Dependency-free, topology-aware flat-color raster vectorizer.
 * createTracer() is self-contained so it can also run inside a Blob Worker.
 * Coordinates/tolerances use WORKING raster pixels, not the original image size.
 */
function createTracer() {
  'use strict';
  const TAU = 2 * Math.PI, EPS = 1e-8;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const sq = v => v * v;
  const dist2 = (a, b) => sq(a.x - b.x) + sq(a.y - b.y);
  const dist = (a, b) => Math.sqrt(dist2(a, b));
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const same = (a, b) => dist2(a, b) < 1e-16;
  // Dyadic rounding preserves shared coordinates exactly in decimal SVG output.
  const snap = x => Math.round(x * 65536) / 65536;
  const point = (x, y) => ({x: snap(x), y: snap(y)});
  const fmt = x => String(Object.is(x, -0) ? 0 : x);
  const xy = p => `${fmt(p.x)} ${fmt(p.y)}`;
  const area = p => { let a = 0; for (let i = 0; i < p.length - 1; i++) a += p[i].x*p[i+1].y - p[i+1].x*p[i].y; return a / 2; };
  const line = (a, b) => ({type: 'L', a, b});
  const reverse = s => s.type === 'L' ? line(s.b, s.a) : s.type === 'C' ?
    {type: 'C', a: s.b, c1: s.c2, c2: s.c1, b: s.a} :
    {...s, a: s.b, b: s.a, sweep: 1 - s.sweep, start: s.start + s.delta, delta: -s.delta};
  function project(p, a, b) {
    const den = dist2(a,b), t = den ? clamp(((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/den,0,1) : 0;
    const q = {x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)};
    return {q,t,d:dist(p,q)};
  }
  function solve(A, b) {
    const n=b.length, m=A.map((r,i)=>[...r,b[i]]);
    for(let j=0;j<n;j++) {
      let k=j; for(let i=j+1;i<n;i++) if(Math.abs(m[i][j])>Math.abs(m[k][j])) k=i;
      if(Math.abs(m[k][j])<1e-12) return null;
      [m[j],m[k]]=[m[k],m[j]];
      const z=m[j][j]; for(let c=j;c<=n;c++) m[j][c]/=z;
      for(let i=0;i<n;i++) if(i!==j) { const f=m[i][j]; for(let c=j;c<=n;c++) m[i][c]-=f*m[j][c]; }
    }
    return m.map(r=>r[n]);
  }
  function leastSquares(rows, values, n) {
    const A=Array.from({length:n},()=>Array(n).fill(0)), b=Array(n).fill(0);
    for(let k=0;k<rows.length;k++) for(let i=0;i<n;i++) {
      b[i]+=rows[k][i]*values[k];
      for(let j=0;j<n;j++) A[i][j]+=rows[k][i]*rows[k][j];
    }
    return solve(A,b);
  }
  const linear = Float64Array.from({length:256},(_,i)=>i/255<=.04045 ? i/255/12.92 : ((i/255+.055)/1.055)**2.4);
  function lab(r,g,b) {
    r=linear[r];g=linear[g];b=linear[b];
    const l=Math.cbrt(.4122214708*r+.5363325363*g+.0514459929*b);
    const m=Math.cbrt(.2119034982*r+.6806995451*g+.1073969566*b);
    const s=Math.cbrt(.0883024619*r+.2817188376*g+.6299787005*b);
    return [.2104542553*l+.793617785*m-.0040720468*s,
      1.9779984951*l-2.428592205*m+.4505937099*s,
      .0259040371*l+.7827717662*m-.808675766*s];
  }
  const cd = (a,b) => sq(a[0]-b[0])+sq(a[1]-b[1])+sq(a[2]-b[2]);
  const hex = rgb => '#'+rgb.map(v=>clamp(Math.round(v),0,255).toString(16).padStart(2,'0')).join('');

  function prepare(data,w,h,noise) {
    const n=w*h, rgb=new Uint8Array(n*3), opaque=new Uint8Array(n), alpha=new Uint8Array(n);
    for(let p=0;p<n;p++) { alpha[p]=data[4*p+3];opaque[p]=alpha[p]>=128?1:0; for(let c=0;c<3;c++) rgb[3*p+c]=data[4*p+c]; }
    if(noise<=0) return {rgb,opaque,alpha};
    // A range-gated local average, not a spatial blur across contrasting fills.
    const out=new Uint8Array(rgb), sigma=6*noise*noise;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++) {
      const p=y*w+x,i=p*3; if(!opaque[p]) continue;
      let sr=rgb[i],sg=rgb[i+1],sb=rgb[i+2],sw=1;
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) {
        if((!dx&&!dy)||x+dx<0||x+dx>=w||y+dy<0||y+dy>=h) continue;
        const q=p+dy*w+dx,j=q*3; if(!opaque[q]) continue;
        const d=sq(rgb[j]-rgb[i])+sq(rgb[j+1]-rgb[i+1])+sq(rgb[j+2]-rgb[i+2]);
        if(d>sigma*4) continue;
        const wt=Math.exp(-d/sigma)*(dx&&dy?.5:.75);
        sr+=wt*rgb[j];sg+=wt*rgb[j+1];sb+=wt*rgb[j+2];sw+=wt;
      }
      out[i]=Math.round(sr/sw);out[i+1]=Math.round(sg/sw);out[i+2]=Math.round(sb/sw);
    }
    return {rgb:out,opaque,alpha};
  }
  function quantize(rgb,opaque,w,h,kWanted,noise,preserveDetails=true,alpha=null,sourceData=null) {
    const n=w*h, bins=new Map(), step=1;
    // Prefer flat interior samples. Edge mixtures should not become extra paints.
    // Auto needs stricter flat-core evidence; explicit counts admit more of
    // the tiny or low-contrast paints before applying the requested count.
    const threshold=kWanted?Math.max(18,noise*2.2):Math.max(8,Math.min(16,noise*1.2));
    function sampleWeight(p) {
      const i=p*3,x=p%w,y=Math.floor(p/w); let variation=0;
      for(const [dx,dy] of [[-2,0],[2,0],[0,-2],[0,2]]) {
        if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h) continue;
        const q=p+dy*w+dx; if(!opaque[q]) { variation=255;continue; }
        const j=q*3; variation=Math.max(variation,Math.abs(rgb[i]-rgb[j]),Math.abs(rgb[i+1]-rgb[j+1]),Math.abs(rgb[i+2]-rgb[j+2]));
      }
      return variation<=threshold?1:(kWanted?.015:.005);
    }
    for(let p=0;p<n;p+=step) if(opaque[p]) {
      const i=p*3,wt=sampleWeight(p);
      const key=(rgb[i]>>3)*1024+(rgb[i+1]>>3)*32+(rgb[i+2]>>3);
      let b=bins.get(key); if(!b) {b={w:0,s:[0,0,0],squared:0};bins.set(key,b);}
      b.w+=wt;for(let c=0;c<3;c++) b.s[c]+=wt*rgb[i+c];
      if(kWanted)b.squared+=wt*(sq(rgb[i])+sq(rgb[i+1])+sq(rgb[i+2]));
    }
    if(!bins.size) return {palette:[],labels:new Int16Array(n).fill(-1)};
    if(kWanted) {
      // Refine only the strongest varying buckets. Each contains at most 512
      // exact RGB values, so 64 requested paints add at most 32,768 samples.
      const varying=[...bins.values()].map(b=>({b,spread:b.squared-b.s.reduce((s,v)=>s+v*v,0)/b.w}));
      varying.sort((a,b)=>b.spread-a.spread);
      const refined=varying.slice(0,kWanted).filter(({spread})=>spread>.001);
      for(const {b} of refined)b.fine=new Map();
      if(refined.length)for(let p=0;p<n;p+=step)if(opaque[p]) {
        const i=p*3,key=(rgb[i]>>3)*1024+(rgb[i+1]>>3)*32+(rgb[i+2]>>3),fine=bins.get(key).fine;
        if(!fine)continue;
        const exact=rgb[i]*65536+rgb[i+1]*256+rgb[i+2],wt=sampleWeight(p);
        let b=fine.get(exact);if(!b){b={w:0,s:[0,0,0]};fine.set(exact,b);}
        b.w+=wt;for(let c=0;c<3;c++)b.s[c]+=wt*rgb[i+c];
      }
    }
    const samples=[...bins.values()].flatMap(b=>b.fine?[...b.fine.values()]:[b]).map(b=>{const rgb=b.s.map(x=>Math.round(x/b.w));return {w:b.w,rgb,v:lab(...rgb)};});
    samples.sort((a,b)=>b.w-a.w);
    const total=samples.reduce((s,b)=>s+b.w,0), maxK=Math.min(kWanted||16,samples.length);
    let centers=[samples[0].v.slice()], best=null;
    for(let k=1;k<=maxK;k++) {
      for(let it=0;it<18;it++) {
        const sums=centers.map(()=>[0,0,0,0]);let movement=0;
        for(const s of samples) {
          let j=0,d=Infinity;for(let c=0;c<centers.length;c++) {const e=cd(s.v,centers[c]);if(e<d){d=e;j=c;}}
          s.cluster=j;s.err=d;const t=sums[j];t[3]+=s.w;for(let c=0;c<3;c++)t[c]+=s.w*s.v[c];
        }
        centers=centers.map((c,j)=>{
          if(!sums[j][3])return c;const v=sums[j].slice(0,3).map(t=>t/sums[j][3]);movement+=cd(c,v);return v;
        });
        if(movement<1e-10)break;
      }
      let error=0;const mass=centers.map(()=>0);
      for(const s of samples) {let j=0,d=Infinity;for(let c=0;c<centers.length;c++){const e=cd(s.v,centers[c]);if(e<d){d=e;j=c;}}
        s.cluster=j;s.err=d;error+=s.w*d;mass[j]+=s.w;}
      // Explicit model-size penalty, deliberately conservative about tiny accents.
      const objective=error+total*.000055*k+mass.reduce((v,m)=>v+(m<total*.0008?total*.0001:0),0);
      if(!best||objective<best.score||kWanted) best={centers:centers.map(c=>c.slice()),score:objective,error};
      if(k===maxK)break;
      let seed=null,score=-1;
      for(const s of samples){const v=s.err*Math.sqrt(s.w);if(v>score){score=v;seed=s.v;}}
      if(score<1e-12)break;
      centers.push(seed.slice());
    }
    centers=best.centers;
    // Robust channel medians of inlier interiors resist JPEG halos and ringing.
    const hist=centers.map(()=>Array.from({length:3},()=>new Float64Array(256))), weights=centers.map(()=>0);
    for(const s of samples) {
      let j=0,d=Infinity;for(let c=0;c<centers.length;c++){const e=cd(s.v,centers[c]);if(e<d){d=e;j=c;}}
      if(d>.0036)continue;weights[j]+=s.w;for(let c=0;c<3;c++)hist[j][c][s.rgb[c]]+=s.w;
    }
    const palette=centers.map((v,j)=>{
      const rgb=hist[j].map(arr=>{let acc=0;for(let i=0;i<256;i++){acc+=arr[i];if(acc>=weights[j]/2)return i;}return 0;});
      if(!weights[j]) {let s=samples.reduce((a,b)=>cd(a.v,v)<cd(b.v,v)?a:b);rgb.splice(0,3,...s.rgb);}
      if(rgb.every(x=>x<=3))rgb.fill(0);if(rgb.every(x=>x>=252))rgb.fill(255);
      return {rgb,lab:lab(...rgb),hex:hex(rgb)};
    });
    // Merge numerically identical paints, even if an excessive count was requested.
    for(let i=palette.length-1;i>=0;i--)if(palette.findIndex(p=>p.hex===palette[i].hex)!==i)palette.splice(i,1);
    // A small paint or a one-pixel outline may have no 5-by-5 flat core.
    // Recover coherent local evidence separately, rather than lowering the
    // global color-count penalty and promoting every JPEG fringe to a paint.
    const sourceAliases=[];
    let recoveredPaints=preserveDetails?recoverDetailPaints(rgb,opaque,w,h,palette,noise,!kWanted,alpha,sourceData,sourceAliases):0;
    const labels=new Int16Array(n).fill(-1);
    for(let p=0;p<n;p++)if(opaque[p]) {
      const v=lab(rgb[3*p],rgb[3*p+1],rgb[3*p+2]);
      let d=Infinity,j=0;for(let c=0;c<palette.length;c++){const e=cd(v,palette[c].lab);if(e<d){d=e;j=c;}}
      labels[p]=j;
    }
    // Perceptual nearest paint is NOT a valid antialias decoder. A black/white
    // mixture can be closer to blue in Oklab than to either endpoint. Resolve
    // uncertain pixels using only paints supported by nearby confident pixels.
    const correction=resolveMixtures(rgb,opaque,labels,palette,w,h,noise);
    const folded=foldSourceAliases(rgb,labels,palette,correction,sourceAliases,w);
    recoveredPaints-=folded.removed;
    return {palette:folded.palette,labels,recoveredPaints,...correction};
  }
  function recoverDetailPaints(rgb,opaque,w,h,palette,noise,allowNew=true,alpha=null,sourceData=null,sourceAliases=[]) {
    const startingPaints=palette.length,sourceEstimates=[];
    const bins=new Map(),gate=Math.max(4,Math.min(14,noise*.8)),minSeparation=.0008;
    const nearPaint=Math.max(7,Math.min(16,noise*1.2));
    const similar=(p,q)=>opaque[q]&&Math.max(Math.abs(rgb[p*3]-rgb[q*3]),Math.abs(rgb[p*3+1]-rgb[q*3+1]),Math.abs(rgb[p*3+2]-rgb[q*3+2]))<=gate;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++) {
      const p=y*w+x;if(!opaque[p])continue;
      const horizontal=similar(p,p-1)&&similar(p,p+1),vertical=similar(p,p-w)&&similar(p,p+w);
      const diagonal=similar(p,p-w-1)&&similar(p,p+w+1),other=similar(p,p-w+1)&&similar(p,p+w-1);
      if(!horizontal&&!vertical&&!diagonal&&!other)continue;
      const core=horizontal&&vertical&&diagonal&&other;
      const r=rgb[p*3],g=rgb[p*3+1],b=rgb[p*3+2],key=(r>>3)*1024+(g>>3)*32+(b>>3);
      let bin=bins.get(key);
      if(!bin) {
        bin={count:0,core:0,footprintSupport:0,alphaSupport:0,s:[0,0,0]};
        bins.set(key,bin);
      }
      if(allowNew&&bin.footprintSupport<6) {
        let interior=true;
        let isolated=true;
        for(let dy=-3;dy<=3;dy++) {
          for(let dx=-3;dx<=3;dx++) {
            if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h||!opaque[p+dy*w+dx])interior=false;
            else if(!similar(p,p+dy*w+dx))isolated=false;
            if(!interior&&!isolated)break;
          }
          if(!interior&&!isolated)break;
        }
        if(interior||isolated)bin.footprintSupport++;
      }
      if(allowNew&&sourceData) {
        bin.sourceSum||=[0,0,0];
        bin.sourceCoreSum||=[0,0,0];
        for(let c=0;c<3;c++) {
          bin.sourceSum[c]+=sourceData[p*4+c];
          if(core)bin.sourceCoreSum[c]+=sourceData[p*4+c];
        }
      }
      bin.count++;
      bin.core+=core?1:0;
      bin.s[0]+=r;
      bin.s[1]+=g;
      bin.s[2]+=b;
    }
    // Real silhouette strokes also supply their paint through the alpha ramp.
    // An opaque matte fringe lacks that independent evidence. Very low alpha
    // has unstable unpremultiplied RGB and is deliberately excluded.
    if(allowNew&&alpha)for(let p=0;p<opaque.length;p++)if(!opaque[p]&&alpha[p]>=32) {
      const key=(rgb[p*3]>>3)*1024+(rgb[p*3+1]>>3)*32+(rgb[p*3+2]>>3);
      const bin=bins.get(key);
      if(bin)bin.alphaSupport++;
    }
    let recovered=0;
    const candidates=[...bins.values()].filter(b=>b.core>=1&&b.count>=6||b.count>=18).sort((a,b)=>(b.core*4+b.count)-(a.core*4+a.count));
    // Modal directional samples also improve an already discovered stroke
    // paint: averaging many partially covered outline pixels makes it too light.
    const modes=palette.map(()=>null);
    const paintBins=new Set(),sharedPaintBins=new Set();
    if(!allowNew)for(const {rgb} of palette) {
      const key=(rgb[0]>>3)*1024+(rgb[1]>>3)*32+(rgb[2]>>3);
      if(paintBins.has(key))sharedPaintBins.add(key);
      paintBins.add(key);
    }
    const protectedPaints=palette.map(({rgb})=>sharedPaintBins.has((rgb[0]>>3)*1024+(rgb[1]>>3)*32+(rgb[2]>>3)));
    for(const bin of candidates) {
      const rgb=bin.s.map(v=>Math.round(v/bin.count)),v=lab(...rgb);let best=Infinity,id=-1;
      // A coarse modal average cannot replace either of two distinct paints
      // that an explicit count has already separated inside that bucket.
      const key=(rgb[0]>>3)*1024+(rgb[1]>>3)*32+(rgb[2]>>3);
      if(sharedPaintBins.has(key))continue;
      for(let j=0;j<palette.length;j++){const d=cd(v,palette[j].lab);if(d<best){best=d;id=j;}}
      // A fringe in another bucket must not overwrite a separated target either.
      if(id<0||best>.0081||protectedPaints[id])continue;
      const score=bin.core*2+bin.count;
      if(!modes[id]||score>modes[id].score)modes[id]={rgb,score};
    }
    for(let i=0;i<palette.length;i++)if(modes[i]) {
      const rgb=modes[i].rgb;if(rgb.every(x=>x<=3))rgb.fill(0);if(rgb.every(x=>x>=252))rgb.fill(255);
      palette[i]={rgb,lab:lab(...rgb),hex:hex(rgb)};
    }
    if(!allowNew)return 0;
    // A small true paint core outranks a longer coreless JPEG color fringe.
    for(const bin of [...candidates].sort((a,b)=>!!b.core-!!a.core||(b.core*4+b.count)-(a.core*4+a.count))) {
      if(palette.length>=32)break;
      // Directional plateaus at a transparent silhouette can be opaque RGB
      // fringes left by prior compositing. Require evidence inside the opaque
      // footprint or in an isolated mark before promoting additional paints.
      // Internal narrow outlines still qualify without a flat color core.
      if(bin.footprintSupport<6&&bin.alphaSupport<6)continue;
      const rgb=bin.s.map(v=>Math.round(v/bin.count));
      // Normalize before checking separation so near-black cores cannot add a
      // second black paint after the palette already contains black.
      if(rgb.every(x=>x<=3))rgb.fill(0);if(rgb.every(x=>x>=252))rgb.fill(255);
      const v=lab(...rgb);
      if(palette.some(p=>cd(p.lab,v)<minSeparation||rgb.every((value,channel)=>Math.abs(value-p.rgb[channel])<=nearPaint)))continue;
      let residual=Infinity;
      for(let i=0;i<palette.length;i++)for(let j=i+1;j<palette.length;j++) {
        const a=palette[i].rgb,b=palette[j].rgb,d=b.map((x,c)=>x-a[c]),den=d.reduce((s,x)=>s+x*x,0);
        if(!den)continue;const t=clamp(rgb.reduce((s,x,c)=>s+(x-a[c])*d[c],0)/den,0,1);
        residual=Math.min(residual,rgb.reduce((s,x,c)=>s+sq(x-a[c]-t*d[c]),0));
      }
      // A directional plateau alone is not sufficient evidence: edge mixtures
      // must remain mixtures. A genuine compact flat core can disambiguate it.
      if(residual<3*sq(Math.max(7,noise))&&bin.core<4)continue;
      if(bin.core<1&&residual<3*sq(Math.max(14,noise*2.5)))continue;
      if(bin.sourceSum) {
        const sum=bin.core>=4?bin.sourceCoreSum:bin.sourceSum;
        const mass=bin.core>=4?bin.core:bin.count;
        sourceEstimates[palette.length]=sum.map(value=>Math.round(value/mass));
      }
      palette.push({rgb,lab:lab(...rgb),hex:hex(rgb)});
      recovered++;
    }

    // Verify filtered support against the original pixels, but keep each new
    // shade through mixture resolution so removing it cannot move other labels.
    // Fold qualifying shades into their source-supported base paint afterward.
    const basePaints=palette.slice(0,startingPaints);
    for(let i=palette.length-1;i>=startingPaints;i--) {
      const source=sourceEstimates[i];
      if(!source)continue;
      if(source.every(value=>value<=3))source.fill(0);
      if(source.every(value=>value>=252))source.fill(255);
      const sourceLab=lab(...source),qualified=[];
      for(let j=0;j<startingPaints;j++) {
        const distance=cd(basePaints[j].lab,sourceLab);
        if(distance<minSeparation||source.every((value,channel)=>Math.abs(value-basePaints[j].rgb[channel])<=nearPaint)) qualified.push({j,distance});
      }
      qualified.sort((a,b)=>a.distance-b.distance||a.j-b.j);
      if(qualified.length)sourceAliases.push({index:i,target:qualified[0].j});
    }
    return recovered;
  }

  function resolveMixtures(rgb,opaque,labels,palette,w,h,noise) {
    const n=w*h,k=palette.length,seed=new Int16Array(n).fill(-1),direct=new Int16Array(n).fill(-1),directError=new Float32Array(n);
    const separation=palette.map((a,i)=>{
      let d=Infinity;for(let j=0;j<k;j++)if(j!==i)d=Math.min(d,a.rgb.reduce((s,v,c)=>s+sq(v-palette[j].rgb[c]),0));
      return d;
    });
    const radius2=3*sq(Math.max(10,noise*1.6)),uncertain=[],mixtures=new Map();
    let relabeledPixels=0;
    for(let p=0;p<n;p++)if(opaque[p]) {
      let best=Infinity,win=0;
      for(let j=0;j<k;j++) {
        const c=palette[j].rgb,d=sq(rgb[3*p]-c[0])+sq(rgb[3*p+1]-c[1])+sq(rgb[3*p+2]-c[2]);
        if(d<best){best=d;win=j;}
      }
      direct[p]=win;directError[p]=best;
      if(best<=Math.min(radius2,separation[win]*.04)) {
        seed[p]=win;if(labels[p]!==win)relabeledPixels++;labels[p]=win;
      } else uncertain.push(p);
    }
    const near=new Float64Array(k),nearPixel=new Int32Array(k);let threePaintPixels=0,weakPaintPixels=0;
    for(const p of uncertain) {
      const x=p%w,y=Math.floor(p/w);near.fill(Infinity);nearPixel.fill(-1);
      for(const radius of [3,6,12]) {
        for(let dy=-radius;dy<=radius;dy++)for(let dx=-radius;dx<=radius;dx++) {
          if(x+dx<0||x+dx>=w||y+dy<0||y+dy>=h)continue;
          const j=seed[p+dy*w+dx];if(j<0)continue;
          const dd=dx*dx+dy*dy;if(dd<near[j]){near[j]=dd;nearPixel[j]=p+dy*w+dx;}
        }
        if(near.filter(Number.isFinite).length>=2)break;
      }
      const candidates=[];for(let j=0;j<k;j++)if(Number.isFinite(near[j]))candidates.push(j);
      if(!candidates.length)continue;
      let score=Infinity,win=labels[p];
      const v=[rgb[3*p],rgb[3*p+1],rgb[3*p+2]];
      for(let u=0;u<candidates.length;u++) {
        const a=candidates[u],A=palette[a].rgb;
        const single=v.reduce((s,x,c)=>s+sq(x-A[c]),0)+near[a]*3;
        if(single<score){score=single;win=a;}
        for(let z=u+1;z<candidates.length;z++) {
          const b=candidates[z],B=palette[b].rgb,d=B.map((x,c)=>x-A[c]);
          const den=d.reduce((s,x)=>s+x*x,0);if(!den)continue;
          const t=clamp(v.reduce((s,x,c)=>s+(x-A[c])*d[c],0)/den,0,1);
          const e=v.reduce((s,x,c)=>s+sq(x-A[c]-t*d[c]),0)+3*(near[a]+near[b]);
          if(e<score){score=e;win=t<.5?a:b;}
        }
      }
      // Thin outlines and T-junctions can put three real paints in ONE pixel.
      // A two-paint-only decoder can erase that outline even with a good palette.
      // Admit an interior barycentric solution only when nearby paint evidence
      // and the RGB residual support it; do not extrapolate outside the triangle.
      const local=candidates.slice().sort((a,b)=>near[a]-near[b]).slice(0,5);let mixture=null;
      for(let i=0;i<local.length;i++)for(let j=i+1;j<local.length;j++)for(let z=j+1;z<local.length;z++) {
        const ids=[local[i],local[j],local[z]],A=palette[ids[0]].rgb,B=palette[ids[1]].rgb,C=palette[ids[2]].rgb;
        const u=B.map((x,c)=>x-A[c]),d=C.map((x,c)=>x-A[c]),q=v.map((x,c)=>x-A[c]);
        let uu=0,dd=0,ud=0,uq=0,dq=0;
        for(let c=0;c<3;c++){uu+=u[c]*u[c];dd+=d[c]*d[c];ud+=u[c]*d[c];uq+=u[c]*q[c];dq+=d[c]*q[c];}
        const det=uu*dd-ud*ud;if(det<uu*dd*.003)continue;
        const b=(uq*dd-dq*ud)/det,c=(dq*uu-uq*ud)/det,a=1-b-c,weights=[a,b,c];
        if(weights.some(t=>t<.025||t>.95))continue;
        const residual=q.reduce((s,x,i)=>s+sq(x-b*u[i]-c*d[i]),0);
        const sorted=ids.map(id=>near[id]).sort((a,b)=>a-b);
        const error=residual+3*sorted[0]+1.5*sorted[1]+sorted[2]+12;
        if(error>=score)continue;
        const dominant=weights.indexOf(Math.max(...weights));
        score=error;win=ids[dominant];mixture={paints:ids.map((color,i)=>({color,weight:weights[i],seed:nearPixel[color]})),residual};
      }
      // A narrow stroke can have no nearly pure seed within the search radius.
      // Do not force its pixels into a demonstrably worse mixture of unrelated
      // neighbors. Require coherent local RGB-nearest evidence AND a substantial
      // residual advantage. Black/white mixtures still beat a spurious blue
      // assignment, even when perceptual nearest-color happens to prefer blue.
      const candidate=direct[p];
      if(!Number.isFinite(near[candidate])&&directError[p]+3*sq(Math.max(9,noise))<score) {
        let support=0;
        for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if((dx||dy)&&x+dx>=0&&x+dx<w&&y+dy>=0&&y+dy<h&&direct[p+dy*w+dx]===candidate)support++;
        if(support>=2){win=candidate;mixture=null;weakPaintPixels++;}
      }
      if(mixture){mixtures.set(p,mixture);threePaintPixels++;}
      if(win!==labels[p]){labels[p]=win;relabeledPixels++;}
    }
    return {relabeledPixels,uncertainPixels:uncertain.length,threePaintPixels,weakPaintPixels,mixtures};
  }

  function foldSourceAliases(rgb,labels,palette,correction,aliases,w) {
    const targets=new Map(aliases.map(({index,target})=>[index,target]));
    if(!targets.size)return {palette,removed:0};
    const remap=new Int16Array(palette.length),compacted=[];
    for(let old=0;old<palette.length;old++) {
      const target=targets.get(old);
      if(target!==undefined)remap[old]=remap[target];
      else {remap[old]=compacted.length;compacted.push(palette[old]);}
    }
    // Palette folding is separate from the local decoder's reassignment count.
    for(let p=0;p<labels.length;p++)if(labels[p]>=0)labels[p]=remap[labels[p]];
    const mixtures=new Map();
    for(const [p,mix] of correction.mixtures) {
      const byColor=new Map();
      for(const item of mix.paints) {
        const color=remap[item.color],previous=byColor.get(color);
        if(previous) {
          previous.weight+=item.weight;
          const oldDx=previous.seed%w-p%w,oldDy=Math.floor(previous.seed/w)-Math.floor(p/w);
          const newDx=item.seed%w-p%w,newDy=Math.floor(item.seed/w)-Math.floor(p/w);
          if(newDx*newDx+newDy*newDy<oldDx*oldDx+oldDy*oldDy)previous.seed=item.seed;
        }
        else byColor.set(color,{color,weight:item.weight,seed:item.seed});
      }
      const paints=[...byColor.values()];
      if(paints.length<2)continue;
      const weight=paints.reduce((sum,item)=>sum+item.weight,0);
      for(const item of paints)item.weight/=weight;
      let residual=0;
      for(let c=0;c<3;c++) {
        let predicted=0;
        for(const item of paints)predicted+=item.weight*compacted[item.color].rgb[c];
        residual+=sq(rgb[3*p+c]-predicted);
      }
      mixtures.set(p,{paints,residual});
    }
    correction.mixtures=mixtures;
    correction.threePaintPixels=[...mixtures.values()].filter(mix=>mix.paints.length===3).length;
    return {palette:compacted,removed:targets.size};
  }

  function refineSourceOwnership(data, labels, ids, faces, palette, width, height, noise, mixtures) {
    if (noise <= 0) return 0;

    const largest = new Map();
    for (const face of faces) largest.set(face.color, Math.max(largest.get(face.color) || 0, face.size));
    const candidates = faces.map((face) =>
      face.color >= 0 && face.size < largest.get(face.color) ? {face, opaque: true, groups: new Map()} : null,
    );
    for (let pixel = 0; pixel < labels.length; pixel++) {
      const candidate = candidates[ids[pixel]];
      if (!candidate) continue;
      if (data[pixel * 4 + 3] !== 255) candidate.opaque = false;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const neighbors = new Set();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
          const color = labels[pixel + dy * width + dx];
          if (color !== candidate.face.color) neighbors.add(color);
        }
      }
      if (neighbors.size !== 2 || [...neighbors].some((color) => color < 0)) continue;
      const pair = [...neighbors].sort((a, b) => a - b);
      const key = pair.join(",");
      let group = candidate.groups.get(key);
      if (!group) {
        group = {pair, pixels: []};
        candidate.groups.set(key, group);
      }
      group.pixels.push(pixel);
    }
    const active = candidates.filter((candidate) => candidate?.opaque && candidate.groups.size);
    if (!active.length) return 0;

    const errors = palette.map(() => new Map());
    const exactSamples = new Uint32Array(palette.length);
    for (const candidate of active) candidate.errors = new Map();
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const pixel = y * width + x;
        const id = ids[pixel];
        const color = labels[pixel];
        if (
          color < 0 ||
          data[pixel * 4 + 3] !== 255 ||
          ids[pixel - 1] !== id ||
          ids[pixel + 1] !== id ||
          ids[pixel - width] !== id ||
          ids[pixel + width] !== id
        )
          continue;
        const rgb = palette[color].rgb;
        const error = sq(data[pixel * 4] - rgb[0]) + sq(data[pixel * 4 + 1] - rgb[1]) + sq(data[pixel * 4 + 2] - rgb[2]);
        if (error === 0) exactSamples[color]++;
        else errors[color].set(error, (errors[color].get(error) || 0) + 1);
        const local = candidates[id]?.errors;
        if (local) local.set(error, (local.get(error) || 0) + 1);
      }
    }
    for (let color = 0; color < palette.length; color++) if (exactSamples[color]) errors[color].set(0, exactSamples[color]);

    // Estimate each paint separately so abundant backgrounds cannot swamp a rare paint.
    // Trimming the upper tail is empirical noise handling, not an error bound.
    function referenceTail(histogram, exclude) {
      const bins = [];
      let total = 0;
      for (const [error, count] of histogram) {
        const weight = count - (exclude?.get(error) || 0);
        if (weight <= 0) continue;
        total += weight;
        bins.push([error, weight]);
      }
      if (total < 20) return null;
      bins.sort((a, b) => a[0] - b[0]);
      let weight = 0;
      for (const [error, count] of bins) {
        weight += count;
        if (weight >= Math.ceil(total * 0.95)) return error;
      }
    }
    const tails = errors.map((histogram) => referenceTail(histogram));
    const rgbError = (a, b) => a.reduce((sum, value, channel) => sum + sq(value - b[channel]), 0);
    const product = (a, b) => a.reduce((sum, value, channel) => sum + value * b[channel], 0);
    function segmentFit(point, a, b) {
      const direction = b.map((value, channel) => value - a[channel]);
      const denominator = product(direction, direction);
      const t = denominator
        ? clamp(
            product(
              point.map((value, channel) => value - a[channel]),
              direction,
            ) / denominator,
            0,
            1,
          )
        : 0;
      return {
        t,
        error: rgbError(
          point,
          a.map((value, channel) => value + t * direction[channel]),
        ),
      };
    }
    function triangleError(point, a, b, c) {
      const u = b.map((value, channel) => value - a[channel]);
      const v = c.map((value, channel) => value - a[channel]);
      const q = point.map((value, channel) => value - a[channel]);
      const uu = product(u, u);
      const vv = product(v, v);
      const uv = product(u, v);
      const uq = product(u, q);
      const vq = product(v, q);
      const determinant = uu * vv - uv * uv;
      let error = Math.min(segmentFit(point, a, b).error, segmentFit(point, a, c).error, segmentFit(point, b, c).error);
      if (determinant > 1e-10) {
        const x = (uq * vv - vq * uv) / determinant;
        const y = (vq * uu - uq * uv) / determinant;
        if (x >= 0 && y >= 0 && x + y <= 1)
          error = Math.min(
            error,
            rgbError(
              point,
              a.map((value, channel) => value + x * u[channel] + y * v[channel]),
            ),
          );
      }
      return error;
    }
    const changes = [];
    for (const candidate of active) {
      const color = candidate.face.color;
      const tailC = candidate.errors.size ? referenceTail(errors[color], candidate.errors) : tails[color];
      if (tailC === null) continue;
      const C = palette[color].rgb;
      for (const group of candidate.groups.values()) {
        const [a, b] = group.pair;
        if (tails[a] === null || tails[b] === null) continue;
        const A = palette[a].rgb;
        const B = palette[b].rgb;
        const quality = Math.max(3, tails[a], tails[b]);
        const advantage = Math.max(quality, tailC);
        const fits = group.pixels.map((pixel) => {
          const point = [data[pixel * 4], data[pixel * 4 + 1], data[pixel * 4 + 2]];
          return {pixel, point, ...segmentFit(point, A, B)};
        });
        if (fits.reduce((sum, fit) => sum + fit.error, 0) / fits.length > quality) continue;

        // C can own a three-paint pixel with only one third of its coverage.
        // Keep ties and compare against every mixture where C has the largest weight.
        const midA = C.map((value, channel) => (value + A[channel]) / 2);
        const midB = C.map((value, channel) => (value + B[channel]) / 2);
        const center = C.map((value, channel) => (value + A[channel] + B[channel]) / 3);
        for (const fit of fits) {
          if (fit.error > quality) continue;
          const retainedError = Math.min(triangleError(fit.point, C, midA, midB), triangleError(fit.point, midA, center, midB));
          if (retainedError - fit.error <= advantage) continue;
          changes.push([fit.pixel, fit.t < 0.5 ? a : b]);
        }
      }
    }
    if (!changes.length) return 0;
    const changed = new Set();
    for (const [pixel, color] of changes) {
      labels[pixel] = color;
      changed.add(pixel);
    }
    for (const [pixel, mixture] of mixtures) {
      if (changed.has(pixel) || mixture.paints.some((paint) => changed.has(paint.seed))) mixtures.delete(pixel);
    }
    return changes.length;
  }
  function components(labels,w,h) {
    const n=w*h,ids=new Int32Array(n).fill(-1),queue=new Int32Array(n),list=[];
    for(let p=0;p<n;p++)if(ids[p]<0) {
      const id=list.length,color=labels[p];let head=0,tail=1;queue[0]=p;ids[p]=id;
      let sx=0,sy=0,touch=false;
      while(head<tail) {
        const q=queue[head++],x=q%w,y=Math.floor(q/w);sx+=x+.5;sy+=y+.5;
        if(!x||!y||x===w-1||y===h-1)touch=true;
        const add=r=>{if(ids[r]<0&&labels[r]===color){ids[r]=id;queue[tail++]=r;}};
        if(x)add(q-1);if(x+1<w)add(q+1);if(y)add(q-w);if(y+1<h)add(q+w);
      }
      list.push({id,color,size:tail,touch,seed:p,cx:sx/tail,cy:sy/tail});
    }
    return {ids,list};
  }
  function removeSpeckles(labels,w,h,minArea,palette,preserveDetails=false) {
    let removed=0;
    if(minArea<=1)return removed;
    for(let pass=0;pass<3;pass++) {
      const {ids,list}=components(labels,w,h),adj=new Map();
      const extent=new Map();
      if(preserveDetails)for(let p=0;p<labels.length;p++) {
        const c=list[ids[p]];if(c.color<0||c.size>=minArea)continue;
        let box=extent.get(c.id);if(!box){box=[w,h,0,0];extent.set(c.id,box);}
        const x=p%w,y=Math.floor(p/w);box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
      }
      for(const c of list)if(c.size<minArea&&c.color>=0) {
        const box=extent.get(c.id),length=box?Math.max(box[2]-box[0]+1,box[3]-box[1]+1):0;
        // An elongated connected mark is less likely to be a compression speck.
        if(preserveDetails&&c.size>=3&&length>=4&&length*length>=c.size*3)continue;
        adj.set(c.id,new Map());
      }
      if(!adj.size)break;
      const meet=(a,b)=>{if(a===b)return;for(const [u,v] of [[a,b],[b,a]])if(adj.has(u)){const m=adj.get(u);m.set(v,(m.get(v)||0)+1);}};
      for(let y=0;y<h;y++)for(let x=0;x<w;x++){const p=y*w+x;if(x+1<w)meet(ids[p],ids[p+1]);if(y+1<h)meet(ids[p],ids[p+w]);}
      const replace=new Map();
      for(const [a,m] of adj) {
        let winner=-1,best=-Infinity;
        for(const [b,edges] of m) {
          // Only merge uphill in size (and deterministically on ties): no cycles.
          if(list[b].size<list[a].size||(list[b].size===list[a].size&&b>a))continue;
          const color=list[b].color,delta=color<0?1:cd(palette[list[a].color].lab,palette[color].lab);
          const score=edges/(1+delta*2);if(score>best){winner=b;best=score;}
        }
        if(winner>=0)replace.set(a,winner);
      }
      if(!replace.size)break;
      const target=a=>{let k=0;while(replace.has(a)&&k++<list.length)a=replace.get(a);return list[a].color;};
      for(let p=0;p<labels.length;p++)if(replace.has(ids[p])){labels[p]=target(ids[p]);removed++;}
    }
    return removed;
  }
  function graphOf(ids,w,h,faces) {
    const nodes=new Map(),edges=[];
    const node=(x,y)=>{const id=y*(w+1)+x;let n=nodes.get(id);if(!n){n={id,x,y,original:point(x,y),p:point(x,y),out:[]};nodes.set(id,n);}return n;};
    const add=(x1,y1,x2,y2,right,left)=>{
      if(right===left)return;
      if(edges.length>=450000)throw Error('Too many boundaries. Increase noise cleanup, reduce colors, or reduce the working size.');
      const a=node(x1,y1),b=node(x2,y2),id=edges.length;
      const e={id,a,b,right,left};edges.push(e);a.out.push(id*2);b.out.push(id*2+1);
    };
    for(let y=0;y<=h;y++)for(let x=0;x<w;x++)add(x,y,x+1,y,y<h?ids[y*w+x]:-1,y?ids[(y-1)*w+x]:-1);
    for(let x=0;x<=w;x++)for(let y=0;y<h;y++)add(x,y,x,y+1,x?ids[y*w+x-1]:-1,x<w?ids[y*w+x]:-1);
    if(edges.length>450000)throw Error('Too many boundaries. Increase noise cleanup, reduce colors, or reduce the working size.');
    const start=h=>h&1?edges[h>>1].b:edges[h>>1].a;
    const end=h=>h&1?edges[h>>1].a:edges[h>>1].b;
    const right=h=>h&1?edges[h>>1].left:edges[h>>1].right;
    for(const n of nodes.values())n.out.sort((a,b)=>{
      const p=end(a),q=end(b);return Math.atan2(p.y-n.y,p.x-n.x)-Math.atan2(q.y-n.y,q.x-n.x);
    });
    const next=h=>{const v=end(h),i=v.out.indexOf(h^1);return v.out[(i+v.out.length-1)%v.out.length];};
    const isAnchor=n=>n.out.length!==2||((n.x===0||n.x===w)&&(n.y===0||n.y===h));
    const used=new Uint8Array(edges.length),map=new Int32Array(edges.length*2).fill(-1),chains=[];
    function walk(h0) {
      const cid=chains.length,hs=[],raw=[start(h0).original];let he=h0;
      do {
        if(used[he>>1])break;used[he>>1]=1;hs.push(he);raw.push(end(he).original);
        const n=end(he);if(isAnchor(n))break;
        he=n.out[0]===(he^1)?n.out[1]:n.out[0];
      }while(he!==h0);
      const first=hs[0],last=hs[hs.length-1],a=start(first),b=end(last),r=right(first),l=right(first^1);
      const c={id:cid,raw,a,b,closed:a===b,freeLoop:a===b&&!isAnchor(a),first,last,right:r,left:l,guide:null,primitive:null,segments:null};
      for(const hh of hs){map[hh]=cid*2;map[hh^1]=cid*2+1;}
      chains.push(c);
    }
    for(const n of nodes.values())if(isAnchor(n))for(const hh of n.out)if(!used[hh>>1])walk(hh);
    for(let e=0;e<edges.length;e++)if(!used[e])walk(2*e);
    const successor=new Int32Array(chains.length*2);
    for(const c of chains){successor[2*c.id]=map[next(c.last)];successor[2*c.id+1]=map[next(c.first^1)];}
    const seen=new Uint8Array(chains.length*2),loops=Array.from({length:faces.length},()=>[]);
    for(let h0=0;h0<seen.length;h0++)if(!seen[h0]) {
      const c=chains[h0>>1],face=h0&1?c.left:c.right,ring=[];let he=h0;
      do {
        if(he<0||seen[he])throw Error('Boundary graph is not a closed planar subdivision.');
        seen[he]=1;ring.push(he);he=successor[he];
      }while(he!==h0);
      if(face>=0)loops[face].push(ring);
    }
    return {nodes,edges,chains,loops,w,h};
  }
  function sampleBoundaries(g,rgb,faces,palette,alpha,mixtures=new Map()) {
    // The integer-grid contour determines topology, not the curve's control
    // points. Locate the half-coverage crossing between adjacent pixel centers.
    // Consecutive samples lie in a common dual-grid cell, so their polygonal
    // connection preserves the graph. Every junction is still one shared node.
    for(const c of g.chains) {
      if(c.right<0||c.left<0||c.raw.length<4) {c.samples=c.raw;continue;}
      const cr=faces[c.right].color,cl=faces[c.left].color;
      const transparent=cr<0||cl<0;
      if(cr===cl) {c.samples=c.raw;continue;}
      const R=cr<0?[0,0,0]:palette[cr].rgb,L=cl<0?[0,0,0]:palette[cl].rgb,D=R.map((v,i)=>v-L[i]),den=D.reduce((s,v)=>s+v*v,0);
      const samples=[];let mixedSamples=0;
      for(let i=1;i<c.raw.length;i++) {
        const a=c.raw[i-1],b=c.raw[i],mx=(a.x+b.x)/2,my=(a.y+b.y)/2,nx=a.y-b.y,ny=b.x-a.x;
        const r=Math.floor(my+.5*ny)*g.w+Math.floor(mx+.5*nx),l=Math.floor(my-.5*ny)*g.w+Math.floor(mx-.5*nx);
        const coverage=p=>{
          if(transparent)return cr<0?1-alpha[p]/255:alpha[p]/255;
          const mix=mixtures.get(p);
          if(mix&&mix.paints.some(q=>q.color===cr)&&mix.paints.some(q=>q.color===cl)) {
            let value=0;
            for(const q of mix.paints) {
              // The third paint can lie beyond a narrow outline on either side
              // of this interface. Its reliable local sample determines that
              // side; count its coverage there rather than treating it as noise.
              const side=q.color===cr?1:q.color===cl?-1:((q.seed%g.w+.5-mx)*nx+(Math.floor(q.seed/g.w)+.5-my)*ny);
              if(side>0)value+=q.weight;
            }
            return value;
          }
          return D.reduce((s,v,j)=>s+(rgb[3*p+j]-L[j])*v,0)/den;
        };
        const ar=coverage(r),al=coverage(l);
        if(ar>.025&&ar<.975||al>.025&&al<.975)mixedSamples++;
        // Bad unmixing or a multi-color junction must not move a crossing out
        // of its cell. Those ambiguous cases stay on the integer-grid border.
        let t=ar>al+.05?clamp((.5-al)/(ar-al),.02,.98):.5;
        // Antialias values describe pixel AREA coverage, not point samples.
        // Invert a square-pixel/straight-edge model near reliable edges. In
        // particular, a single partially covered pixel locates an axis-aligned
        // edge without the systematic bias of interpolating two pixel centers.
        // Alpha supplies the coverage at transparent edges; RGB there is not
        // interpreted as a mixture with an imaginary black background.
        if(ar>al+.05) {
          const pa=sampleOffset(c.raw,i-1,-3,c.freeLoop),pb=sampleOffset(c.raw,i,3,c.freeLoop),tangent=unit(pb.x-pa.x,pb.y-pa.y);
          let normal={x:-tangent.y,y:tangent.x},alignment=normal.x*nx+normal.y*ny;
          if(alignment<0){normal={x:-normal.x,y:-normal.y};alignment=-alignment;}
          let sum=0,weight=0;
          const incoming=unit(mx-pa.x,my-pa.y),outgoing=unit(pb.x-mx,pb.y-my);
          if(alignment>.38&&incoming.x*outgoing.x+incoming.y*outgoing.y>.86)for(const [p,a,offset] of [[r,ar,.5],[l,al,-.5]])if(a>.025&&a<.975) {
            const residual=transparent?0:mixtures.has(p)?mixtures.get(p).residual:D.reduce((s,v,j)=>s+sq(rgb[3*p+j]-L[j]-a*v),0);
            if(residual>3*sq(Math.max(9,g.noise||0)*1.6))continue;
            const candidate=offset-boxCoverageDistance(a,Math.abs(normal.x),Math.abs(normal.y))/alignment;
            const wt=a*(1-a);sum+=wt*candidate;weight+=wt;
          }
          if(weight)t=clamp(.5+sum/weight,.02,.98);
        }
        samples.push(point(mx+(t-.5)*nx,my+(t-.5)*ny));
        if(transparent)g.alphaSamples=(g.alphaSamples||0)+1;
      }
      if(c.freeLoop)samples.push(samples[0]);
      else {samples.unshift(c.a.original);samples.push(c.b.original);}
      // A genuinely binary, pixel-aligned boundary has no subpixel evidence.
      // Retain its exact lattice corners instead of replacing them by edge
      // midpoints (which rounds tiny rectangles and biases support-line fits).
      c.samples=mixedSamples?samples:c.raw;
    }
  }
  function boxCoverageDistance(coverage,a,b) {
    if(a<b)[a,b]=[b,a];
    if(b<1e-6)return a*(coverage-.5);
    const tail=b/(2*a);
    if(coverage<tail)return -(a+b)/2+Math.sqrt(2*a*b*coverage);
    if(coverage>1-tail)return (a+b)/2-Math.sqrt(2*a*b*(1-coverage));
    return a*(coverage-.5);
  }

  function ringPoints(ring,chains,key='raw') {
    const out=[];
    for(const he of ring){let p=chains[he>>1][key];if(he&1)p=p.slice().reverse();for(let i=0;i<p.length-1;i++)out.push(p[i]);}
    if(out.length)out.push(out[0]);return out;
  }
  function rdpIndices(p,tol) {
    const keep=new Uint8Array(p.length);keep[0]=keep[p.length-1]=1;
    const stack=[[0,p.length-1]];
    while(stack.length){const [a,b]=stack.pop();let md=tol,k=-1;
      for(let i=a+1;i<b;i++){const d=project(p[i],p[a],p[b]).d;if(d>md){md=d;k=i;}}
      if(k>=0){keep[k]=1;stack.push([a,k],[k,b]);}}
    return [...keep.keys()].filter(i=>keep[i]);
  }
  function fitLineTLS(p,anchor=null) {
    let x=0,y=0;for(const q of p){x+=q.x;y+=q.y;}x/=p.length;y/=p.length;
    if(anchor) {
      x=anchor.x;
      y=anchor.y;
    }
    let xx=0,xy=0,yy=0;for(const q of p){xx+=sq(q.x-x);xy+=(q.x-x)*(q.y-y);yy+=sq(q.y-y);}
    const theta=.5*Math.atan2(2*xy,xx-yy),dx=Math.cos(theta),dy=Math.sin(theta);
    let max=0,err=0;for(const q of p){const d=Math.abs(-(q.x-x)*dy+(q.y-y)*dx);max=Math.max(max,d);err+=d*d;}
    return {x,y,dx,dy,max,rms:Math.sqrt(err/p.length)};
  }
  function intersection(a,b) {
    const den=a.dx*b.dy-a.dy*b.dx;if(Math.abs(den)<1e-6)return null;
    const t=((b.x-a.x)*b.dy-(b.y-a.y)*b.dx)/den;
    return point(a.x+t*a.dx,a.y+t*a.dy);
  }
  const polylineTrees=new WeakMap();
  function nearestPolyline(q,p,pointOut=null) {
    if(p.length<80) {
      let d=Infinity;
      for(let i=1;i<p.length;i++) {
        const hit=project(q,p[i-1],p[i]);
        if(hit.d<d) {
          d=hit.d;
          if(pointOut){pointOut.x=hit.q.x;pointOut.y=hit.q.y;}
        }
      }
      return d;
    }
    let root=polylineTrees.get(p);
    if(!root) {
      const build=(lo,hi)=>{
        let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
        for(let i=lo;i<=hi;i++){minX=Math.min(minX,p[i].x);minY=Math.min(minY,p[i].y);maxX=Math.max(maxX,p[i].x);maxY=Math.max(maxY,p[i].y);}
        const node={lo,hi,minX,minY,maxX,maxY};
        if(hi-lo>8){const mid=(lo+hi)>>1;node.left=build(lo,mid);node.right=build(mid,hi);}return node;
      };
      root=build(0,p.length-1);polylineTrees.set(p,root);
    }
    let best=Infinity,bestIndex=Infinity;
    const distance=n=>sq(Math.max(n.minX-q.x,0,q.x-n.maxX))+sq(Math.max(n.minY-q.y,0,q.y-n.maxY));
    const visit=n=>{
      if(distance(n)>best)return;
      if(!n.left) {
        for(let i=n.lo+1;i<=n.hi;i++) {
          const hit=project(q,p[i-1],p[i]),d2=hit.d*hit.d;
          if(d2<best||(pointOut&&d2===best&&i-1<bestIndex)) {
            best=d2;bestIndex=i-1;
            if(pointOut){pointOut.x=hit.q.x;pointOut.y=hit.q.y;}
          }
        }
        return;
      }
      let a=n.left,b=n.right;if(distance(a)>distance(b))[a,b]=[b,a];visit(a);visit(b);
    };
    visit(root);return Math.sqrt(best);
  }
  function bidirectionalError(raw,poly,tol) {
    let max=0,sum=0;
    for(const q of raw){const d=nearestPolyline(q,poly);max=Math.max(max,d);sum+=d*d;if(d>tol)return null;}
    // Reverse test avoids shortcutting a notch or skipping part of a loop.
    for(let i=1;i<poly.length;i++){
      const a=poly[i-1],b=poly[i],n=Math.max(1,Math.ceil(dist(a,b)/Math.max(.5,tol)));
      for(let k=0;k<=n;k++){const t=k/n,d=nearestPolyline({x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)},raw);if(d>tol)return null;max=Math.max(max,d);}
    }
    return {max,rms:Math.sqrt(sum/raw.length)};
  }
  function fitPolygon(raw,tol,maxSides=64) {
    if(raw.length<5)return null;
    const p=raw.slice(0,-1);let a=0;
    for(let i=1;i<p.length;i++)if(p[i].x<p[a].x||(p[i].x===p[a].x&&p[i].y<p[a].y))a=i;
    const r=p.slice(a).concat(p.slice(0,a));r.push(r[0]);let b=1;
    for(let i=2;i<r.length-1;i++)if(dist2(r[0],r[i])>dist2(r[0],r[b]))b=i;
    const seedTol=Math.max(2.2,tol*2.2);
    // Coarse proposals are refitted to all source samples, then tested at the actual tolerance.
    let inds=rdpIndices(r.slice(0,b+1),seedTol).slice(0,-1).concat(rdpIndices(r.slice(b),seedTol).map(i=>i+b).slice(0,-1));
    // Eliminate arbitrary cycle start points and tiny raster stair steps.
    let changed=true;
    while(changed&&inds.length>3){changed=false;
      for(let j=0;j<inds.length;j++){
        const i0=inds[(j+inds.length-1)%inds.length],i1=inds[(j+1)%inds.length];let pts=[];
        for(let t=i0;;t=(t+1)%(r.length-1)){pts.push(r[t]);if(t===i1)break;}
        if(pts.every(q=>project(q,r[i0],r[i1]).d<=seedTol)){inds.splice(j,1);changed=true;break;}
      }
    }
    if(inds.length<3||inds.length>maxSides)return null;
    const lines=[];
    for(let j=0;j<inds.length;j++){
      const pts=[],i0=inds[j],i1=inds[(j+1)%inds.length];for(let t=i0;;t=(t+1)%(r.length-1)){pts.push(r[t]);if(t===i1)break;}
      if(pts.length<3)return null;const trim=pts.length>12?2:pts.length>6?1:0;const f=fitLineTLS(trim?pts.slice(trim,-trim):pts);
      if(f.rms>Math.max(.48,tol*.45))return null;
      lines.push(f);
    }
    const verts=[];
    for(let j=0;j<lines.length;j++){
      const v=intersection(lines[(j+lines.length-1)%lines.length],lines[j]);if(!v)return null;verts.push(v);
    }
    for(let j=0;j<verts.length;j++){
      const a=verts[(j+verts.length-1)%verts.length],b=verts[j],c=verts[(j+1)%verts.length];
      if(dist(a,b)<2||dist(b,c)<2)return null;
      const turn=Math.acos(clamp(((b.x-a.x)*(c.x-b.x)+(b.y-a.y)*(c.y-b.y))/(dist(a,b)*dist(b,c)),-1,1));
      if(turn<.24)return null;
    }
    let poly=[...verts,verts[0]],err=bidirectionalError(raw,poly,tol);if(!err)return null;
    // Axis-aligned rectangles get exact, common horizontal/vertical supports.
    if(verts.length===4){
      const xs=verts.map(p=>p.x),ys=verts.map(p=>p.y),box=[point(Math.min(...xs),Math.min(...ys)),point(Math.max(...xs),Math.min(...ys)),point(Math.max(...xs),Math.max(...ys)),point(Math.min(...xs),Math.max(...ys))];
      if(area(poly)<0)box.reverse();const closed=[...box,box[0]],be=bidirectionalError(raw,closed,tol);
      if(be&&be.rms<=err.rms+.12){poly=closed;err=be;}
    }
    return {points:poly,error:err};
  }
  function fitCircle(p) {
    if(p.length<6)return null;let mx=0,my=0;for(const q of p){mx+=q.x;my+=q.y;}mx/=p.length;my/=p.length;
    let xx=0,xy=0,yy=0,xz=0,yz=0;
    for(const q of p){const x=q.x-mx,y=q.y-my,z=x*x+y*y;xx+=x*x;xy+=x*y;yy+=y*y;xz+=x*z;yz+=y*z;}
    const den=xx*yy-xy*xy;if(Math.abs(den)<1e-8)return null;
    let cx=mx+(xz*yy-yz*xy)/(2*den),cy=my+(yz*xx-xz*xy)/(2*den),r=p.reduce((s,q)=>s+Math.hypot(q.x-cx,q.y-cy),0)/p.length;
    // Geometric least squares refinement (rather than just algebraic error).
    for(let it=0;it<4;it++){
      const rows=[],values=[];for(const q of p){const dx=cx-q.x,dy=cy-q.y,d=Math.hypot(dx,dy);if(d<1e-9)continue;rows.push([dx/d,dy/d,-1]);values.push(r-d);}
      const delta=leastSquares(rows,values,3);if(!delta)break;cx+=delta[0];cy+=delta[1];r+=delta[2];
    }
    if(!(r>1)||!Number.isFinite(r))return null;return {cx:snap(cx),cy:snap(cy),rx:snap(r),ry:snap(r),angle:0};
  }
  function fitEllipse(p) {
    if(p.length<12)return null;let mx=0,my=0;for(const q of p){mx+=q.x;my+=q.y;}mx/=p.length;my/=p.length;
    const scale=Math.sqrt(p.reduce((v,q)=>v+sq(q.x-mx)+sq(q.y-my),0)/p.length);if(scale<2)return null;
    const rows=p.map(q=>{const x=(q.x-mx)/scale,y=(q.y-my)/scale;return [x*x,x*y,y*y,x,y];});
    const coef=leastSquares(rows,rows.map(()=>1),5);if(!coef)return null;const [A,B,C,D,E]=coef,det=A*C-B*B/4;
    if(det<=1e-10||A+C<=0)return null;
    const xc=(-C*D+B*E/2)/(2*det),yc=(B*D/2-A*E)/(2*det),k=1+A*xc*xc+B*xc*yc+C*yc*yc;
    const t=Math.sqrt(sq(A-C)+B*B),e1=(A+C-t)/2,e2=(A+C+t)/2;if(e1<=0||k<=0)return null;
    let theta=.5*Math.atan2(B,A-C)+Math.PI/2;
    let model={cx:mx+scale*xc,cy:my+scale*yc,rx:scale*Math.sqrt(k/e1),ry:scale*Math.sqrt(k/e2),angle:theta};
    if(model.rx/model.ry>20)return null;
    // Restrict near-axis ellipses to that simpler model when possible (validated later).
    if(Math.abs(Math.sin(2*theta))<.015)model.angle=Math.round(theta/(Math.PI/2))*Math.PI/2;
    if(Math.abs(Math.sin(model.angle))>.999999){[model.rx,model.ry]=[model.ry,model.rx];model.angle=0;}
    else if(Math.abs(Math.sin(model.angle))<1e-8)model.angle=0;
    for(const key of ['cx','cy','rx','ry'])model[key]=snap(model[key]);model.angle=snap(model.angle*180/Math.PI)*Math.PI/180;
    return model;
  }
  function ellipsePoint(m,t) {const c=Math.cos(m.angle),s=Math.sin(m.angle);return {x:m.cx+m.rx*Math.cos(t)*c-m.ry*Math.sin(t)*s,y:m.cy+m.rx*Math.cos(t)*s+m.ry*Math.sin(t)*c};}
  function ellipseResidual(m,p) {
    const dx=p.x-m.cx,dy=p.y-m.cy,c=Math.cos(m.angle),s=Math.sin(m.angle),u=c*dx+s*dy,v=-s*dx+c*dy;
    const f=sq(u/m.rx)+sq(v/m.ry)-1,g=2*Math.hypot(u/sq(m.rx),v/sq(m.ry));return g>1e-12?Math.abs(f/g):Infinity;
  }
  function closedPrimitive(raw,tol) {
    const p=raw.slice(0,-1);if(p.length<10)return null;
    for(const type of ['circle','ellipse']) {
      const m=type==='circle'?fitCircle(p):fitEllipse(p);if(!m)continue;
      if(p.some(q=>ellipseResidual(m,q)>tol))continue;
      const poly=[],n=Math.max(40,Math.ceil(TAU*Math.max(m.rx,m.ry)/1.5));for(let i=0;i<n;i++)poly.push(ellipsePoint(m,TAU*i/n));poly.push(poly[0]);
      const e=bidirectionalError(raw,poly,Math.min(m.rx,m.ry)<6?Math.min(tol,.22):tol);if(!e)continue;
      if(Math.sign(area(poly))!==Math.sign(area(raw)))poly.reverse();
      const sweep=area(raw)>0?1:0,delta=sweep?Math.PI:-Math.PI;
      // Use endpoints derived from the rounded model for equivalent SVG shapes.
      const a=ellipsePoint(m,0),b=ellipsePoint(m,Math.PI);
      if(m.angle===0){a.x=m.cx+m.rx;a.y=m.cy;b.x=m.cx-m.rx;b.y=m.cy;}
      const arcs=[{type:'A',a,b,...m,sweep,large:0,start:0,delta},
        {type:'A',a:b,b:a,...m,sweep,large:0,start:delta,delta}];
      return {type,model:m,segments:arcs,error:e};
    }
    return null;
  }
  function arcFit(p,tol) {
    if(p.length<7||dist(p[0],p[p.length-1])<2)return null;
    const a=p[0],b=p[p.length-1],chord=dist(a,b),mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},nx=-(b.y-a.y)/chord,ny=(b.x-a.x)/chord;
    // Endpoints are fixed network vertices. Solve the circle on their bisector.
    let numerator=0,denominator=0;
    for(const q of p){const x=q.x-mid.x,y=q.y-mid.y,k=x*x+y*y-chord*chord/4,v=2*(x*nx+y*ny);numerator+=k*v;denominator+=v*v;}
    if(denominator<1e-8)return null;let t=numerator/denominator;
    for(let iter=0;iter<4;iter++){
      const cx=mid.x+t*nx,cy=mid.y+t*ny,r=Math.hypot(chord/2,t);let num=0,den=0;
      for(const q of p){const d=Math.hypot(q.x-cx,q.y-cy),e=d-r,j=((cx-q.x)*nx+(cy-q.y)*ny)/Math.max(d,1e-8)-t/r;num+=e*j;den+=j*j;}
      if(den<1e-10)break;t-=num/den;
    }
    const cx=mid.x+t*nx,cy=mid.y+t*ny,r=Math.hypot(chord/2,t);if(r>1e7)return null;
    let last=Math.atan2(a.y-cy,a.x-cx),start=last,total=0,backtrack=0,max=0;
    for(let i=1;i<p.length;i++){
      const q=p[i],angle=Math.atan2(q.y-cy,q.x-cx);let d=angle-last;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;
      total+=d;last=angle;max=Math.max(max,Math.abs(Math.hypot(q.x-cx,q.y-cy)-r));
    }
    if(max>tol||Math.abs(total)<.20||Math.abs(total)>TAU-.05)return null;
    last=start;for(let i=1;i<p.length;i++){const an=Math.atan2(p[i].y-cy,p[i].x-cx);let d=an-last;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;if(d*Math.sign(total)<0)backtrack+=Math.abs(d);last=an;}
    if(backtrack*r>Math.max(2,tol*4))return null;
    // Radius serialization changes the SVG-computed center very slightly: rebuild it.
    const radius=snap(r),height=Math.sqrt(Math.max(0,radius*radius-chord*chord/4)),sign=Math.sign(t)||1;
    const rcx=mid.x+sign*height*nx,rcy=mid.y+sign*height*ny;
    const st=Math.atan2(a.y-rcy,a.x-rcx),en=Math.atan2(b.y-rcy,b.x-rcx);let delta=en-st;
    if(total>0){while(delta<=0)delta+=TAU;}else{while(delta>=0)delta-=TAU;}
    const seg={type:'A',a,b,cx:rcx,cy:rcy,rx:radius,ry:radius,angle:0,sweep:delta>0?1:0,large:Math.abs(delta)>Math.PI?1:0,start:st,delta};
    const flat=flatten([seg],.06);if(!bidirectionalError(p,flat,tol))return null;
    return seg;
  }
  function ellipseArcFit(p,tol) {
    if(p.length<18||dist(p[0],p[p.length-1])<5)return null;
    const model=fitEllipse(p);if(!model||model.rx/model.ry>12)return null;
    const a=p[0],b=p[p.length-1],co=Math.cos(model.angle),si=Math.sin(model.angle);
    const dx=(b.x-a.x)/2,dy=(b.y-a.y)/2,u=(co*dx+si*dy)/model.rx,v=(-si*dx+co*dy)/model.ry,l=u*u+v*v;
    if(l<.001||l>=1)return null;
    const height=Math.sqrt((1-l)/l),mx=(a.x+b.x)/2,my=(a.y+b.y)/2;
    let best=null;
    for(const sign of [-1,1]) {
      const ox=-v*height*sign*model.rx,oy=u*height*sign*model.ry;
      const m={...model,cx:mx+co*ox-si*oy,cy:my+si*ox+co*oy};
      const param=q=>Math.atan2((-si*(q.x-m.cx)+co*(q.y-m.cy))/m.ry,(co*(q.x-m.cx)+si*(q.y-m.cy))/m.rx);
      let last=param(a),start=last,total=0,back=0;
      for(let i=1;i<p.length;i++){const t=param(p[i]);let d=t-last;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;total+=d;last=t;}
      if(Math.abs(total)<.55||Math.abs(total)>TAU-.1)continue;
      last=start;
      for(let i=1;i<p.length;i++){const t=param(p[i]);let d=t-last;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;if(d*Math.sign(total)<0)back+=Math.abs(d);last=t;}
      if(back*Math.min(m.rx,m.ry)>Math.max(2,tol*3))continue;
      const s={type:'A',a,b,...m,start,delta:total,sweep:total>0?1:0,large:Math.abs(total)>Math.PI?1:0};
      const error=bidirectionalError(p,flatten([s],.025),tol);
      if(error&&(!best||error.rms<best.error.rms))best={segment:s,error};
    }
    return best?.segment||null;
  }

  function roundedRectangle(raw,tol) {
    if(raw.length<24)return null;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(const p of raw){minX=Math.min(minX,p.x);minY=Math.min(minY,p.y);maxX=Math.max(maxX,p.x);maxY=Math.max(maxY,p.y);}
    const cx=(minX+maxX)/2,cy=(minY+maxY)/2,hw=(maxX-minX)/2,hh=(maxY-minY)/2,limit=Math.min(hw,hh);
    if(limit<2.5)return null;
    const error=r=>{
      let sum=0;for(const p of raw){const x=Math.abs(p.x-cx)-(hw-r),y=Math.abs(p.y-cy)-(hh-r),d=Math.hypot(Math.max(x,0),Math.max(y,0))+Math.min(Math.max(x,y),0)-r;sum+=d*d;}return sum/raw.length;
    };
    let lo=0,hi=limit;
    for(let it=0;it<26;it++){const a=lo+(hi-lo)/3,b=hi-(hi-lo)/3;if(error(a)<error(b))hi=b;else lo=a;}
    let r=snap((lo+hi)/2);if(limit-r<.08)r=limit;
    if(r<1.4||error(r)>sq(Math.max(.25,tol*.55)))return null;
    const points=[{x:minX+r,y:minY},{x:maxX-r,y:minY},{x:maxX,y:minY+r},{x:maxX,y:maxY-r},{x:maxX-r,y:maxY},{x:minX+r,y:maxY},{x:minX,y:maxY-r},{x:minX,y:minY+r}];
    const centers=[{x:maxX-r,y:minY+r},{x:maxX-r,y:maxY-r},{x:minX+r,y:maxY-r},{x:minX+r,y:minY+r}];
    const ss=[];
    for(let i=0;i<4;i++) {
      const a=points[2*i],b=points[2*i+1],c=points[(2*i+2)%8];if(!same(a,b))ss.push(line(a,b));
      ss.push({type:'A',a:b,b:c,cx:centers[i].x,cy:centers[i].y,rx:r,ry:r,angle:0,start:-Math.PI/2+i*Math.PI/2,delta:Math.PI/2,sweep:1,large:0});
    }
    const tested=bidirectionalError(raw,flatten(ss,.025),tol);if(!tested)return null;
    const segments=area(raw)<0?ss.slice().reverse().map(reverse):ss;
    return {type:'roundedRect',model:{x:minX,y:minY,width:maxX-minX,height:maxY-minY,r},segments,error:tested};
  }

  function fitCapsule(raw,tol) {
    if(raw.length<24)return null;
    const p=raw.slice(0,-1),axis=fitLineTLS(p);
    let angle=Math.atan2(axis.dy,axis.dx),cx=axis.x,cy=axis.y;
    let minU=Infinity,maxU=-Infinity,minV=Infinity,maxV=-Infinity;
    for(const q of p) {
      const u=(q.x-cx)*axis.dx+(q.y-cy)*axis.dy;
      const v=-(q.x-cx)*axis.dy+(q.y-cy)*axis.dx;
      minU=Math.min(minU,u);
      maxU=Math.max(maxU,u);
      minV=Math.min(minV,v);
      maxV=Math.max(maxV,v);
    }
    let radius=(maxV-minV)/2,halfLength=(maxU-minU)/2-radius;
    if(radius<2.5||halfLength<radius*.5)return null;
    cx+=axis.dx*(minU+maxU)/2-axis.dy*(minV+maxV)/2;
    cy+=axis.dy*(minU+maxU)/2+axis.dx*(minV+maxV)/2;

    // Fit distance to a finite centerline, including both circular caps. The
    // lattice's extreme corners otherwise bias the width and axis with rotation.
    for(let iteration=0;iteration<10;iteration++) {
      const co=Math.cos(angle),si=Math.sin(angle),rows=[],values=[];
      for(const q of p) {
        const u=(q.x-cx)*co+(q.y-cy)*si,v=-(q.x-cx)*si+(q.y-cy)*co;
        const beyond=Math.max(0,Math.abs(u)-halfLength),distance=Math.hypot(beyond,v);
        if(distance<1e-8)return null;
        const du=Math.sign(u)*beyond/distance,dv=v/distance;
        rows.push([-du*co+dv*si,-du*si-dv*co,du*v-dv*u,-beyond/distance,-1]);
        values.push(radius-distance);
      }
      const step=leastSquares(rows,values,5);
      if(!step||step.some(v=>!Number.isFinite(v))||Math.abs(step[2])>.25)return null;
      cx+=step[0];
      cy+=step[1];
      angle+=step[2];
      halfLength+=step[3];
      radius+=step[4];
      if(radius<2.5||halfLength<radius*.5)return null;
      if(Math.max(...step.map(Math.abs))<1e-6)break;
    }

    const co=Math.cos(angle),si=Math.sin(angle);
    radius=snap(radius);
    const a={x:cx-halfLength*co,y:cy-halfLength*si},b={x:cx+halfLength*co,y:cy+halfLength*si};
    const offset=(center,sign)=>({x:center.x-sign*radius*si,y:center.y+sign*radius*co});
    const a0=offset(a,-1),b0=offset(b,-1),a1=offset(a,1),b1=offset(b,1);
    const arc=(center,start,end,theta)=>({type:'A',a:start,b:end,cx:center.x,cy:center.y,rx:radius,ry:radius,angle:0,start:theta,delta:Math.PI,sweep:1,large:0});
    const segments=[line(a0,b0),arc(b,b0,b1,angle-Math.PI/2),line(b1,a1),arc(a,a1,a0,angle+Math.PI/2)];
    const error=bidirectionalError(raw,flatten(segments,.0125),Math.min(tol,.85));
    if(!error||error.rms>Math.min(.45,tol*.55))return null;
    return {segments:area(raw)<0?segments.reverse().map(reverse):segments,error};
  }

  function cubicPoint(s,t) {
    const v=1-t;return {x:v*v*v*s.a.x+3*v*v*t*s.c1.x+3*v*t*t*s.c2.x+t*t*t*s.b.x,y:v*v*v*s.a.y+3*v*v*t*s.c1.y+3*v*t*t*s.c2.y+t*t*t*s.b.y};
  }
  function unit(x,y) {const d=Math.hypot(x,y);return d>1e-12?{x:x/d,y:y/d}:{x:1,y:0};}
  function sampleOffset(p,i,offset,closed=false) {
    const n=closed?p.length-1:p.length,sign=offset<0?-1:1;let remaining=Math.abs(offset),a=p[i],j=i;
    for(let step=0;step<n;step++) {
      let k=j+sign;if(closed)k=(k+n)%n;else if(k<0||k>=n)return a;
      const b=p[k],d=dist(a,b);if(d>=remaining&&d>0){const t=remaining/d;return {x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)};}
      remaining-=d;j=k;a=b;
    }
    return a;
  }
  function tangentAt(p,i,radius=8,closed=false) {
    // Quadratic regression over several pixels, not the next raster stair step.
    // Positive parameter always follows the contour, even at the right endpoint.
    const rows=[],xs=[],ys=[];
    for(let k=-4;k<=4;k++) {
      const s=radius*k/4;
      if(!closed&&((i===0&&s<0)||(i===p.length-1&&s>0)))continue;
      const q=sampleOffset(p,i,s,closed),w=Math.sqrt(Math.exp(-sq(s/radius)));
      rows.push([w,w*s/radius,w*sq(s/radius)]);xs.push(w*q.x);ys.push(w*q.y);
    }
    const x=leastSquares(rows,xs,3),y=leastSquares(rows,ys,3);
    if(x&&y&&Math.hypot(x[1],y[1])>1e-6)return unit(x[1],y[1]);
    const a=sampleOffset(p,i,-radius,closed),b=sampleOffset(p,i,radius,closed);return unit(b.x-a.x,b.y-a.y);
  }
  function findCorners(p,closed,tol) {
    const n=closed?p.length-1:p.length,candidates=[],small=Math.max(3,Math.min(5,2+tol*2)),large=small*2.5;
    const turn=(a,b,c)=>{
      const u=unit(b.x-a.x,b.y-a.y),v=unit(c.x-b.x,c.y-b.y);
      return Math.acos(clamp(u.x*v.x+u.y*v.y,-1,1));
    };
    let arclength=0;const positions=[0];for(let i=1;i<n;i++){arclength+=dist(p[i-1],p[i]);positions.push(arclength);}
    const length=arclength+(closed?dist(p[n-1],p[0]):0);
    for(let i=0;i<n;i++) {
      // A paint junction may lie only a few pixels from a real corner.
      // Clipped support still measures its turn; skipping the whole support
      // radius forces that corner into a smooth curve and creates a bulge.

      if(!closed&&(positions[i]<1.5||length-positions[i]<1.5))continue;
      const a=turn(sampleOffset(p,i,-small,closed),p[i],sampleOffset(p,i,small,closed));
      if(a<.70)continue;
      const b=turn(sampleOffset(p,i,-large,closed),p[i],sampleOffset(p,i,large,closed));
      // Truncated support makes shallow turns ambiguous. Near an endpoint,
      // require a sharp turn that remains concentrated at the larger scale.

      if(!closed&&(positions[i]<large||length-positions[i]<large)&&(a<1.2||a<b*.8))continue;
      // A corner concentrates its turning at both scales. A smooth, tight bend
      // accumulates angle with scale; it should not become a spurious cusp.
      if(b>.80&&a>b*.65)candidates.push({i,score:a+.25*b,s:positions[i]});
    }
    candidates.sort((a,b)=>b.score-a.score);const accepted=[];
    for(const a of candidates)if(accepted.every(b=>{
      let d=Math.abs(a.s-b.s);if(closed)d=Math.min(d,length-d);return d>large;
    }))accepted.push(a);
    return accepted.map(v=>v.i).sort((a,b)=>a-b);
  }
  function constrainedCubic(p,ta,tb,tol) {
    const a=p[0],b=p[p.length-1],ts=[0];let length=0;
    for(let i=1;i<p.length;i++){length+=dist(p[i-1],p[i]);ts.push(length);}
    if(length<1e-10)return null;for(let i=1;i<ts.length;i++)ts[i]/=length;
    let best=null;
    for(let iteration=0;iteration<12;iteration++) {
      let aa=0,ab=0,bb=0,ra=0,rb=0;
      for(let i=0;i<p.length;i++) {
        const t=ts[i],v=1-t,A=3*v*v*t,B=3*v*t*t;
        const ax=A*ta.x,ay=A*ta.y,bx=-B*tb.x,by=-B*tb.y;
        const x=p[i].x-(v*v*v+A)*a.x-(t*t*t+B)*b.x,y=p[i].y-(v*v*v+A)*a.y-(t*t*t+B)*b.y;
        aa+=ax*ax+ay*ay;ab+=ax*bx+ay*by;bb+=bx*bx+by*by;ra+=ax*x+ay*y;rb+=bx*x+by*y;
      }
      const det=aa*bb-ab*ab;
      let u=det>1e-12?(ra*bb-rb*ab)/det:0,v=det>1e-12?(rb*aa-ra*ab)/det:0;
      if(u<1e-5||v<1e-5||u>length*2||v>length*2)u=v=length/3;
      const s={type:'C',a,b,c1:point(a.x+u*ta.x,a.y+u*ta.y),c2:point(b.x-v*tb.x,b.y-v*tb.y)};
      // Newton projection, bounded monotonically. Parameters are a fitting aid,
      // while acceptance below measures the actual spatial error in BOTH directions.
      for(let i=1;i<p.length-1;i++) {
        let t=ts[i];
        for(let step=0;step<3;step++) {
          const q=cubicPoint(s,t),z=1-t;
          const dx=3*z*z*(s.c1.x-a.x)+6*z*t*(s.c2.x-s.c1.x)+3*t*t*(b.x-s.c2.x);
          const dy=3*z*z*(s.c1.y-a.y)+6*z*t*(s.c2.y-s.c1.y)+3*t*t*(b.y-s.c2.y);
          const ddx=6*z*(s.c2.x-2*s.c1.x+a.x)+6*t*(b.x-2*s.c2.x+s.c1.x);
          const ddy=6*z*(s.c2.y-2*s.c1.y+a.y)+6*t*(b.y-2*s.c2.y+s.c1.y);
          const den=dx*dx+dy*dy+(q.x-p[i].x)*ddx+(q.y-p[i].y)*ddy;
          if(Math.abs(den)<1e-10)break;
          const next=clamp(t-((q.x-p[i].x)*dx+(q.y-p[i].y)*dy)/den,ts[i-1]+1e-9,ts[i+1]-1e-9);
          if(Math.abs(next-t)<1e-7){t=next;break;}t=next;
        }
        ts[i]=t;
      }
      let error=0,split=Math.floor(p.length/2);
      for(let i=1;i<p.length-1;i++){const d=dist2(p[i],cubicPoint(s,ts[i]));if(d>error){error=d;split=i;}}
      if(!best||error<best.error)best={segment:s,error,split};
      if(error<=tol*tol&&bidirectionalError(p,flatten([s],.025),tol))return {...best,segment:s,ok:true};
    }
    if(best&&bidirectionalError(p,flatten([best.segment],.025),tol))best.ok=true;
    return best;
  }
  function fitSmoothSpan(p,tol,ta,tb) {
    const records=[];
    function recurse(lo,hi,left,right,depth) {
      // Two samples support a line, not a tangent-constrained curve. On short
      // junction spurs, forcing estimated tangents can create a crossing loop.
      if(hi-lo<=1) {
        records.push({segment:line(p[lo],p[hi]),lo,hi,left,right});
        return;
      }
      const pts=p.slice(lo,hi+1),fit=constrainedCubic(pts,left,right,tol);
      if(!fit?.ok&&depth>=22) {
        // Never accept an unchecked cubic merely because subdivision hit a
        // depth/size limit. Sample segments are a bounded-error local fallback.
        for(let i=lo;i<hi;i++)records.push({segment:line(p[i],p[i+1]),lo:i,hi:i+1,left,right});
        return;
      }
      if(fit?.ok) {
        const d=dist(p[lo],p[hi])/3;
        const segment=fit?.segment||{type:'C',a:p[lo],b:p[hi],c1:point(p[lo].x+d*left.x,p[lo].y+d*left.y),c2:point(p[hi].x-d*right.x,p[hi].y-d*right.y)};
        records.push({segment,lo,hi,left,right});return;
      }
      const margin=Math.max(1,Math.floor((hi-lo)*.1));
      const split=clamp(lo+(fit?.split||Math.floor((hi-lo)/2)),lo+margin,hi-margin);
      const t=tangentAt(p,split,Math.min(8,Math.max(2,(hi-lo)/4)));
      recurse(lo,split,left,t,depth+1);recurse(split,hi,t,right,depth+1);
    }
    recurse(0,p.length-1,ta,tb,0);
    // Greedy coalescing removes subdivisions that were useful to find a fit but
    // are not needed by the finished model. Tangents on the outside stay fixed.
    let changed=true;
    for(let pass=0;changed&&pass<8;pass++) {
      changed=false;
      for(let i=0;i<records.length-1;i++) {
        const a=records[i],b=records[i+1],fit=constrainedCubic(p.slice(a.lo,b.hi+1),a.left,b.right,tol);
        if(fit?.ok){records.splice(i,2,{segment:fit.segment,lo:a.lo,hi:b.hi,left:a.left,right:b.right});changed=true;i--;}
      }
    }
    return records.map((r,i)=>({...r.segment,smoothStart:i>0&&r.segment.type==='C'&&records[i-1].segment.type==='C'}));
  }
  function flatten(segments,epsilon=.02) {
    if(!segments.length)return [];
    const out=[segments[0].a];
    const bez=(a,c1,c2,b,depth)=>{
      if(depth>=18||Math.max(project(c1,a,b).d,project(c2,a,b).d)<=epsilon){out.push(b);return;}
      const mid=(p,q)=>({x:(p.x+q.x)/2,y:(p.y+q.y)/2});
      const u=mid(a,c1),v=mid(c1,c2),w=mid(c2,b),s=mid(u,v),t=mid(v,w),m=mid(s,t);
      bez(a,u,s,m,depth+1);bez(m,t,w,b,depth+1);
    };
    for(const s of segments){
      if(s.type==='L')out.push(s.b);
      else if(s.type==='C')bez(s.a,s.c1,s.c2,s.b,0);
      else {
        const radius=Math.max(s.rx,s.ry);
        const step=4*Math.asin(Math.sqrt(Math.min(1,epsilon/(2*Math.max(radius,epsilon)))));
        const n=Math.max(2,Math.ceil(Math.abs(s.delta)/step));
        for(let k=1;k<n;k++)out.push(ellipsePoint(s,s.start+s.delta*k/n));out.push(s.b);
      }
    }
    return out;
  }
  function segmentTangent(s,atStart=true) {
    if(s.type==='L')return unit(s.b.x-s.a.x,s.b.y-s.a.y);
    if(s.type==='C')return atStart?unit(s.c1.x-s.a.x,s.c1.y-s.a.y):unit(s.b.x-s.c2.x,s.b.y-s.c2.y);
    const t=s.start+(atStart?0:s.delta),co=Math.cos(s.angle),si=Math.sin(s.angle),sign=Math.sign(s.delta);
    return unit(sign*(-s.rx*Math.sin(t)*co-s.ry*Math.cos(t)*si),sign*(-s.rx*Math.sin(t)*si+s.ry*Math.cos(t)*co));
  }
  function tangentsAgree(s,a,b) {
    const dot=(u,v)=>u.x*v.x+u.y*v.y;
    return (!a||dot(segmentTangent(s,true),a)>.99999)&&(!b||dot(segmentTangent(s,false),b)>.99999);
  }

  function straightSpans(p,tol,ta,tb) {
    // A neighboring support line can project this span's endpoints off the
    // lattice. Its interior still supplies binary evidence: treating it as
    // antialiased can turn a cap's short pixel plateau into a straight edge.

    const interior=p.slice(1,-1);
    const binary=interior.length>=3&&interior.every((q,i)=>Number.isInteger(q.x)&&Number.isInteger(q.y)&&(!i||dist2(interior[i-1],q)===1));
    if(binary) {
      return binaryStraightSpans(p,tol,ta,tb);
    }

    // A long straight support must survive fitting the adjoining bend. A
    // single cubic can otherwise spend its error allowance bowing that line.
    const limit=Math.min(tol,.12);
    const indices=rdpIndices(p,limit);
    const spans=[];
    for(let i=1;i<indices.length;i++) {
      const lo=indices[i-1];
      const hi=indices[i];
      const segment=line(p[lo],p[hi]);
      if(dist(segment.a,segment.b)<12)continue;
      const residual=p.slice(lo,hi+1).reduce((sum,q)=>sum+sq(project(q,segment.a,segment.b).d),0)/(hi-lo+1);
      if(residual>sq(Math.min(tol,.04)))continue;
      if(!tangentsAgree(segment,lo===0?ta:null,hi===p.length-1?tb:null))continue;
      const previous=spans[spans.length-1];
      if(previous?.hi===lo&&!tangentsAgree(segment,segmentTangent(previous.segment),null))continue;
      spans.push({lo,hi,segment});
    }
    return spans;
  }

  function binaryStraightSpans(p,tol,ta,tb) {
    // Lattice corners oscillate around a diagonal even when its underlying
    // edge is straight. Fit all their evidence instead of their extreme steps.
    const indices=rdpIndices(p,Math.max(2.2,tol*2.2));
    const spans=[];
    for(let i=1;i<indices.length;i++) {
      const lo=indices[i-1],hi=indices[i];
      if(dist(p[lo],p[hi])<32||spans[spans.length-1]?.hi===lo) {
        continue;
      }

      const pts=p.slice(lo,hi+1),support=fitLineTLS(pts);
      if(support.rms>.45||support.max>.85) {
        continue;
      }

      const anchor=lo===0?p[lo]:hi===p.length-1?p[hi]:null;
      const fit=anchor?fitLineTLS(pts,anchor):support;
      const onLine=q=>{
        const t=(q.x-fit.x)*fit.dx+(q.y-fit.y)*fit.dy;
        return point(fit.x+t*fit.dx,fit.y+t*fit.dy);
      };
      const a=lo===0?p[lo]:onLine(p[lo]);
      const b=hi===p.length-1?p[hi]:onLine(p[hi]);
      const segment=line(a,b);
      if(!bidirectionalError(pts,[a,b],tol)) {
        continue;
      }
      if(!tangentsAgree(segment,lo===0?ta:null,hi===p.length-1?tb:null)) {
        continue;
      }

      spans.push({lo,hi,segment});
    }
    return spans;
  }

  function fitRoundTerminal(p,left,right,tol) {
    const ta=segmentTangent(left),tb=segmentTangent(right);
    if(ta.x*tb.x+ta.y*tb.y>-.995)return null;
    const sign=Math.sign(area(p));
    if(!sign)return null;
    const na={x:-ta.y,y:ta.x},nb={x:-tb.y,y:tb.x};
    const distance=(q,line,t)=>Math.abs(-(q.x-line.a.x)*t.y+(q.y-line.a.y)*t.x);
    const curved=p.filter(q=>distance(q,left,ta)>.75&&distance(q,right,tb)>.75);
    const initial=fitCircle(curved);
    if(!initial)return null;

    // A circle tangent to both neighboring support lines has one remaining
    // degree of freedom. Solve within that family instead of accepting a
    // circular arc with an abrupt tangent change at either support.
    const dot=na.x*nb.x+na.y*nb.y+1,denominator=4-dot*dot;
    const a=na.x*left.b.x+na.y*left.b.y,b=nb.x*right.a.x+nb.y*right.a.y;
    const alpha=(2*a-dot*b)/denominator,beta=(2*b-dot*a)/denominator;
    const origin={x:alpha*na.x+beta*nb.x,y:alpha*na.y+beta*nb.y,r:-sign*(alpha+beta)};
    const direction={x:sign*(nb.y-na.y),y:sign*(na.x-nb.x),r:na.x*nb.y-na.y*nb.x};
    const norm=Math.hypot(direction.x,direction.y);
    for(const key of ['x','y','r'])direction[key]/=norm;
    let parameter=((initial.cx-origin.x)*direction.x+(initial.cy-origin.y)*direction.y+(initial.rx-origin.r)*direction.r)/(1+direction.r*direction.r);
    for(let iteration=0;iteration<8;iteration++) {
      const cx=origin.x+parameter*direction.x,cy=origin.y+parameter*direction.y,r=origin.r+parameter*direction.r;
      let numerator=0,denominator=0;
      for(const q of curved) {
        const distance=Math.hypot(q.x-cx,q.y-cy);
        if(distance<1e-8)return null;
        const derivative=((cx-q.x)*direction.x+(cy-q.y)*direction.y)/distance-direction.r;
        numerator+=(distance-r)*derivative;
        denominator+=derivative*derivative;
      }
      if(denominator<1e-10)return null;
      const step=numerator/denominator;
      parameter-=step;
      if(Math.abs(step)<1e-6)break;
    }
    const cx=origin.x+parameter*direction.x,cy=origin.y+parameter*direction.y,r=origin.r+parameter*direction.r;
    if(r<4||!Number.isFinite(r))return null;
    // Keep these model-derived points at full precision: rounding a nearly
    // semicircular chord can move the center reconstructed by SVG rendering.
    const start={x:cx-sign*r*na.x,y:cy-sign*r*na.y},end={x:cx-sign*r*nb.x,y:cy-sign*r*nb.y};
    if(dist(start,left.b)>16||dist(end,right.a)>16)return null;
    const theta=Math.atan2(start.y-cy,start.x-cx);
    let delta=Math.atan2(end.y-cy,end.x-cx)-theta;
    while(delta*sign<=0)delta+=sign*TAU;
    if(Math.abs(Math.abs(delta)-Math.PI)>.15)return null;
    const segment={type:'A',a:start,b:end,cx,cy,rx:r,ry:r,angle:0,start:theta,delta,sweep:sign>0?1:0,large:Math.abs(delta)>Math.PI?1:0};
    const projectSupport=(q,s,t)=>{
      const u=(q.x-s.a.x)*t.x+(q.y-s.a.y)*t.y;
      return {x:s.a.x+u*t.x,y:s.a.y+u*t.y};
    };
    const from=projectSupport(p[0],left,ta),to=projectSupport(p[p.length-1],right,tb);
    const fit=bidirectionalError(p,flatten([line(from,start),segment,line(end,to)],.0125),Math.min(tol,1));
    if(!fit||fit.rms>.45)return null;
    return segment;
  }

  function fitSpan(p,tol,ta=null,tb=null,allowSimple=true,preserveStraight=false) {
    if(p.length<2)return [];
    if(allowSimple) {
      const straight=line(p[0],p[p.length-1]);
      if(p.every(q=>project(q,p[0],p[p.length-1]).d<=tol)&&tangentsAgree(straight,ta,tb))return [straight];
      const arc=arcFit(p,tol);if(arc&&tangentsAgree(arc,ta,tb))return [arc];
      const ellipse=ellipseArcFit(p,tol);if(ellipse&&tangentsAgree(ellipse,ta,tb))return [ellipse];
    }
    const straight=preserveStraight?straightSpans(p,tol,ta,tb):[];
    if(straight.length) {
      const terminals=new Map();
      const binary=p.slice(1,-1).every(q=>Number.isInteger(q.x)&&Number.isInteger(q.y));
      const supports=straight.slice();
      if(ta&&straight[0].lo>0)supports.unshift({lo:0,hi:0,virtual:true,segment:line({x:p[0].x-ta.x,y:p[0].y-ta.y},p[0])});
      const last=p.length-1;
      if(tb&&straight[straight.length-1].hi<last)supports.push({lo:last,hi:last,virtual:true,segment:line(p[last],{x:p[last].x+tb.x,y:p[last].y+tb.y})});
      if(binary)for(let i=1;i<supports.length;i++) {
        const left=supports[i-1],right=supports[i];
        const samples=p.slice(Math.max(left.lo,left.hi-12),Math.min(right.hi,right.lo+12)+1);
        const terminal=fitRoundTerminal(samples,left.segment,right.segment,tol);
        if(!terminal)continue;
        const segments=[terminal];
        if(left.virtual)segments.unshift(line(p[0],terminal.a));
        else left.segment.b=terminal.a;
        if(right.virtual)segments.push(line(terminal.b,p[last]));
        else right.segment.a=terminal.b;
        terminals.set(left.hi,{hi:right.lo,segments});
      }
      p=p.slice();
      for(const {lo,hi,segment} of straight) {
        p[lo]=segment.a;
        p[hi]=segment.b;
      }
      const out=[];
      let start=0;
      let tangent=ta;
      for(const {lo,hi,segment} of straight) {
        const direction=segmentTangent(segment);
        if(lo>start) {
          const terminal=terminals.get(start);
          if(terminal?.hi===lo)out.push(...terminal.segments);
          else out.push(...fitSpan(p.slice(start,lo+1),tol,tangent,direction,true,preserveStraight));
        }
        out.push(segment);
        start=hi;
        tangent=direction;
      }
      if(start<p.length-1) {
        const terminal=terminals.get(start);
        if(terminal?.hi===p.length-1)out.push(...terminal.segments);
        else out.push(...fitSpan(p.slice(start),tol,tangent,tb,true,preserveStraight));
      }
      return out;
    }
    const result=fitSmoothSpan(p,tol,ta||tangentAt(p,0),tb||tangentAt(p,p.length-1));
    return result;
  }
  function fitOpen(p,tol,ta=null,tb=null,preserveStraight=false) {
    const corners=findCorners(p,false,tol),indices=[0,...corners,p.length-1],out=[];
    for(let i=1;i<indices.length;i++)out.push(...fitSpan(p.slice(indices[i-1],indices[i]+1),tol,i===1?ta:null,i===indices.length-1?tb:null,true,preserveStraight));
    return out;
  }
  function fitClosed(p,tol,free=true,preserveStraight=false) {
    let corners=findCorners(p,true,tol);
    if(!free&&!corners.includes(0))corners.unshift(0);
    const n=p.length-1;
    if(corners.length) {
      const start=corners[0],q=p.slice(start,n).concat(p.slice(0,start));q.push(q[0]);
      const indices=corners.map(i=>(i-start+n)%n).sort((a,b)=>a-b);indices.push(n);
      const out=[];
      for(let i=1;i<indices.length;i++) {
        const pts=q.slice(indices[i-1],indices[i]+1);
        if(same(pts[0],pts[pts.length-1])) {
          let k=1;for(let j=2;j<pts.length-1;j++)if(dist2(pts[0],pts[j])>dist2(pts[0],pts[k]))k=j;
          const t=tangentAt(pts,k),left=fitSpan(pts.slice(0,k+1),tol,null,t,false,preserveStraight),right=fitSpan(pts.slice(k),tol,t,null,false,preserveStraight);
          if(right.length)right[0].smoothStart=true;out.push(...left,...right);
        } else out.push(...fitSpan(pts,tol,null,null,true,preserveStraight));
      }
      return out;
    }
    let k=1;for(let i=2;i<n;i++)if(dist2(p[0],p[i])>dist2(p[0],p[k]))k=i;
    const t0=tangentAt(p,0,8,true),tk=tangentAt(p,k,8,true);
    const a=fitSpan(p.slice(0,k+1),tol,t0,tk,false,preserveStraight),b=fitSpan(p.slice(k),tol,tk,t0,false,preserveStraight);
    if(a.length)a[0].smoothStart=true;if(b.length)b[0].smoothStart=true;
    return a.concat(b);
  }
  function rawSegments(p) {
    // Exactly lossless collinear compression is the final topology-safe fallback.
    const out=[p[0]];for(let i=1;i<p.length-1;i++)if(Math.abs(cross(out[out.length-1],p[i],p[i+1]))>1e-10||
      (p[i].x-out[out.length-1].x)*(p[i+1].x-p[i].x)+(p[i].y-out[out.length-1].y)*(p[i+1].y-p[i].y)<0)out.push(p[i]);out.push(p[p.length-1]);
    return out.slice(1).map((q,i)=>line(out[i],q));
  }
  function polygonParameter(p,poly) {
    let best={d:Infinity},len=0;
    for(let i=1;i<poly.length;i++){const pr=project(p,poly[i-1],poly[i]),l=dist(poly[i-1],poly[i]);if(pr.d<best.d)best={...pr,s:len+pr.t*l};len+=l;}
    return {...best,total:len};
  }
  function polygonPart(poly,a,b,forward) {
    if(!forward)return polygonPart(poly,b,a,true).reverse();
    const A=polygonParameter(a,poly),B=polygonParameter(b,poly),total=A.total;
    let finish=B.s;while(finish<A.s+1e-7)finish+=total;
    // Keep projected junctions on the exact support line; independently rounding
    // them would insert a microscopic kink and prevent safe collinear merging.
    const out=[{x:A.q.x,y:A.q.y}];let acc=0;
    for(let cycle=0;cycle<2;cycle++)for(let i=0;i<poly.length-1;i++){
      if(i)acc+=dist(poly[i-1],poly[i]);else acc=cycle*total;
      if(acc>A.s+1e-7&&acc<finish-1e-7)out.push(poly[i]);
    }
    out.push({x:B.q.x,y:B.q.y});return out;
  }
  function installPolygonGuides(g,faces,tol) {
    const proposals=[];
    for(const face of faces) {
      const rings=g.loops[face.id];if(rings.length!==1||face.size<20)continue;
      const raw=ringPoints(rings[0],g.chains,'samples');if(raw.length>12000)continue;
      if(closedPrimitive(raw,tol))continue;
      const fit=fitPolygon(raw,tol);
      if(fit) {
        const capsule=rings[0].length===1&&g.chains[rings[0][0]>>1].freeLoop?fitCapsule(raw,tol):null;
        if(capsule&&capsule.error.rms<fit.error.rms*.95)continue;
        proposals.push({face,ring:rings[0],fit});
      }
    }
    proposals.sort((a,b)=>a.fit.points.length-b.fit.points.length||a.fit.error.rms-b.fit.error.rms);
    let accepted=0;
    for(const proposal of proposals) {
      const todo=[],positions=new Map();let ok=true;
      for(const he of proposal.ring){
        const c=g.chains[he>>1];if(c.guide){ok=false;break;}
        const pts=c.freeLoop?((he&1)?proposal.fit.points.slice().reverse():proposal.fit.points.slice()):polygonPart(proposal.fit.points,c.raw[0],c.raw[c.raw.length-1],!(he&1));

        // An interior interface cannot occupy the frame, whose outside face
        // is -1. A projection near a polygon corner can add a border backtrack.
        const overlapsFrame=c.right>=0&&c.left>=0&&pts.slice(1).some((p,i)=>{
          const q=pts[i];
          return !same(p,q)&&((p.x===q.x&&(p.x===0||p.x===g.w))||(p.y===q.y&&(p.y===0||p.y===g.h)));
        });
        if(overlapsFrame) {
          ok=false;
          break;
        }
        if(!bidirectionalError(c.samples,pts,Math.min(tol,c.detailTolerance||tol))){ok=false;break;}
        if(!c.freeLoop)for(const [node,p] of [[c.a,pts[0]],[c.b,pts[pts.length-1]]]){
          if(dist(node.original,p)>Math.min(tol,c.detailTolerance||tol)){ok=false;break;}
          if((node.x===0&&p.x!==0)||(node.x===g.w&&p.x!==g.w)||(node.y===0&&p.y!==0)||(node.y===g.h&&p.y!==g.h)){ok=false;break;}
          if(node.locked&&dist(node.p,p)>1e-8){ok=false;break;}
          positions.set(node.id,p);
        }
        todo.push({c,pts});
      }
      if(!ok)continue;
      for(const [id,p] of positions){const n=g.nodes.get(id);n.p=p;n.locked=true;}
      for(const {c,pts} of todo)c.guide=pts;
      accepted++;
    }
    return accepted;
  }
  function closestEllipsePoint(m,p) {
    const co=Math.cos(m.angle),si=Math.sin(m.angle),x=co*(p.x-m.cx)+si*(p.y-m.cy),y=-si*(p.x-m.cx)+co*(p.y-m.cy);
    let t=Math.atan2(y/m.ry,x/m.rx);
    for(let i=0;i<10;i++) {
      const c=Math.cos(t),s=Math.sin(t),px=m.rx*c,py=m.ry*s,dx=-m.rx*s,dy=m.ry*c,den=dx*dx+dy*dy+(px-x)*(-m.rx*c)+(py-y)*(-m.ry*s);
      if(Math.abs(den)<1e-10)break;const step=clamp(((px-x)*dx+(py-y)*dy)/den,-.25,.25);t-=step;if(Math.abs(step)<1e-10)break;
    }
    return {p:ellipsePoint(m,t),t};
  }
  function installPrimitiveGuides(g,faces,tol) {
    let count=0;
    for(const face of faces)for(const ring of g.loops[face.id]) {
      if(ring.length<2||face.size<24)continue;
      const chains=ring.map(he=>g.chains[he>>1]);if(chains.some(c=>c.guide||c.curveGuide))continue;
      const raw=ringPoints(ring,g.chains,'samples');if(raw.length>16000)continue;
      const limit=Math.min(tol,...chains.map(c=>c.detailTolerance||tol)),fit=closedPrimitive(raw,limit);if(!fit)continue;
      const positions=new Map(),todo=[];let ok=true;
      for(const c of chains) {
        const a=closestEllipsePoint(fit.model,c.a.original),b=closestEllipsePoint(fit.model,c.b.original);
        for(const [node,q] of [[c.a,a.p],[c.b,b.p]]) {
          if(dist(node.original,q)>limit||(node.locked&&!same(node.p,q))||node.x===0||node.y===0||node.x===g.w||node.y===g.h){ok=false;break;}
          positions.set(node.id,q);
        }
        if(!ok)break;
        let last=a.t,total=0;
        for(const q of c.samples.slice(1,-1)) {const t=closestEllipsePoint(fit.model,q).t;let d=t-last;while(d>Math.PI)d-=TAU;while(d<-Math.PI)d+=TAU;total+=d;last=t;}
        let delta=b.t-a.t;if(total>=0){while(delta<=0)delta+=TAU;}else{while(delta>=0)delta-=TAU;}
        const s={type:'A',a:a.p,b:b.p,...fit.model,start:a.t,delta,sweep:delta>0?1:0,large:Math.abs(delta)>Math.PI?1:0};
        if(!bidirectionalError(c.samples,flatten([s],.025),limit)){ok=false;break;}
        todo.push({c,s});
      }
      if(!ok)continue;
      for(const [id,p] of positions){const node=g.nodes.get(id);node.p=p;node.locked=true;}
      for(const {c,s} of todo){s.a=c.a.p;s.b=c.b.p;c.curveGuide=[s];c.guideKind=fit.type;}
      count++;
    }
    return count;
  }
  function installJunctionTangents(g) {
    const incident=new Map();let joined=0;
    for(const c of g.chains)if(!c.freeLoop&&!c.closed&&c.samples.length>=8)for(const [node,start] of [[c.a,true],[c.b,false]]) {
      if(node.out.length!==3)continue;
      const p=(start?c.samples:c.samples.slice().reverse()).slice();p[0]=node.p;
      let t;
      if(c.curveGuide){t=segmentTangent(start?c.curveGuide[0]:c.curveGuide[c.curveGuide.length-1],start);if(!start)t={x:-t.x,y:-t.y};}
      else if(c.guide){const q=start?c.guide[1]:c.guide[c.guide.length-2];t=unit(q.x-node.p.x,q.y-node.p.y);}
      else t=tangentAt(p,0,Math.min(9,Math.max(3,p.length/3)));
      if(!incident.has(node.id))incident.set(node.id,[]);incident.get(node.id).push({c,start,t,fixed:!!(c.guide||c.curveGuide)});
    }
    for(const entries of incident.values()) {
      let pair=null,best=-.95;
      for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++) {
        const a=entries[i],b=entries[j],dot=a.t.x*b.t.x+a.t.y*b.t.y;
        if(dot<best){best=dot;pair=[a,b];}
      }
      if(!pair)continue;const [a,b]=pair;
      if(a.fixed&&b.fixed)continue;
      const t=a.fixed?a.t:b.fixed?{x:-b.t.x,y:-b.t.y}:unit(a.t.x-b.t.x,a.t.y-b.t.y);
      for(const [entry,sign] of [[a,1],[b,-1]])if(!entry.fixed) {
        const forward=entry.start?sign:-sign;entry.c[entry.start?'tangentA':'tangentB']={x:t.x*forward,y:t.y*forward};
      }
      joined++;
    }
    return joined;
  }

  function clearancePreserved(raw,flat,tol) {
    // Keep narrow openings between non-neighboring arms. This checks raw
    // vertices in a local grid, skips pairs under 12px of contour arclength,
    // and detects fitted clearance loss only above 0.75px; sub-sample gaps can
    // therefore escape this bounded check.
    const closed=raw.length>2&&same(raw[0],raw[raw.length-1]),n=closed?raw.length-1:raw.length;
    if(n<24)return true;
    const positions=new Float64Array(n);let total=0;
    for(let i=1;i<n;i++){total+=dist(raw[i-1],raw[i]);positions[i]=total;}
    if(closed)total+=dist(raw[n-1],raw[0]);
    const maxGap=Math.min(6,2*tol+1),cellSize=maxGap,grid=new Map();
    const key=(x,y)=>x+':'+y;
    const nearest=q=>{
      const hit={x:0,y:0};
      return Number.isFinite(nearestPolyline(q,flat,hit))?hit:null;
    };
    for(let i=0;i<n;i++) {
      const p=raw[i],cx=Math.floor(p.x/cellSize),cy=Math.floor(p.y/cellSize);
      let nearestIndex=-1,nearestDistance=maxGap;
      for(let y=cy-1;y<=cy+1;y++)for(let x=cx-1;x<=cx+1;x++)for(const j of grid.get(key(x,y))||[]) {
        let along=Math.abs(positions[i]-positions[j]);if(closed)along=Math.min(along,total-along);
        if(along<12)continue;
        const distance=dist(p,raw[j]);
        if(distance<nearestDistance){nearestDistance=distance;nearestIndex=j;}
      }
      if(nearestIndex>=0) {
        const a=nearest(p),b=nearest(raw[nearestIndex]);
        if(a&&b&&dist(a,b)<nearestDistance-.75)return false;
      }
      const cell=key(cx,cy),entries=grid.get(cell)||[];entries.push(i);grid.set(cell,entries);
    }
    return true;
  }
  function fitChain(c,tol,exact=false,clearanceTolerance=null) {
    tol=Math.min(tol,c.detailTolerance||tol);
    clearanceTolerance??=tol;
    c.primitive=null;c.fitTolerance=exact?0:tol;c.exact=exact;c.sampleFallback=false;
    let p=(exact?c.raw:c.samples||c.raw).slice();
    const preserveStraight=c.preserveStraight||c.samples===c.raw;
    if(!c.freeLoop){p[0]=c.a.p;p[p.length-1]=c.b.p;}
    if(exact)c.segments=rawSegments(p);
    else if(c.curveGuide)c.segments=c.curveGuide;
    else if(c.guide)c.segments=c.guide.slice(1).map((q,i)=>line(c.guide[i],q));
    else if(c.samples===c.raw&&p.length<=13)c.segments=rawSegments(p);
    else if(c.freeLoop) {
      const primitive=closedPrimitive(p,tol);
      if(primitive){c.primitive=primitive;c.segments=primitive.segments;}
      else {
        const poly=fitPolygon(p,tol),capsule=fitCapsule(p,tol);
        if(capsule&&(!poly||capsule.error.rms<poly.error.rms*.95)) {
          const rounded=roundedRectangle(p,tol);
          c.primitive=rounded&&rounded.error.rms<=capsule.error.rms+.02?rounded:null;
          c.segments=(c.primitive||capsule).segments;
        }
        else if(poly)c.segments=poly.points.slice(1).map((q,i)=>line(poly.points[i],q));
        else {
          const rounded=roundedRectangle(p,tol);
          if(rounded){c.primitive=rounded;c.segments=rounded.segments;}
          else c.segments=fitClosed(p,tol,true,preserveStraight);
        }
      }
    } else if(c.closed)c.segments=fitClosed(p,tol,false,preserveStraight);
    else c.segments=fitOpen(p,tol,c.tangentA,c.tangentB,preserveStraight);
    c.flatTolerance=.0125;
    c.flat=flatten(c.segments,c.flatTolerance);
    // The final assembled chain's fidelity is checked too. Safe topology alone
    // does not justify accepting a poor geometric approximation.
    if(!exact&&!bidirectionalError(p,c.flat,tol+.02)) {
      c.primitive=null;c.sampleFallback=true;c.segments=rawSegments(p);c.flat=flatten(c.segments,.0125);
    }
    // A tighter fit must still inspect the original neighborhood. Shrinking
    // the search with each retry can hide the pair that rejected its guide.

    if(!exact&&!clearancePreserved(p,c.flat,clearanceTolerance)) {
      c.clearanceRetries=(c.clearanceRetries||0)+1;
      if(c.curveGuide||c.guide)c.clearanceGuideDrops=(c.clearanceGuideDrops||0)+1;
      const tighter=tol*.5;
      if(tighter>1e-5&&tighter<tol-1e-9) {
        c.detailTolerance=Math.min(c.detailTolerance,tighter);
        if(c.curveGuide)c.curveGuide=null;
        if(c.guide)c.guide=null;
        c.guideKind=null;
        fitChain(c,tighter,false,clearanceTolerance);
      }
      else {
        c.primitive=null;c.sampleFallback=true;c.segments=rawSegments(p);c.flat=flatten(c.segments,.0125);
      }
    }
  }
  function fitGraph(g,faces,tol,guides=true,exact=false) {
    for(const n of g.nodes.values()){n.p=n.original;n.locked=false;}
    for(const c of g.chains){
      c.guide=null;c.curveGuide=null;c.guideKind=null;c.primitive=null;c.retry=0;c.tangentA=null;c.tangentB=null;
      c.detailTolerance=tol;
      c.preserveStraight=false;
      if(g.preserveDetails&&!exact) {
        // Opposite boundaries can each consume their error allowance. Limit
        // visible width changes as well as preventing an outline from closing.
        // Retain the quarter-pixel floor for noisy, one-pixel-wide features.
        for(const [side,id] of [[0,c.right],[1,c.left]])if(id>=0&&faces[id].color>=0&&!faces[id].omit) {
          const depth=faces[id].needsLocalDepth&&Number.isFinite(c.localDepth?.[side])?c.localDepth[side]:faces[id].depth;
          if(depth<=2) {
            c.detailTolerance=Math.min(c.detailTolerance,Math.max(.25,.15+.1*depth));
            c.preserveStraight=true;
          }
        }
      }
    }
    const guideCount=guides&&!exact?installPolygonGuides(g,faces,tol):0;
    g.primitiveGuides=guides&&!exact&&g.smoothJunctions?installPrimitiveGuides(g,faces,tol):0;
    g.junctionJoins=!exact&&g.smoothJunctions?installJunctionTangents(g):0;
    for(const c of g.chains)fitChain(c,tol,exact);
    return guideCount;
  }
  function repairGraph(g,faces,tol,progress) {
    let validation=validate(g,faces),passes=0,globalExactFallback=false;
    const repaired=new Set();
    // Retry only implicated interfaces. One tiny feature must not force every
    // unrelated circle and smooth curve in the document down to raster stairs.
    while(!validation.ok&&passes<12) {
      passes++;
      const affected=new Set(validation.bad),reset=new Set();let changed=true;
      while(changed) {
        changed=false;
        for(const id of affected) {
          const c=g.chains[id];
          if(!c.freeLoop)for(const n of [c.a,c.b])if(!same(n.p,n.original)&&!reset.has(n.id)){
            reset.add(n.id);changed=true;
          }
        }
        for(const c of g.chains)if(!c.freeLoop&&(reset.has(c.a.id)||reset.has(c.b.id))&&!affected.has(c.id)){
          affected.add(c.id);changed=true;
        }
      }
      for(const id of reset){const n=g.nodes.get(id);n.p=n.original;n.locked=false;}
      progress(`Repairing ${affected.size} boundary chains locally (pass ${passes})`);
      for(const id of affected) {
        const c=g.chains[id];repaired.add(id);c.guide=null;c.curveGuide=null;c.guideKind=null;c.retry=Math.min(3,c.retry+1);
        // Tighten the actual fit budget, including any thin-detail cap.
        fitChain(c,c.fitTolerance/2,c.retry===3);
      }
      validation=validate(g,faces);
    }
    if(!validation.ok) {
      // Last-resort safety net, after local repairs have been exhausted.
      globalExactFallback=true;fitGraph(g,faces,0,false,true);validation=validate(g,faces,true);
    }
    return {validation,repairPasses:passes,repairedChains:repaired.size,globalExactFallback};
  }
  function segmentConflict(a,b,c,d,allowEndpoint=false) {
    const tol=1e-8;
    if(Math.max(a.x,b.x)<Math.min(c.x,d.x)-tol||Math.max(c.x,d.x)<Math.min(a.x,b.x)-tol||Math.max(a.y,b.y)<Math.min(c.y,d.y)-tol||Math.max(c.y,d.y)<Math.min(a.y,b.y)-tol)return false;
    const ab1=cross(a,b,c),ab2=cross(a,b,d),cd1=cross(c,d,a),cd2=cross(c,d,b);
    if(((ab1>tol&&ab2<-tol)||(ab1<-tol&&ab2>tol))&&((cd1>tol&&cd2<-tol)||(cd1<-tol&&cd2>tol)))return true;
    const touches=[];
    if(Math.abs(ab1)<=tol&&project(c,a,b).d<=tol)touches.push(c);
    if(Math.abs(ab2)<=tol&&project(d,a,b).d<=tol)touches.push(d);
    if(Math.abs(cd1)<=tol&&project(a,c,d).d<=tol)touches.push(a);
    if(Math.abs(cd2)<=tol&&project(b,c,d).d<=tol)touches.push(b);
    if(!touches.length)return false;
    if(!allowEndpoint)return true;
    // An allowed common vertex must not extend to an overlapping interval.
    return touches.some(p=>!((same(p,a)||same(p,b))&&(same(p,c)||same(p,d))))||
      (touches.some(p=>dist(p,touches[0])>tol));
  }
  function inside(p,poly) {
    let yes=false;for(let i=1;i<poly.length;i++){const a=poly[i-1],b=poly[i];if((a.y>p.y)!==(b.y>p.y)&&p.x<(b.x-a.x)*(p.y-a.y)/(b.y-a.y)+a.x)yes=!yes;}return yes;
  }
  function witnesses(ids,w,h,faces,preserveDetails=false,rgb=null,palette=[],noise=0,g=null) {
    const d=new Int32Array(w*h);d.fill(w+h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const p=y*w+x;if(!x||!y||x===w-1||y===h-1||(x&&ids[p-1]!==ids[p])||(y&&ids[p-w]!==ids[p])||(x+1<w&&ids[p+1]!==ids[p])||(y+1<h&&ids[p+w]!==ids[p]))d[p]=0;
      else d[p]=Math.min(d[p],d[p-1]+1,d[p-w]+1);
    }
    for(let y=h-1;y>=0;y--)for(let x=w-1;x>=0;x--){const p=y*w+x;if(x+1<w&&ids[p]===ids[p+1])d[p]=Math.min(d[p],d[p+1]+1);if(y+1<h&&ids[p]===ids[p+w])d[p]=Math.min(d[p],d[p+w]+1);}
    for(const f of faces){f.depth=-1;f.witness=point(f.seed%w+.5,Math.floor(f.seed/w)+.5);}
    for(let p=0;p<d.length;p++){const f=faces[ids[p]];if(d[p]>f.depth){f.depth=d[p];f.witness=point(p%w+.5,Math.floor(p/w)+.5);}}
    if(preserveDetails) {
      const cells=new Map(),stride=Math.ceil(w/24);
      const confidence=p=>{const color=faces[ids[p]].color;if(color<0||!rgb)return 0;const paint=palette[color].rgb;return sq(rgb[3*p]-paint[0])+sq(rgb[3*p+1]-paint[1])+sq(rgb[3*p+2]-paint[2]);};
      for(let p=0;p<d.length;p++) {
        const x=p%w,y=Math.floor(p/w),id=ids[p],key=(Math.floor(y/24)*stride+Math.floor(x/24))*faces.length+id;
        const old=cells.get(key);if(old===undefined||d[p]>d[old]||d[p]===d[old]&&confidence(p)<confidence(old))cells.set(key,p);
      }
      const byFace=faces.map(()=>[]);for(const p of cells.values())if(d[p]>=1||faces[ids[p]].depth<=2&&confidence(p)<3*sq(Math.max(12,noise*1.4)))byFace[ids[p]].push(p);
      for(const f of faces) {
        const list=byFace[f.id],step=Math.max(1,Math.ceil(list.length/160));f.probes=[];
        for(let i=0;i<list.length;i+=step){const p=list[i];f.probes.push(point(p%w+.5,Math.floor(p/w)+.5));}
      }
      if(g) {
        // A connected outline can have a thick miter and thin branches. Measure
        // boundary depth locally so the miter does not mask those narrow runs.
        // Restrict this to faces with a narrow area-to-perimeter ratio; corner
        // normals on a broad fill can otherwise produce misleading low depths.
        // Already thin faces retain their established tolerance; this only
        // recovers protection hidden by a thick part of a connected network.
        const boundaryEdges=new Uint32Array(faces.length);
        for(const c of g.chains)for(const id of new Set([c.right,c.left]))if(id>=0)boundaryEdges[id]+=c.raw.length-1;
        for(const f of faces)f.needsLocalDepth=f.depth>2&&f.size/Math.max(1,boundaryEdges[f.id])<=3;
        const depthAt=(x,y,id,dx,dy)=>{
          let depth=0;
          for(let step=0;step<=4;step++) {
            const px=x+step*dx,py=y+step*dy;
            if(px<0||px>=w||py<0||py>=h)break;
            const p=py*w+px;if(ids[p]!==id)break;
            depth=Math.max(depth,d[p]);
          }
          return depth;
        };
        for(const c of g.chains) {
          const local=[[],[]];
          for(let i=1;i<c.raw.length;i++) {
            const a=c.raw[i-1],b=c.raw[i],mx=(a.x+b.x)/2,my=(a.y+b.y)/2,nx=a.y-b.y,ny=b.x-a.x;
            if(c.right>=0&&faces[c.right].color>=0&&!faces[c.right].omit&&faces[c.right].needsLocalDepth) {
              const x=Math.floor(mx+.5*nx),y=Math.floor(my+.5*ny);
              if(x>=0&&x<w&&y>=0&&y<h&&ids[y*w+x]===c.right)local[0].push(depthAt(x,y,c.right,nx,ny));
            }
            if(c.left>=0&&faces[c.left].color>=0&&!faces[c.left].omit&&faces[c.left].needsLocalDepth) {
              const x=Math.floor(mx-.5*nx),y=Math.floor(my-.5*ny);
              if(x>=0&&x<w&&y>=0&&y<h&&ids[y*w+x]===c.left)local[1].push(depthAt(x,y,c.left,-nx,-ny));
            }
          }
          if(local.some(samples=>samples.length)) {
            c.localDepth=local.map(samples=>{
              if(!samples.length)return null;
              samples.sort((a,b)=>a-b);
              return samples[Math.floor((samples.length-1)*.2)];
            });
          }
        }
      }
    }
  }
  function validate(g,faces,exact=false,allowRefinement=true) {
    const bad=new Set(),uncertain=new Set(),hash=new Map(),segments=[],cell=12;
    const mark=(a,b)=>{bad.add(a);if(b!==undefined)bad.add(b);};
    for(const c of g.chains){
      const p=c.flat;
      for(let i=1;i<p.length;i++){
        const a=p[i-1],b=p[i];if(dist2(a,b)<1e-18)continue;
        if([a,b].some(q=>q.x< -1e-7||q.y< -1e-7||q.x>g.w+1e-7||q.y>g.h+1e-7))mark(c.id);
        const s={a,b,c:c.id,i,n:p.length-1,curved:c.segments.some(s=>s.type!=='L')},id=segments.length,found=new Set();segments.push(s);
        const xmin=Math.floor((Math.min(a.x,b.x)-.026)/cell),xmax=Math.floor((Math.max(a.x,b.x)+.026)/cell),ymin=Math.floor((Math.min(a.y,b.y)-.026)/cell),ymax=Math.floor((Math.max(a.y,b.y)+.026)/cell);
        for(let y=ymin;y<=ymax;y++)for(let x=xmin;x<=xmax;x++){
          const key=x+','+y,bin=hash.get(key)||[];
          for(const j of bin)if(!found.has(j)){
            found.add(j);const t=segments[j],other=g.chains[t.c];
            const adjacent=c.id===t.c&&(Math.abs(i-t.i)===1||(c.closed&&((i===1&&t.i===s.n)||(t.i===1&&i===s.n))));
            let allowed=adjacent;
            if(c.id!==t.c){
              for(const [u,pu] of [[c.a,p[0]],[c.b,p[p.length-1]]])for(const [v,pv] of [[other.a,other.flat[0]],[other.b,other.flat[other.flat.length-1]]])
                if(u===v&&same(pu,pv)&&(same(a,pu)||same(b,pu))&&(same(t.a,pv)||same(t.b,pv)))allowed=true;
            }
            if(segmentConflict(a,b,t.a,t.b,allowed))mark(c.id,t.c);
            // A close pair of chords may be ambiguous at the current precision.
            // Keep the margin tied to each curve's actual flattening bound.
            else if(!allowed&&(s.curved||t.curved)&&Math.min(project(a,t.a,t.b).d,project(b,t.a,t.b).d,project(t.a,a,b).d,project(t.b,a,b).d)<(s.curved?c.flatTolerance:0)+(t.curved?other.flatTolerance:0)+.0001) {
              mark(c.id,t.c);
              uncertain.add(c.id);
              uncertain.add(t.c);
            }
          }
          if(!hash.has(key))hash.set(key,bin);bin.push(id);
        }
      }
    }
    // Resolve chord uncertainty locally before changing otherwise valid curves.
    // Any ambiguity remaining after this one refinement still requires repair.
    if(allowRefinement) {
      let refined=false;
      for(const id of uncertain) {
        const c=g.chains[id];
        if(c.flatTolerance<=.001||!c.segments.some(s=>s.type!=='L'))continue;
        c.flatTolerance=.001;
        c.flat=flatten(c.segments,c.flatTolerance);
        refined=true;
      }
      if(refined)return validate(g,faces,exact,false);
    }
    // Preserve the cyclic order of incident boundaries at every junction.
    const incident=new Map();
    for(const c of g.chains)if(!c.freeLoop)for(const [n,atStart] of [[c.a,true],[c.b,false]]){
      const p=atStart?c.flat:c.flat.slice().reverse(),q=p.find(v=>dist2(v,p[0])>1e-8);if(!q){mark(c.id);continue;}
      if(!incident.has(n.id))incident.set(n.id,[]);
      const raw=atStart?c.raw:c.raw.slice().reverse();incident.get(n.id).push({id:c.id,token:c.id*2+(atStart?0:1),original:Math.atan2(raw[1].y-raw[0].y,raw[1].x-raw[0].x),angle:Math.atan2(q.y-p[0].y,q.x-p[0].x)});
    }
    for(const entries of incident.values())if(entries.length>=3){
      const a=entries.slice().sort((u,v)=>u.original-v.original).map(e=>e.token),b=entries.slice().sort((u,v)=>u.angle-v.angle).map(e=>e.token),off=b.indexOf(a[0]);
      if(a.some((id,i)=>id!==b[(off+i)%b.length]))entries.forEach(e=>mark(e.id));
    }
    const models=faces.map(f=>{
      const rings=g.loops[f.id].map(r=>ringPoints(r,g.chains,'flat')),pts=rings.flat();
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const p of pts){minX=Math.min(minX,p.x);maxX=Math.max(maxX,p.x);minY=Math.min(minY,p.y);maxY=Math.max(maxY,p.y);}
      const signed=rings.reduce((s,p)=>s+area(p),0);if(signed<=1e-8)g.loops[f.id].flat().forEach(h=>mark(h>>1));
      return {rings,minX,minY,maxX,maxY};
    });
    // Detect vanished features and changed nesting, which intersections alone miss.
    // All faces, including transparent / removed background faces, participate.
    for(const f of faces)for(const p of [f.witness,...(f.probes||[])]){
      const owners=[];
      for(let i=0;i<models.length;i++){const m=models[i];if(p.x<m.minX||p.x>m.maxX||p.y<m.minY||p.y>m.maxY)continue;let yes=false;for(const r of m.rings)if(inside(p,r))yes=!yes;if(yes)owners.push(i);}
      if(owners.length!==1||owners[0]!==f.id) {
        // A face can have many unrelated hole boundaries. Blaming all of a
        // background face's loops makes one vanished speck degrade the whole
        // drawing. Blame only loops whose containment changed at this witness.
        if(!g.rawRings)g.rawRings=g.loops.map(rs=>rs.map(r=>ringPoints(r,g.chains)));
        let found=false;
        for(const id of new Set([f.id,...owners]))for(let j=0;j<g.loops[id].length;j++) {
          if(inside(p,models[id].rings[j])!==inside(p,g.rawRings[id][j])){
            // A loop may itself contain long, perfectly good chains. Attribute
            // this displacement to the swept band of each individual interface:
            // raster chain -> fitted endpoint -> reversed fit -> raster start.
            // Connectors cancel in pairs around the face, so an odd containment
            // change must be explained by at least one of these bands. This
            // avoids blaming an entire body outline for a tiny adjacent sliver.
            let localized=false;
            for(const he of g.loops[id][j]) {
              const c=g.chains[he>>1],swept=c.raw.concat(c.flat.slice().reverse(),[c.raw[0]]);
              if(inside(p,swept)){mark(c.id);localized=true;}
            }
            if(!localized)g.loops[id][j].forEach(h=>mark(h>>1));
            found=true;
          }
        }
        if(!found)g.loops[f.id].flat().forEach(h=>mark(h>>1));
      }
    }
    return {ok:bad.size===0,bad,models,checkedSegments:segments.length};
  }
  function segmentString(s) {
    if(s.type==='L')return `L${xy(s.b)}`;
    if(s.type==='C')return `C${xy(s.c1)} ${xy(s.c2)} ${xy(s.b)}`;
    return `A${fmt(s.rx)} ${fmt(s.ry)} ${fmt(s.angle*180/Math.PI)} ${s.large} ${s.sweep} ${xy(s.b)}`;
  }
  function faceSegments(ring,chains) {const out=[];for(const he of ring){const ss=chains[he>>1].segments;if(he&1){for(let i=ss.length-1;i>=0;i--)out.push(reverse(ss[i]));}else{for(const s of ss)out.push(s);}}return out;}
  function pathString(segments) {return segments.length?`M${xy(segments[0].a)}${segments.map(segmentString).join('')}Z`:'';}
  function polygonVertices(segments) {
    if(!segments.length||segments.some(s=>s.type!=='L'))return null;
    const pts=segments.map(s=>s.a);let changed=true;
    while(changed&&pts.length>3){changed=false;for(let i=0;i<pts.length;i++){
      const a=pts[(i+pts.length-1)%pts.length],b=pts[i],c=pts[(i+1)%pts.length];
      if(project(b,a,c).d<1e-9){pts.splice(i,1);changed=true;break;}
    }}
    return pts.length<=128?pts:null;
  }
  function exportSVG(g,faces,palette,options) {
    const visible=f=>f.color>=0&&!f.omit,parts=[],counts={circle:0,ellipse:0,rect:0,polygon:0,path:0,lines:0,arcs:0,cubics:0};
    for(const f of faces)if(visible(f)){
      const rings=g.loops[f.id],fill=palette[f.color].hex;
      if(!rings.length)continue;
      const all=rings.map(r=>faceSegments(r,g.chains));
      for(const s of all.flat())counts[s.type==='L'?'lines':s.type==='A'?'arcs':'cubics']++;
      if(rings.length===1){
        const ring=rings[0],c=ring.length===1?g.chains[ring[0]>>1]:null;
        const neighbor=c?(c.right===f.id?c.left:c.right):-1;
        // Basic ellipses and path arcs are rasterized differently by some engines.
        // Use the exact same arc commands on BOTH painted sides of a shared border.
        // A native circle/ellipse element is safe when the other face is not painted.
        if(c&&c.primitive&&(c.primitive.model.angle===0||c.primitive.type==='roundedRect')&&(neighbor<0||!visible(faces[neighbor]))){
          const {type,model:m}=c.primitive;counts[type==='roundedRect'?'rect':type]++;
          if(type==='roundedRect')parts.push(`<rect fill="${fill}" x="${fmt(m.x)}" y="${fmt(m.y)}" width="${fmt(m.width)}" height="${fmt(m.height)}" rx="${fmt(m.r)}"/>`);
          else if(type==='circle')parts.push(`<circle fill="${fill}" cx="${fmt(m.cx)}" cy="${fmt(m.cy)}" r="${fmt(m.rx)}"/>`);
          else parts.push(`<ellipse fill="${fill}" cx="${fmt(m.cx)}" cy="${fmt(m.cy)}" rx="${fmt(m.rx)}" ry="${fmt(m.ry)}"/>`);
          continue;
        }
        const poly=polygonVertices(all[0]);
        if(poly){
          const xs=poly.map(p=>p.x),ys=poly.map(p=>p.y),minX=Math.min(...xs),maxX=Math.max(...xs),minY=Math.min(...ys),maxY=Math.max(...ys);
          if(poly.length===4&&poly.every(p=>(p.x===minX||p.x===maxX)&&(p.y===minY||p.y===maxY))){counts.rect++;parts.push(`<rect fill="${fill}" x="${fmt(minX)}" y="${fmt(minY)}" width="${fmt(maxX-minX)}" height="${fmt(maxY-minY)}"/>`);}
          else {counts.polygon++;parts.push(`<polygon fill="${fill}" points="${poly.map(p=>`${fmt(p.x)},${fmt(p.y)}`).join(' ')}"/>`);}
          continue;
        }
      }
      counts.path++;parts.push(`<path fill="${fill}" fill-rule="evenodd" d="${all.map(pathString).join('')}"/>`);
    }
    const ow=Number(options.outputWidth??g.w),oh=Number(options.outputHeight??g.h);
    if(!Number.isFinite(ow)||!Number.isFinite(oh)||ow<=0||oh<=0)throw Error('Invalid SVG output dimensions.');
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${ow}" height="${oh}" viewBox="0 0 ${g.w} ${g.h}">\n${parts.join('\n')}\n</svg>`;
    return {svg,counts};
  }
  function smoothnessReport(chains) {
    let smoothJoins=0,maxSmoothJoinAngle=0;
    for(const c of chains)for(let i=0;i<c.segments.length;i++) {
      const b=c.segments[i],a=c.segments[(i+c.segments.length-1)%c.segments.length];
      if(!b.smoothStart||a.type!=='C'||b.type!=='C')continue;
      const u=unit(a.b.x-a.c2.x,a.b.y-a.c2.y),v=unit(b.c1.x-b.a.x,b.c1.y-b.a.y);
      smoothJoins++;maxSmoothJoinAngle=Math.max(maxSmoothJoinAngle,Math.acos(clamp(u.x*v.x+u.y*v.y,-1,1))*180/Math.PI);
    }
    return {smoothJoins,maxSmoothJoinAngleDegrees:maxSmoothJoinAngle};
  }
  function trace(image,options={},progress=()=>{}) {
    const {width:w,height:h,data}=image;
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1||!data||data.length!==w*h*4)throw Error('Expected RGBA data with valid width and height.');
    if(w*h>4_000_000)throw Error('The working raster is limited to 4 million pixels.');
    const opts={colors:0,tolerance:1.25,noise:10,minArea:6,removeBackground:false,preserveDetails:true,smoothJunctions:true,...options};
    for(const key of ['colors','tolerance','noise','minArea'])if(!Number.isFinite(+opts[key]))throw Error(`Invalid ${key}.`);
    opts.colors=clamp(Math.round(opts.colors),0,64);opts.tolerance=clamp(+opts.tolerance,.15,6);opts.noise=clamp(+opts.noise,0,40);opts.minArea=clamp(Math.round(opts.minArea),0,10000);
    const started=Date.now();progress('Denoising and finding flat colors');
    const {rgb,opaque,alpha}=prepare(data,w,h,opts.noise),{palette,labels,relabeledPixels:decodedRelabeledPixels=0,uncertainPixels=0,recoveredPaints=0,threePaintPixels=0,weakPaintPixels=0,mixtures=new Map()}=quantize(rgb,opaque,w,h,opts.colors,opts.noise,opts.preserveDetails,alpha,opts.noise>0?data:null);
    progress('Separating regions and removing small speckles');
    const removedPixels=removeSpeckles(labels,w,h,opts.minArea,palette,opts.preserveDetails);
    let {ids,list:faces}=components(labels,w,h);
    if(faces.length>5000)throw Error('More than 5,000 regions. Increase speckle cleanup or reduce the working size.');
    const sourceRelabeledPixels=refineSourceOwnership(data,labels,ids,faces,palette,w,h,opts.noise,mixtures);
    if(sourceRelabeledPixels) {
      ({ids,list:faces}=components(labels,w,h));
      if(faces.length>5000)throw Error('More than 5,000 regions. Increase speckle cleanup or reduce the working size.');
    }
    const relabeledPixels=decodedRelabeledPixels+sourceRelabeledPixels;
    const retainedThreePaintPixels=sourceRelabeledPixels?[...mixtures.values()].filter(mixture=>mixture.paints.length===3).length:threePaintPixels;
    let background=-1;
    if(opts.removeBackground){const border=new Map();const add=p=>{border.set(labels[p],(border.get(labels[p])||0)+1);};
      for(let x=0;x<w;x++){add(x);if(h>1)add((h-1)*w+x);}for(let y=1;y<h-1;y++){add(y*w);if(w>1)add(y*w+w-1);}
      if(border.size)background=[...border.entries()].sort((a,b)=>b[1]-a[1])[0][0];
      for(const f of faces)f.omit=f.touch&&f.color===background;
    }
    progress('Building one shared boundary network');
    const g=graphOf(ids,w,h,faces);g.noise=opts.noise;g.preserveDetails=!!opts.preserveDetails;g.smoothJunctions=!!opts.smoothJunctions;
    sampleBoundaries(g,rgb,faces,palette,alpha,mixtures);witnesses(ids,w,h,faces,opts.preserveDetails,rgb,palette,opts.noise,g);
    const warnings=[],tolerance=opts.tolerance;
    progress('Fitting primitives and tangent-continuous curves');
    const guideCount=fitGraph(g,faces,tolerance);
    progress('Checking crossings, junctions, holes, and region ownership');
    const {validation,repairPasses,repairedChains,globalExactFallback}=repairGraph(g,faces,tolerance,progress);
    if(!validation.ok)throw Error('Internal topology validation failed; no potentially overlapping SVG was exported.');
    const fallbackChains=g.chains.filter(c=>c.exact).length;
    const minimumTolerance=g.chains.reduce((m,c)=>Math.min(m,c.fitTolerance),tolerance);
    if(globalExactFallback)warnings.push('Used exact pixel geometry for the whole network after local repairs were exhausted.');
    else if(fallbackChains)warnings.push(`${fallbackChains} boundary chains required exact pixel geometry; unrelated fits were retained.`);
    else if(repairedChains)warnings.push(`Tightened fits on ${repairedChains} boundary chains; unrelated fits were retained.`);
    if(!opts.colors)warnings.push('Automatic color count is heuristic; set the known count to retain tiny accents or distinguish similar paints.');
    if(opts.removeBackground)warnings.push(background<0?'Transparency dominates the border; no opaque background paint was removed.':'Removed only border-connected regions of the most frequent border color; enclosed regions of that color remain.');
    const result=exportSVG(g,faces,palette,opts);
    const stats={version:4,width:w,height:h,colors:palette.length,palette:palette.map(p=>p.hex),regions:faces.length,visibleRegions:faces.filter(f=>f.color>=0&&!f.omit).length,
      recoveredPaints,threePaintPixels:retainedThreePaintPixels,weakPaintPixels,alphaBoundarySamples:g.alphaSamples||0,primitiveGuides:g.primitiveGuides,junctionJoins:g.junctionJoins,
      featureProbes:faces.reduce((n,f)=>n+(f.probes?.length||0),0),detailLimitedChains:g.chains.filter(c=>c.detailTolerance<tolerance).length,
      sampleFallbackChains:g.chains.filter(c=>c.sampleFallback).length,
      sharedChains:g.chains.length,rawEdges:g.edges.length,segments:g.chains.reduce((s,c)=>s+c.segments.length,0),removedPixels,relabeledPixels,uncertainPixels,guideCount,tolerance,
      exactFallback:fallbackChains>0,fallbackChains,minimumTolerance,repairPasses,repairedChains,globalExactFallback,validation:'passed (adaptive flattening within 0.0125 working pixels)',checkedSegments:validation.checkedSegments,
      ...smoothnessReport(g.chains),elements:result.counts,primitives:{circle:g.chains.filter(c=>c.primitive?.type==='circle').length,ellipse:g.chains.filter(c=>c.primitive?.type==='ellipse').length,roundedRect:g.chains.filter(c=>c.primitive?.type==='roundedRect').length},ms:Date.now()-started,warnings};
    const output={svg:result.svg,stats};
    if(opts.debug)output.debug={labels:Array.from(labels),componentIds:Array.from(ids),faces:faces.map(f=>({id:f.id,color:f.color,omit:!!f.omit,witness:f.witness})),chains:g.chains.map(c=>({id:c.id,right:c.right,left:c.left,raw:c.raw,samples:c.samples,segments:c.segments,flat:c.flat,fitTolerance:c.fitTolerance,exact:c.exact,retry:c.retry,sampleFallback:c.sampleFallback,guideKind:c.guideKind,tangentA:c.tangentA,tangentB:c.tangentB,clearanceRetries:c.clearanceRetries||0,clearanceGuideDrops:c.clearanceGuideDrops||0})),loops:g.loops};
    return output;
  }
  return {trace};
}
if (typeof module !== 'undefined' && module.exports) module.exports = {createTracer};
