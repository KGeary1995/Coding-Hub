export function difference(before: Buffer, after: Buffer, width: number, height: number, threshold: number) {
 if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 4000000 || before.length !== width * height * 4 || after.length !== before.length) throw new Error('Image dimensions exceed comparison limits.');
 const pixels = Buffer.alloc(before.length); let changedPixels = 0;
 for (let i=0;i<before.length;i+=4) {
  const changed = Math.max(...[0,1,2,3].map((channel) => Math.abs(before[i+channel]-after[i+channel]))) > threshold;
  if (changed) { changedPixels++; pixels[i]=92; pixels[i+1]=100; pixels[i+2]=247; }
  else { const gray = Math.round((after[i]+after[i+1]+after[i+2])/3 * .35); pixels[i]=gray; pixels[i+1]=gray; pixels[i+2]=gray; }
  pixels[i+3]=255;
 }
 return { pixels, changedPixels, totalPixels: width*height };
}
