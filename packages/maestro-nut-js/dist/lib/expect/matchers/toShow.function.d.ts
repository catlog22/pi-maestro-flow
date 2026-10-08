import { ScreenClass } from "../../screen.class";
import { FindInput, OptionalSearchParameters, Region } from "@nut-tree-fork/shared";
export declare const toShow: <PROVIDER_DATA>(received: ScreenClass | Region, needle: FindInput, parameters?: OptionalSearchParameters<PROVIDER_DATA>) => Promise<{
    message: () => string;
    pass: boolean;
}>;
