export function readStableReference<T>(read: () => T): T | undefined {
	// pi 0.84's TUI Proxy creates a dispatch closure on every function read.
	const value = read();
	return value === read() ? value : undefined;
}
