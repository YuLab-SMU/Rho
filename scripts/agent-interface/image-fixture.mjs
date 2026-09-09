import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {digest,exec,json} from './runtime.mjs';

// Bounded decoder for the non-interlaced 8-bit PNGs produced by the fixture and
// native Output views. It inspects evidence bytes; it does not alter images.
export function pngPixels(bytes) {
  assert.ok(bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')),'PNG evidence required');
  let width,height,type,palette,alpha;const chunks=[];
  for(let p=8;p+12<=bytes.length;){const n=bytes.readUInt32BE(p),tag=bytes.toString('ascii',p+4,p+8);assert.ok(p+n+12<=bytes.length,'truncated PNG');const data=bytes.subarray(p+8,p+8+n);p+=n+12;
    if(tag==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);type=data[9];assert.equal(data[8],8,'8-bit PNG required');assert.equal(data[12],0,'non-interlaced PNG required');}
    if(tag==='PLTE')palette=data;if(tag==='tRNS')alpha=data;if(tag==='IDAT')chunks.push(data);if(tag==='IEND')break;
  }
  assert.ok(width>0&&height>0&&width*height<=4*1024*1024,'bounded PNG dimensions required');
  const channels=({0:1,2:3,3:1,4:2,6:4})[type];assert.ok(channels,'unsupported PNG color type');
  const stride=width*channels,raw=inflateSync(Buffer.concat(chunks),{maxOutputLength:(stride+1)*height});assert.equal(raw.length,(stride+1)*height);
  const scan=Buffer.alloc(stride*height),rgba=Buffer.alloc(width*height*4);
  const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
  for(let y=0;y<height;y++){const filter=raw[y*(stride+1)];assert.ok(filter<=4,'invalid PNG filter');for(let x=0;x<stride;x++){const i=y*stride+x,a=x>=channels?scan[i-channels]:0,b=y?scan[i-stride]:0,c=y&&x>=channels?scan[i-stride-channels]:0;scan[i]=(raw[y*(stride+1)+1+x]+[0,a,b,Math.floor((a+b)/2),paeth(a,b,c)][filter])&255;}}
  for(let i=0;i<width*height;i++){const s=i*channels,d=i*4;if(type===3){const index=scan[s];assert.ok(palette&&index*3+2<palette.length,'invalid PNG palette');rgba[d]=palette[index*3];rgba[d+1]=palette[index*3+1];rgba[d+2]=palette[index*3+2];rgba[d+3]=alpha?.[index]??255;}else {rgba[d]=scan[s];rgba[d+1]=type===0||type===4?scan[s]:scan[s+1];rgba[d+2]=type===0||type===4?scan[s]:scan[s+2];rgba[d+3]=type===4?scan[s+1]:type===6?scan[s+3]:255;}}
  return {width,height,rgba};
}

export function labelInk(pixels,region={x:.77,y:.18,width:.17,height:.12},interior=true) {
  const area={x:Math.floor(region.x*pixels.width),y:Math.floor(region.y*pixels.height),width:Math.ceil(region.width*pixels.width),height:Math.ceil(region.height*pixels.height)};
  let left=Infinity,top=Infinity,right=-1,bottom=-1,count=0;
  for(let y=Math.max(0,area.y);y<Math.min(pixels.height,area.y+area.height);y++)for(let x=Math.max(0,area.x);x<Math.min(pixels.width,area.x+area.width);x++){const p=(y*pixels.width+x)*4;if(pixels.rgba[p+3]>127&&Math.max(...pixels.rgba.subarray(p,p+3))<180){count++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}}
  assert.ok(count>=60&&right-left>=60&&bottom-top>=5&&bottom-top<=30,'validation label must actually be visible as nonblank text in its private image region');
  if(interior)assert.ok(left>area.x&&right<area.x+area.width-1&&top>area.y&&bottom<area.y+area.height-1,'validation label must not be clipped by its private region');
  return {x:left,y:top,width:right-left+1,height:bottom-top+1,ink_pixels:count};
}

