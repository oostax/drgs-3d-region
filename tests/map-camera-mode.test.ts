import test from 'node:test';
import assert from 'node:assert/strict';
import {naturalMapPitch,nextMapMode} from '../src/lib/map-camera-mode';

test('camera mode needs one click even when an active 3D camera is top-down',()=>{
  assert.deepEqual(nextMapMode(true,0,11.5),{next3D:false,pitch:0});
  assert.deepEqual(nextMapMode(true,45,11.5),{next3D:false,pitch:0});
  assert.deepEqual(nextMapMode(false,0,14),{next3D:true,pitch:58});
});

test('regional overview stays top-down because 3D has no useful depth there',()=>{
  assert.equal(naturalMapPitch(6.35),0);
});
