import { Point, RGBA } from "@nut-tree-fork/shared";
export declare const toHaveColor: (received: Point, needle: RGBA) => Promise<{
    message: () => string;
    pass: boolean;
}>;
