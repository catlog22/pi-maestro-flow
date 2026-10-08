import { ImageReader } from "@nut-tree-fork/provider-interfaces";
import { Image } from "@nut-tree-fork/shared";
export default class implements ImageReader {
    load(parameters: string): Promise<Image>;
}