export function prepareImageFixture(options,directory,evidence,label) {
  const privateDirectory=path.join(directory,'private-visual');fs.mkdirSync(privateDirectory,{mode:0o700});
  const recorded=path.join(privateDirectory,'figure.rds'),png=path.join(evidence,'private-figure.png');
  const code=`png(${JSON.stringify(png)},width=800,height=600); dev.control(displaylist='enable'); par(mfrow=c(1,2),ps=12); plot(1:5,c(1,8,4,2,1),type='o',col='blue',pch=16,ylim=c(0,10),xlab='Visit',ylab='Response',main='Blue and red groups'); lines(1:5,c(1,2,3,9,5),type='o',col='red',pch=17); plot(1:10,10:1,pch=16,main='Validation panel',xlab='Visit',ylab='Score'); graphics::text(7.8,8.8,${JSON.stringify(label)},cex=.75); saveRDS(recordPlot(),${JSON.stringify(recorded)}); dev.off()`;
  exec(path.join(options.rHome,'bin','Rscript'),['--vanilla','-e',code]);
  fs.copyFileSync(recorded,path.join(evidence,'private-recorded-plot.rds'));
  const bytes=fs.readFileSync(png),pixels=pngPixels(bytes),roi=labelInk(pixels);
  json(path.join(evidence,'private-figure-proof.json'),{png_sha256:digest(bytes),recorded_plot_sha256:digest(fs.readFileSync(recorded)),width:pixels.width,height:pixels.height,label_roi:roi});
  return {recorded,roi};
}

export async function verifyNativeFigure(host,reference,evidence) {
  const snapshot=await host.query('output.view',{reference,max_edge:1600});assert.equal(snapshot.status,'ready');
  const data=snapshot.data,bytes=Buffer.from(data.preview_base64,'base64');assert.equal(digest(bytes),data.preview_sha256);
  const pixels=pngPixels(bytes),roi=labelInk(pixels);assert.equal(pixels.width,data.original_width);assert.equal(pixels.height,data.original_height);
  fs.writeFileSync(path.join(evidence,'native-figure.png'),bytes,{mode:0o600});
  const proof={reference,preview_sha256:data.preview_sha256,width:pixels.width,height:pixels.height,label_roi:roi};json(path.join(evidence,'native-figure-proof.json'),proof);return proof;
}

export function assertLabelCrop(proxy,reference,proof,evidence) {
  let found=false;
  for(const response of proxy.responses){if(!['rho.output.view','rho.output.view.v1'].includes(response.call.rpc?.params?.name)||response.result?.isError)continue;
    const data=response.result?.structuredContent?.result?.data,crop=response.call.rpc.params.arguments.crop;
    if(!data||!crop||data.reference.operation_id!==reference.operation_id||data.reference.sequence!==reference.sequence)continue;
    assert.deepEqual(data.reference,reference);
    const roi=proof.label_roi;
    if(crop.x>roi.x||crop.y>roi.y||crop.x+crop.width<roi.x+roi.width||crop.y+crop.height<roi.y+roi.height||crop.width*crop.height>proof.width*proof.height/2)continue;
    const image=proxy.images.find(image=>image.sequence===response.call.sequence&&!image.resource);assert.ok(image,'crop must be native ImageContent');
    const bytes=fs.readFileSync(path.join(evidence,image.file));assert.equal(digest(bytes),data.preview_sha256);
    const pixels=pngPixels(bytes),sx=pixels.width/crop.width,sy=pixels.height/crop.height;
    const ink=labelInk(pixels,{x:(roi.x-crop.x-2)/crop.width,y:(roi.y-crop.y-2)/crop.height,width:(roi.width+4)/crop.width,height:(roi.height+4)/crop.height},false);
    assert.ok(sx>=1&&sy>=1,'detail crop must preserve at least the original label resolution');
    found=true;json(path.join(evidence,'consumed-label-crop-proof.json'),{reference,original_label_roi:roi,crop,preview_sha256:data.preview_sha256,preview_label_roi:ink});
  }
  assert.ok(found,'Agent must consume a nonblank detail crop containing the full native validation label');
}
