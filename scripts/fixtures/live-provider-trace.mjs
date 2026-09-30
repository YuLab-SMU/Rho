// Optional wire observation for real-provider failures. Forwards bytes unchanged
// to the supplied HTTPS service; records response text, never request headers/keys.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';

export async function liveProviderTrace(base,report,save){
  const target=new URL(base);assert.equal(target.protocol,'https:');
  const calls=[];report.wire=calls;
  const server=createServer(async(request,response)=>{
    const trace={index:calls.length+1,path:request.url,status:null,message_start_text:'',block_start_text:'',delta_text:'',text:'',events:0};
    calls.push(trace);save();
    try{
      assert.equal(request.method,'POST');assert.equal(request.url,'/v1/messages');
      const parts=[];let bytes=0;for await(const part of request){bytes+=part.length;assert.ok(bytes<=1024*1024);parts.push(part);}
      const input=JSON.parse(Buffer.concat(parts));trace.model=input.model;
      trace.images=(input.messages??[]).flatMap(message=>Array.isArray(message.content)?message.content:[]).filter(item=>item.type==='image').map(item=>{
        assert.equal(item.source?.type,'base64');const pixels=Buffer.from(item.source.data,'base64');
        return {sha256:'sha256:'+createHash('sha256').update(pixels).digest('hex'),bytes:pixels.length,media_type:item.source.media_type};
      });
      const upstream=await fetch(new URL(request.url,target),{method:'POST',headers:{'content-type':'application/json',
        'anthropic-version':request.headers['anthropic-version']??'2023-06-01','x-api-key':request.headers['x-api-key']},
        body:Buffer.concat(parts),signal:AbortSignal.timeout(120000)});
      trace.status=upstream.status;response.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')??'text/event-stream'});
      const decoder=new TextDecoder();let pending='';
      const inspect=()=>{
        let split;while((split=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,split).trimEnd();pending=pending.slice(split+1);if(!line.startsWith('data:'))continue;
          let event;try{event=JSON.parse(line.slice(5));}catch{continue;}trace.events++;
          let text='';
          if(event.type==='message_start'){text=(event.message?.content??[]).filter(item=>item.type==='text').map(item=>item.text).join('');trace.message_start_text+=text;}
          if(event.type==='content_block_start'&&event.content_block?.type==='text'){text=event.content_block.text??'';trace.block_start_text+=text;}
          if(event.type==='content_block_delta'&&event.delta?.type==='text_delta'){text=event.delta.text??'';trace.delta_text+=text;}
          trace.text+=text;
        }
        assert.ok(Buffer.byteLength(pending)<=262144);assert.ok(trace.delta_text.length<=131072);
      };
      for await(const part of upstream.body){response.write(part);pending+=decoder.decode(part,{stream:true});inspect();}
      pending+=decoder.decode();inspect();response.end();save();
    }catch{trace.error='Wire forwarding failed';save();if(!response.headersSent)response.writeHead(502);response.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,
    async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
