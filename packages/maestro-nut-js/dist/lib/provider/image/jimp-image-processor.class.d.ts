import { Image, Point, RGBA } from "@nut-tree-fork/shared";
import { ImageProcessor } from "@nut-tree-fork/provider-interfaces";
export default class implements ImageProcessor {
    colorAt(image: Image | Promise<Image>, point: Point | Promise<Point>): Promise<RGBA>;
}
