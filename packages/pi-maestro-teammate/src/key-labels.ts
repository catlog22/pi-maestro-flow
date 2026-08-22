import { platform } from "node:os";

// Display only: the key-matching token stays "alt" on every platform.
export function altLabel(): string {
	return platform() === "darwin" ? "Option" : "Alt";
}

export function altKey(letter: string): string {
	return `${altLabel()}+${letter}`;
}
