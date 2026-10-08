"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Modified by @dyw1234: Jimp 1.6.1 named read API.
const jimp_1 = require("jimp");
const shared_1 = require("@nut-tree-fork/shared");
class default_1 {
    load(parameters) {
        return new Promise((resolve, reject) => {
            jimp_1.Jimp.read(parameters)
                .then((jimpImage) => {
                // stay consistent with images retrieved from libnut which uses BGR format
                jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, (_, __, idx) => {
                    const red = jimpImage.bitmap.data[idx];
                    jimpImage.bitmap.data[idx] = jimpImage.bitmap.data[idx + 2];
                    jimpImage.bitmap.data[idx + 2] = red;
                });
                resolve(new shared_1.Image(jimpImage.bitmap.width, jimpImage.bitmap.height, jimpImage.bitmap.data, 4, parameters, jimpImage.bitmap.data.length /
                    (jimpImage.bitmap.width * jimpImage.bitmap.height), jimpImage.bitmap.data.length / jimpImage.bitmap.height, shared_1.ColorMode.BGR));
            })
                .catch((err) => reject(`Failed to load image from '${parameters}'. Reason: ${err}`));
        });
    }
}
exports.default = default_1;
//# sourceMappingURL=jimp-image-reader.class.js.map