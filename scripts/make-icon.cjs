// Trace desktop icon: the phone icon's three bars (phone/public/icon-512.png) on a rounded dark tile.
const fs=require('fs'),zlib=require('zlib');
const BG=[0x0b,0x10,0x10],BARS=[[136,196,245,[0xe9,0xcf,0x58]],[226,286,154,[0x5c,0xd0,0xea]],[317,377,208,[0x87,0x96,0x92]]],BOTTOM=385;
const crcT=[...Array(256)].map((_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
const crc=b=>{let c=~0;for(const x of b)c=crcT[(c^x)&255]^(c>>>8);return (~c)>>>0;};
const chunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length);const td=Buffer.concat([Buffer.from(t),d]);const c=Buffer.alloc(4);c.writeUInt32BE(crc(td));return Buffer.concat([l,td,c]);};
function render(S){
  // Design space 512: tile inset 12 with radius 105 (the old icon's proportions); bars scaled into the tile.
  const M=12,R=105,k=(512-2*M)/512,tx=v=>M+v*k; const ss=S<=64?8:4; const u=512/S;
  const raw=Buffer.alloc(S*(S*4+1));
  for(let y=0;y<S;y++){raw[y*(S*4+1)]=0;for(let x=0;x<S;x++){let a=0,r=0,g=0,b=0;
    for(let j=0;j<ss;j++)for(let i=0;i<ss;i++){const px=(x+(i+.5)/ss)*u,py=(y+(j+.5)/ss)*u;
      const cx=Math.min(Math.max(px,M+R),512-M-R),cy=Math.min(Math.max(py,M+R),512-M-R);if((px-cx)**2+(py-cy)**2>R*R)continue;
      let c=BG;for(const [x0,x1,top,col] of BARS)if(px>=tx(x0)&&px<tx(x1)&&py>=tx(top)&&py<tx(BOTTOM))c=col;a++;r+=c[0];g+=c[1];b+=c[2];}
    const o=y*(S*4+1)+1+x*4;if(a){raw[o]=Math.round(r/a);raw[o+1]=Math.round(g/a);raw[o+2]=Math.round(b/a);}raw[o+3]=Math.round(255*a/(ss*ss));}}
  const ih=Buffer.alloc(13);ih.writeUInt32BE(S,0);ih.writeUInt32BE(S,4);ih[8]=8;ih[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);}
const out=process.argv[2];fs.writeFileSync(out+'/icon.png',render(1024));
const sizes=[16,20,24,32,40,48,64,128,256],pngs=sizes.map(render);
const head=Buffer.alloc(6);head.writeUInt16LE(1,2);head.writeUInt16LE(sizes.length,4);let off=6+16*sizes.length;
const dir=Buffer.concat(sizes.map((s,i)=>{const e=Buffer.alloc(16);e[0]=s>=256?0:s;e[1]=s>=256?0:s;e.writeUInt16LE(1,4);e.writeUInt16LE(32,6);e.writeUInt32LE(pngs[i].length,8);e.writeUInt32LE(off,12);off+=pngs[i].length;return e;}));
fs.writeFileSync(out+'/icon.ico',Buffer.concat([head,dir,...pngs]));
for(const s of [16,32,48]) fs.writeFileSync(out+`/preview-${s}.png`,pngs[sizes.indexOf(s)]);
