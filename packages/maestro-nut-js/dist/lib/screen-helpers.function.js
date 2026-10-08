"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isRegionResultFindInput = isRegionResultFindInput;
exports.isPointResultFindInput = isPointResultFindInput;
exports.isImageMatchRequest = isImageMatchRequest;
exports.isTextMatchRequest = isTextMatchRequest;
exports.isColorMatchRequest = isColorMatchRequest;
exports.createMatchRequest = createMatchRequest;
exports.getMatchResults = getMatchResults;
exports.getMatchResult = getMatchResult;
const shared_1 = require("@nut-tree-fork/shared");
function isRegionResultFindInput(input) {
    return (0, shared_1.isImage)(input) || (0, shared_1.isTextQuery)(input);
}
function isPointResultFindInput(input) {
    return (0, shared_1.isColorQuery)(input);
}
function isImageMatchRequest(matchRequest) {
    return (0, shared_1.isImage)(matchRequest.needle);
}
function isTextMatchRequest(matchRequest) {
    return (0, shared_1.isTextQuery)(matchRequest.needle);
}
function isColorMatchRequest(matchRequest) {
    return (0, shared_1.isColorQuery)(matchRequest.needle);
}
function createMatchRequest(providerRegistry, needle, searchRegion, minMatch, screenImage, params) {
    if ((0, shared_1.isImage)(needle)) {
        providerRegistry
            .getLogProvider()
            .info(`Searching for image ${needle.id} in region ${searchRegion.toString()}.${minMatch != null ? ` Required confidence: ${minMatch}` : ""}`);
        return new shared_1.MatchRequest(screenImage, needle, minMatch, params === null || params === void 0 ? void 0 : params.providerData);
    }
    else if ((0, shared_1.isTextQuery)(needle)) {
        providerRegistry.getLogProvider().info(`Searching for ${(0, shared_1.isLineQuery)(needle) ? "line" : "word"} {
                        ${(0, shared_1.isLineQuery)(needle) ? needle.by.line : needle.by.word}
                    } in region ${searchRegion.toString()}.${minMatch != null
            ? ` Required confidence: ${minMatch}`
            : ""}`);
        return new shared_1.MatchRequest(screenImage, needle, minMatch, params === null || params === void 0 ? void 0 : params.providerData);
    }
    else if ((0, shared_1.isColorQuery)(needle)) {
        const color = needle.by.color;
        providerRegistry
            .getLogProvider()
            .info(`Searching for color RGBA(${color.R},${color.G},${color.B},${color.A}) in region ${searchRegion.toString()}.`);
        return new shared_1.MatchRequest(screenImage, needle, 1, params === null || params === void 0 ? void 0 : params.providerData);
    }
    throw new Error(`Unknown input type: ${JSON.stringify(needle)}`);
}
async function getMatchResults(providerRegistry, matchRequest) {
    if (isImageMatchRequest(matchRequest)) {
        return providerRegistry.getImageFinder().findMatches(matchRequest);
    }
    else if (isTextMatchRequest(matchRequest)) {
        return providerRegistry.getTextFinder().findMatches(matchRequest);
    }
    else if (isColorMatchRequest(matchRequest)) {
        return providerRegistry.getColorFinder().findMatches(matchRequest);
    }
    throw new Error(`Unknown match request type: ${JSON.stringify(matchRequest.needle)}`);
}
async function getMatchResult(providerRegistry, matchRequest) {
    if (isImageMatchRequest(matchRequest)) {
        return providerRegistry.getImageFinder().findMatch(matchRequest);
    }
    else if (isTextMatchRequest(matchRequest)) {
        return providerRegistry.getTextFinder().findMatch(matchRequest);
    }
    else if (isColorMatchRequest(matchRequest)) {
        return providerRegistry.getColorFinder().findMatch(matchRequest);
    }
    throw new Error("Unknown match request type");
}
//# sourceMappingURL=screen-helpers.function.js.map