"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.imageToJimp = imageToJimp;
// Modified by @dyw1234: Jimp 1.6.1 named API and legacy raw-buffer semantics.
const jimp_1 = require("jimp");
const colormode_enum_1 = require("../enums/colormode.enum");
function imageToJimp(image) {
    // Jimp 1.x aliases raw bitmap data and no longer expands RGB to RGBA.
    // The old constructor copied input buffers (including sliced Buffers).
    const pixels = image.width * image.height;
    let data;
    if (image.data.length === pixels * 4) {
        data = Buffer.from(image.data);
    }
    else if (image.data.length === pixels * 3) {
        data = Buffer.alloc(pixels * 4);
        for (let pixel = 0; pixel < pixels; pixel++) {
            image.data.copy(data, pixel * 4, pixel * 3, pixel * 3 + 3);
            data[pixel * 4 + 3] = 255;
        }
    }
    else {
        throw new Error("Buffer length is incorrect");
    }
    const jimpImage = new jimp_1.Jimp({
        data,
        width: image.width,
        height: image.height
    });
    if (image.colorMode === colormode_enum_1.ColorMode.BGR) {
        // Image treats data in BGR format, so we have to switch red and blue color channels
        jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, (_, __, idx) => {
            const red = jimpImage.bitmap.data[idx];
            jimpImage.bitmap.data[idx] = jimpImage.bitmap.data[idx + 2];
            jimpImage.bitmap.data[idx + 2] = red;
        });
    }
    return jimpImage;
}
//# sourceMappingURL=imageToJimp.function.js.map