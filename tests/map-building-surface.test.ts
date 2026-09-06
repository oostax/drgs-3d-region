import test from 'node:test';
import assert from 'node:assert/strict';
import { createPropertyExpression, latest, type StylePropertySpecification } from '@maplibre/maplibre-gl-style-spec';
import { buildingSurfaceImage, buildingSurfacePattern, registerBuildingSurfaces } from '../src/lib/map-building-surface';

test('continuous building surfaces have valid zoom expressions and bounded shared images',()=>{
  const registered=new Map<string,number>();let writes=0;
  const map={hasImage:(id:string)=>registered.has(id),addImage:(id:string,_image:unknown,options?:{pixelRatio?:number})=>{registered.set(id,options?.pixelRatio??1);writes++;return map;}};
  registerBuildingSurfaces(map as never);registerBuildingSurfaces(map as never);
  assert.equal(writes,352,'images are reused, independent of the number of buildings or camera passes');
  for(const roof of [true,false]) {
    const pattern=buildingSurfacePattern(roof);
    assert.ok(JSON.stringify(pattern).length<7000,'the overview does not duplicate the full architectural classifier');
    const expression=createPropertyExpression(pattern,'fill-extrusion-pattern',latest['paint_fill-extrusion']['fill-extrusion-pattern'] as StylePropertySpecification);
    assert.equal(expression.result,'success',expression.result==='error'?JSON.stringify(expression.value):undefined);
    if(expression.result!=='success')continue;
    for(const zoom of [9.9,10,11.5,12.99,13,14.29,14.3,15.9,16,19.9,20,21]) {
      for(const properties of [{id:'object-a'},{id:'object-b'},{class:'apartments',num_floors:9},{class:'industrial'},
        {facade_color:'#ffffff',roof_color:'red'},{facade_color:'invalid',roof_color:'invalid'}]) {
        const resolved: {name:string;available:boolean}|null=expression.value.evaluate({zoom},{type:'Polygon',properties},{},undefined,[...registered.keys()]);
        assert.ok(resolved?.name&&registered.has(resolved.name),`missing material at zoom ${zoom}`);
        assert.equal(resolved.available,true);
        if(roof)assert.ok(resolved.name.includes('-roof-'),'roofs never use wall windows');
      }
    }
  }
  for(let zoom=10;zoom<=20;zoom++)assert.ok(Math.abs(64/registered.get(`atlas-surface-regular-0-z${zoom}`)!/(2**(zoom-16))-12)<1e-8,'four floor repeat stays 12 m while zoom changes');
});

test('overview materials remain opaque and textured even without the close detail pass',()=>{
  for(const surface of ['regular','wide','plain','roof'] as const) for(let swatch=0;swatch<8;swatch++) {
    const image=buildingSurfaceImage(surface,swatch);
    assert.equal(image,buildingSurfaceImage(surface,swatch));
    assert.equal(image.data.length,64*64*4);
    const shades=new Set<string>();
    for(let i=0;i<image.data.length;i+=4){
      assert.equal(image.data[i+3],255,'base materials do not expose a white fallback');
      assert.ok(Math.max(...image.data.slice(i,i+3))<240);
      shades.add(Array.from(image.data.slice(i,i+3)).join(','));
    }
    assert.ok(shades.size>5,'material includes surface detail');
  }
  assert.notDeepEqual(buildingSurfaceImage('plain').data,buildingSurfaceImage('regular').data,'unclassified uses get joints rather than residential windows');
});
