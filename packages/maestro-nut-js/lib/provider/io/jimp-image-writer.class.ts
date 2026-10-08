// Modified by @dyw1234: Jimp 1.6.1 async write API (legacy Promise<void> preserved).
import { ImageWriter, ImageWriterParameters } from "@nut-tree-fork/provider-interfaces";
import { imageToJimp } from "@nut-tree-fork/shared";

export default class implements ImageWriter {
  store(parameters: ImageWriterParameters): Promise<void> {
    return new Promise((resolve, reject) => {
      const jimpImage = imageToJimp(parameters.image);
      jimpImage
        .write(parameters.path as `${string}.${string}`)
        .then((_) => resolve())
        .catch((err) => reject(err));
    });
  }
}
