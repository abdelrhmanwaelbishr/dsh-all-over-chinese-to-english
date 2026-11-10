import { writeFileSync } from 'node:fs'
import zlib from 'node:zlib'
const W = 512, H = 512
const px = Buffer.alloc(W*H*3)
// background gradient (dark navy), centered rounded-ish blue square with 文/A-ish glyph blocks
for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
  const i=(y*W+x)*3
  const t=y/H
  px[i]=Math.round(12+18*t); px[i+1]=Math.round(18+26*t); px[i+2]=Math.round(32+40*t)
}
const R=96, cx=W/2, cy=H/2
const inSquare=(x,y)=>{const dx=Math.max(Math.abs(x-cx)-(R-28),0), dy=Math.max(Math.abs(y-cy)-(R-28),0); return dx*dx+dy*dy <= 28*28}
for (let y=0;y<H;y++) for (let x=0;x<W;x++) {
  if (!inSquare(x,y)) continue
  const i=(y*W+x)*3, t=(x+y-R*2)/(R*2)
  px[i]=Math.round(56+ (40*t)); px[i+1]=Math.round(132+(30*t)); px[i+2]=Math.round(255)
}
// glyph: white strokes forming a stylised "A" + slash
const paint=(x,y,arr)=>{ if(x>=0&&x<W&&y>=0&&y<H){const i=(y*W+x)*3; arr[i]=255; arr[i+1]=255; arr[i+2]=255} }
const stroke=(x1,y1,x2,y2,w)=>{const n=Math.ceil(Math.hypot(x2-x1,y2-y1)*2);for(let k=0;k<=n;k++){const t=k/n,cx2=x1+(x2-x1)*t,cy2=y1+(y2-y1)*t;for(let oy=-w;oy<=w;oy++)for(let ox=-w;ox<=w;ox++)if(ox*ox+oy*oy<=w*w)paint(Math.round(cx2+ox),Math.round(cy2+oy),px)}}
stroke(215,300,256,215,9); stroke(256,215,297,300,9); stroke(232,266,280,266,7)
// raw scanlines
const raw = Buffer.alloc(H*(W*3+1))
for (let y=0;y<H;y++){ raw[y*(W*3+1)]=0; px.copy(raw, y*(W*3+1)+1, y*W*3, (y+1)*W*3) }
const chunk=(type,data)=>{const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const td=Buffer.concat([Buffer.from(type,'ascii'),data]);const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(td)>>>0);return Buffer.concat([len,td,crc])}
let table=null
function crc32(buf){ if(!table){table=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;table[n]=c>>>0}} let c=0xffffffff; for(const b of buf) c=table[(c^b)&0xff]^(c>>>8); return (c^0xffffffff)>>>0 }
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(W,0); ihdr.writeUInt32BE(H,4); ihdr[8]=8; ihdr[9]=2; ihdr[10]=0; ihdr[11]=0; ihdr[12]=0
const png=Buffer.concat([Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]),chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))])
writeFileSync(process.argv[2], png)
console.log('wrote', process.argv[2], png.length)
