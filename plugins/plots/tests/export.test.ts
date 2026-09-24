import {expect,it,vi} from 'vitest';
import {PlotsExport} from '../src/export.js';
import type {SavedPlot} from '../src/outputs.js';
const plot={native:{sequence:3},reference:{owner:{instance:'r-one',plugin:'r',revision:'original-revision',artifact:'original-artifact'},resource:'original',digest:'sha256:'+'a'.repeat(64),bytes:100,media_type:'image/png'}} as SavedPlot;
it('captures the original immediately and acknowledges only a browser download request',async()=>{
 let finish!:()=>void;const downloadResource=vi.fn(()=>new Promise<void>(resolve=>finish=resolve)),find=vi.fn(()=>structuredClone(plot) as SavedPlot|undefined),model=new PlotsExport({downloadResource},find);
 const pending=model.original(plot.native);expect(downloadResource).toHaveBeenCalledWith(plot.reference,'plot-3.png');find.mockReturnValue(undefined);
 await expect(model.original(plot.native)).rejects.toThrow('current original');expect(model.getSnapshot()).toMatchObject({busy:true,notice:''});
 finish();await pending;expect(model.getSnapshot()).toEqual({busy:false,notice:'Original download requested.',error:''});expect(downloadResource).toHaveBeenCalledOnce();model.stop();
});
it('rejects missing originals without calling a port and keeps download failures visible for an explicit retry',async()=>{
 const downloadResource=vi.fn(async()=>{}).mockRejectedValueOnce(new Error('Original checksum failed')),find=vi.fn(()=>undefined as SavedPlot|undefined),model=new PlotsExport({downloadResource},find);
 await expect(model.original(plot.native)).rejects.toThrow('observed original');expect(downloadResource).not.toHaveBeenCalled();
 find.mockReturnValue(plot);await expect(model.original(plot.native)).rejects.toThrow('checksum');expect(model.getSnapshot()).toMatchObject({busy:false,error:'Original checksum failed',notice:''});
 await model.original(plot.native);expect(downloadResource).toHaveBeenCalledTimes(2);model.stop();
});
it('preserves SVG bytes as SVG and does not turn a late response after disposal into success',async()=>{
 const svg={...plot,reference:{...plot.reference,media_type:'image/svg+xml'}};let finish!:()=>void;
 const downloadResource=vi.fn(()=>new Promise<void>(resolve=>finish=resolve)),model=new PlotsExport({downloadResource},()=>svg);
 const pending=model.original(plot.native);expect(downloadResource).toHaveBeenCalledWith(svg.reference,'plot-3.svg');model.stop();finish();await pending;
 expect(model.getSnapshot().notice).toBe('');await expect(model.original(plot.native)).rejects.toThrow('closed');expect(downloadResource).toHaveBeenCalledOnce();
});
