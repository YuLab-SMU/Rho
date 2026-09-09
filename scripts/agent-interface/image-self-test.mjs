import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {deflateSync} from 'node:zlib';
import {pngPixels,labelInk,assertLabelCrop} from './image-fixture.mjs';
import {digest} from './runtime.mjs';

function png(width,height,draw) {
  const rows=Buffer.alloc((width*4+1)*height,255);for(let y=0;y<height;y++){rows[y*(width*4+1)]=0;for(let x=0;x<width;x++)if(draw(x,y)){const p=y*(width*4+1)+1+x*4;rows[p]=rows[p+1]=rows[p+2]=0;}}
  const chunk=(tag,data)=>{const result=Buffer.alloc(data.length+12);result.writeUInt32BE(data.length);result.write(tag,4);data.copy(result,8);return result;};
  const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
const original=png(800,600,(x,y)=>x>=635&&x<735&&y>=140&&y<150),roi=labelInk(pngPixels(original));
assert.deepEqual(roi,{x:635,y:140,width:100,height:10,ink_pixels:1000});
assert.throws(()=>labelInk(pngPixels(png(800,600,()=>false))),/actually be visible/);
assert.throws(()=>pngPixels(original.subarray(0,50)),/truncated/);
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rho-crop-proof-test-'));
try {
  const reference={operation_id:'original',sequence:2,sha256:digest(original)},proof={width:800,height:600,label_roi:roi};
  function proxy(crop,bytes,ref=reference){const hash=digest(bytes);fs.writeFileSync(path.join(directory,'crop.png'),bytes);return {images:[{sequence:1,file:'crop.png'}],responses:[{call:{sequence:1,rpc:{params:{name:'rho.output.view.v1',arguments:{crop}}}},result:{structuredContent:{result:{data:{reference:ref,preview_sha256:hash}}}}}]};}
  const crop={x:620,y:125,width:130,height:40},pixels=png(130,40,(x,y)=>x>=15&&x<115&&y>=15&&y<25);
  assertLabelCrop(proxy(crop,pixels),reference,proof,directory);
  assert.throws(()=>assertLabelCrop(proxy(crop,png(130,40,()=>false)),reference,proof,directory),/actually be visible/);
  assert.throws(()=>assertLabelCrop(proxy({...crop,x:0},pixels),reference,proof,directory),/full native validation label/);
  assert.throws(()=>assertLabelCrop(proxy({...crop,width:500,height:600},pixels),reference,proof,directory),/full native validation label/);
  assert.throws(()=>assertLabelCrop(proxy(crop,pixels,{...reference,operation_id:'other'}),reference,proof,directory),/full native validation label/);
} finally {fs.rmSync(directory,{recursive:true,force:true});}
console.log('Blind visual fixture and nonblank original-associated crop assertions passed.');
