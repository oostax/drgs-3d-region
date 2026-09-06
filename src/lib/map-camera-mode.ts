export function naturalMapPitch(zoom:number):number {
  return zoom>=13?58:zoom>=10?45:0;
}

/** The visible camera decides the toggle direction. This also repairs a stale
 * React 3D flag when the map is still top-down after its initial overview. */
export function nextMapMode(is3D:boolean,pitch:number,zoom:number){
  const currentlyPitched=is3D&&pitch>5;
  const next3D=!currentlyPitched;
  return {next3D,pitch:next3D?naturalMapPitch(zoom):0};
}
