export interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

// cropAndResize takes an image source URL (e.g. ObjectURL from a File),
// crops the specified pixel area, and re-encodes to JPEG at outputSize×outputSize.
// Used by AvatarCropDialog after react-easy-crop reports pixelCropArea.
//
// The output Blob is the body the client PUTs to S3 in the upload step.
// Sized for 512×512 JPEG ~85% quality → ~50-150 KB.
export async function cropAndResize(
  imageSrc: string,
  pixelCrop: CropArea,
  outputSize: number = 512,
  quality: number = 0.85,
): Promise<Blob> {
  const image = await loadImage(imageSrc);
  const canvas = document.createElement('canvas');
  canvas.width = outputSize;
  canvas.height = outputSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable');
  }
  ctx.drawImage(
    image,
    pixelCrop.x,
    pixelCrop.y,
    pixelCrop.width,
    pixelCrop.height,
    0,
    0,
    outputSize,
    outputSize,
  );
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null'))),
      'image/jpeg',
      quality,
    );
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Image load failed'));
    img.src = src;
  });
}
