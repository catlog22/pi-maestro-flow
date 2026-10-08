import { ColorFinderInterface } from "@nut-tree-fork/provider-interfaces";
import { ColorQuery, MatchRequest, MatchResult, Point } from "@nut-tree-fork/shared";
export default class implements ColorFinderInterface {
    findMatch<PROVIDER_DATA_TYPE>(query: MatchRequest<ColorQuery, PROVIDER_DATA_TYPE>): Promise<MatchResult<Point>>;
    findMatches<PROVIDER_DATA_TYPE>(query: MatchRequest<ColorQuery, PROVIDER_DATA_TYPE>): Promise<MatchResult<Point>[]>;
}
