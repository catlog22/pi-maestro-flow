import { WindowElement, WindowElementDescription } from "@nut-tree-fork/shared";
/**
 * An ElementInspectionProvider provides methods to list and inspect window elements
 */
export interface ElementInspectionProviderInterface {
    getElements(windowHandle: number, maxElements?: number): Promise<WindowElement>;
    findElement(windowHandle: number, description: WindowElementDescription): Promise<WindowElement>;
    findElements(windowHandle: number, description: WindowElementDescription): Promise<WindowElement[]>;
}
