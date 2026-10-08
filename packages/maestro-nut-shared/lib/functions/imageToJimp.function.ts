// Modified by @dyw1234: Jimp 1.6.1 named API and legacy raw-buffer semantics.
import { Jimp } from "jimp";
import { ColorMode } from "../enums/colormode.enum";
import { Image } from "../objects/image.class";

export function imageToJimp(image: Image): InstanceType<typeof Jimp> {
  // Jimp 1.x aliases raw bitmap data and no longer expands RGB to RGBA.
  // The old constructor copied input buffers (including sliced Buffers).
  const pixels = image.width * image.height;
  let data: Buffer;
  if (image.data.length === pixels * 4) {
    data = Buffer.from(image.data);
  } else if (image.data.length === pixels * 3) {
    data = Buffer.alloc(pixels * 4);
    for (let pixel = 0; pixel < pixels; pixel++) {
      image.data.copy(data, pixel * 4, pixel * 3, pixel * 3 + 3);
      data[pixel * 4 + 3] = 255;
    }
  } else {
    throw new Error("Buffer length is incorrect");
  }
  const jimpImage = new Jimp({
    data,
    width: image.width,
    height: image.height
  });
  if (image.colorMode === ColorMode.BGR) {
    // Image treats data in BGR format, so we have to switch red and blue color channels
    jimpImage.scan(
      0,
      0,
      jimpImage.bitmap.width,
      jimpImage.bitmap.height,
      (_, __, idx) => {
        const red = jimpImage.bitmap.data[idx];
        jimpImage.bitmap.data[idx] = jimpImage.bitmap.data[idx + 2];
        jimpImage.bitmap.data[idx + 2] = red;
      }
    );
  }
  return jimpImage;
}
