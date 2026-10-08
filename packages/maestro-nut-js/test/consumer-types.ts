import { Image, ColorMode, Point, RGBA, imageToJimp, loadImage, saveImage, fetchFromUrl, providerRegistry, keyboard, mouse, clipboard } from '@nut-tree-fork/nut-js';
import { Image as SharedImage, imageToJimp as sharedImageToJimp } from '@nut-tree-fork/shared';
import type { ImageReader, ImageWriter, ImageProcessor, KeyboardProviderInterface, MouseProviderInterface, ClipboardProviderInterface } from '@nut-tree-fork/provider-interfaces';
import { Jimp } from 'jimp';
const image: SharedImage = new Image(1, 1, Buffer.from([1, 2, 3, 255]), 4, 'types', 4, 4, ColorMode.RGB);
const jimp: InstanceType<typeof Jimp> = imageToJimp(image);
const sharedJimp: InstanceType<typeof Jimp> = sharedImageToJimp(image);
const reader: ImageReader = providerRegistry.getImageReader();
const writer: ImageWriter = providerRegistry.getImageWriter();
const processor: ImageProcessor = providerRegistry.getImageProcessor();
const keyboardProvider: KeyboardProviderInterface = providerRegistry.getKeyboard();
const mouseProvider: MouseProviderInterface = providerRegistry.getMouse();
const clipboardProvider: ClipboardProviderInterface = providerRegistry.getClipboard();
const read: Promise<Image> = loadImage('fixture.png');
const write: Promise<void> = saveImage({ image, path: 'fixture.png' });
const remote: Promise<Image> = fetchFromUrl('http://127.0.0.1/fixture.png');
const color: Promise<RGBA> = processor.colorAt(image, new Point(0, 0));
const convert: Promise<Image> = image.toRGB();
const buffer: Promise<Buffer> = jimp.getBuffer('image/png');
void [sharedJimp, reader, writer, keyboardProvider, mouseProvider, clipboardProvider, read, write, remote, color, convert, buffer, keyboard, mouse, clipboard];
// @ts-expect-error public writer still requires an Image rather than raw bytes
saveImage({ image: Buffer.alloc(4), path: 'fixture.png' });
// @ts-expect-error imageToJimp remains a typed synchronous image conversion
imageToJimp('fixture.png');
