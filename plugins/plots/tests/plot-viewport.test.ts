import { expect, it } from "vitest";
import { fitScale, constrain, zoomAt } from "../src/plot-viewport.js";
it("fits both original dimensions with a visible canvas margin", () => {
  expect(fitScale({ width: 1000, height: 400 }, { width: 532, height: 432 })).toBe(.5);
  expect(fitScale({ width: 400, height: 1000 }, { width: 532, height: 432 })).toBe(.4);
});
it("preserves the cursor's original point when zooming before clamping", () => {
  const image={width:1000,height:1000},canvas={width:500,height:500};
  const result=zoomAt({zoom:1,x:0,y:0},2,{x:100,y:-80},image,canvas);
  expect(result).toEqual({zoom:2,x:-100,y:80});
});
it("bounds zoom and pan without changing the original dimensions", () => {
  const image={width:1000,height:400},canvas={width:500,height:300};
  expect(zoomAt({zoom:1,x:0,y:0},100,{x:0,y:0},image,canvas).zoom).toBe(8);
  expect(zoomAt({zoom:1,x:0,y:0},.001,{x:0,y:0},image,canvas).zoom).toBe(.01);
  expect(constrain({zoom:1,x:1000,y:-1000},image,canvas)).toEqual({zoom:1,x:266,y:-66});
  expect(constrain({zoom:null,x:1000,y:-1000},image,canvas)).toEqual({zoom:null,x:0,y:0});
  expect(image).toEqual({width:1000,height:400});
});
