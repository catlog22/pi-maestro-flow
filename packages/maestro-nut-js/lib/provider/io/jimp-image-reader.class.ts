// Modified by @dyw1234: Jimp 1.6.1 named read API.
import { Jimp } from "jimp";
import { ImageReader } from "@nut-tree-fork/provider-interfaces";
import { ColorMode, Image } from "@nut-tree-fork/shared";

export default class implements ImageReader {
  load(parameters: string): Promise<Image> {
    return new Promise<Image>((resolve, reject) => {
      Jimp.read(parameters)
        .then((jimpImage) => {
          // stay consistent with images retrieved from libnut which uses BGR format
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
          resolve(
            new Image(
              jimpImage.bitmap.width,
              jimpImage.bitmap.height,
              jimpImage.bitmap.data,
              4,
              parameters,
              jimpImage.bitmap.data.length /
              (jimpImage.bitmap.width * jimpImage.bitmap.height),
              jimpImage.bitmap.data.length / jimpImage.bitmap.height,
              ColorMode.BGR
            )
          );
        })
        .catch((err) =>
          reject(`Failed to load image from '${parameters}'. Reason: ${err}`)
        );
    });
  }
}
